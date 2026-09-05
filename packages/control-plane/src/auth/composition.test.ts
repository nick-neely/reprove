/**
 * Better Auth, driven through its own HTTP handler against the real adopted
 * tables, with GitHub replaced at `fetch` and nothing else replaced.
 *
 * This is the file that turns [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s
 * Better Auth seam from a configuration claim into a measured one. A test that
 * only read `auth.options` would prove the object literal, not that Better Auth
 * writes to `user` and `account` in Reprove's migration history, not that the
 * stored access token is ciphertext, and not that a misconfigured GitHub App
 * fails the sign-in.
 *
 * It needs the local stack for the same reason the tenancy tests do, and fails
 * with instructions rather than skipping when it is down.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "../db/bootstrap.js";
import type { TestDatabase } from "../db/local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "../db/local-stack.test-support.js";
import { migrate } from "../db/migrate.js";
import * as schema from "../db/schema.js";
import type { Auth } from "./auth.js";
import { createAuth } from "./auth.js";
import type {
  GitHubPerson,
  GitHubTokenResponse,
} from "./github.test-support.js";
import {
  ACCESS_TOKEN,
  EXPIRING_GRANT,
  NEWCOMER,
  NO_REFRESH_GRANT,
  NON_EXPIRING_GRANT,
  PERSON,
  REFRESH_TOKEN,
  stubGitHub,
} from "./github.test-support.js";

const DATABASE = "reprove_test_auth_composition";
const BASE_URL = "http://127.0.0.1:3000";
const SECRET = "composition-test-secret-not-a-real-one";

let database: TestDatabase;
let pool: Pool;
let auth: Auth;
let db: ReturnType<typeof drizzle<typeof schema>>;

/**
 * One full OAuth round trip: the sign-in that mints the state, then the
 * callback GitHub would redirect to, carrying the cookies the first response
 * set.
 *
 * @param grant The token response GitHub should answer the code exchange with.
 * @param person The GitHub person the profile endpoints should report.
 * @returns The callback's response.
 */
const signInThroughGitHub = async (
  grant: GitHubTokenResponse,
  person: GitHubPerson = PERSON
): Promise<Response> => {
  const restore = stubGitHub(grant, person);
  try {
    const started = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      })
    );
    // SAFETY: `/sign-in/social` answers with `{ url, redirect }`, and the
    // assertion below fails loudly if the field is not there.
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    expect(state).toBeTruthy();

    const cookies = started.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    return await auth.handler(
      new Request(
        `${BASE_URL}/api/auth/callback/github?state=${encodeURIComponent(state ?? "")}&code=github-authorization-code`,
        { method: "GET", headers: { cookie: cookies } }
      )
    );
  } finally {
    restore();
  }
};

describe("Better Auth composed over Reprove's adopted tables", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });

    // The runtime connection, which is what application traffic uses. These
    // four tables carry no Owner policy, so no tenant transaction wraps them -
    // that is the whole of what "outside Owner RLS" means in practice.
    pool = new Pool({ connectionString: database.runtimeUrl, max: 4 });
    db = drizzle(pool, { schema });
    auth = createAuth({
      database: db,
      secret: SECRET,
      baseURL: BASE_URL,
      github: { clientId: "Iv1.test", clientSecret: "github-client-secret" },
    });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  it("writes the User into Reprove's own table", async () => {
    const response = await signInThroughGitHub(EXPIRING_GRANT);
    expect(response.status).toBeLessThan(400);

    const users = await db.select().from(schema.user);
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(PERSON.email);
  });

  it("writes the Account beside it, carrying GitHub's own identity", async () => {
    const [stored] = await db.select().from(schema.account);
    const [owner] = await db.select().from(schema.user);

    expect(stored?.providerId).toBe("github");
    expect(stored?.accountId).toBe(String(PERSON.id));
    expect(stored?.userId).toBe(owner?.id);
  });

  it("stores the OAuth tokens as ciphertext rather than plaintext", async () => {
    const [stored] = await db.select().from(schema.account);

    // `not.toContain` rather than `not.toBe`: ciphertext that happened to carry
    // the plaintext alongside it would satisfy inequality and still be a leak.
    expect(stored?.accessToken).toBeTruthy();
    expect(stored?.accessToken).not.toContain(ACCESS_TOKEN);
    expect(stored?.refreshToken).toBeTruthy();
    expect(stored?.refreshToken).not.toContain(REFRESH_TOKEN);
  });

  it("records the access token's expiry, which is what makes it refreshable", async () => {
    const [stored] = await db.select().from(schema.account);

    expect(stored?.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(stored?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  // The two grants a GitHub App with "Expire user authorization tokens"
  // switched off can produce, and the condition each one breaks. Nothing about
  // either response is malformed as OAuth: Better Auth would store the
  // credential and report success.
  const REFUSED: [string, GitHubTokenResponse][] = [
    ["carries no expiry and no refresh token", NON_EXPIRING_GRANT],
    ["expires but carries no refresh token", NO_REFRESH_GRANT],
  ];

  describe.each(REFUSED)("a grant that %s", (_condition, grant) => {
    it("cannot overwrite the row a repeat sign-in would update", async () => {
      // The returning person, which is the case a database hook on `account`
      // would miss: Better Auth filters `undefined` out of the update it
      // writes, so the absent `accessTokenExpiresAt` that *is* the condition
      // would never reach one and the row would silently keep an expiry that no
      // longer describes the token beside it.
      const [before] = await db.select().from(schema.account);
      expect(before).toBeDefined();

      const response = await signInThroughGitHub(grant);
      expect(response.status).toBe(500);

      // Not a row count: the refusal has to leave the stored grant exactly as
      // it was, and a count cannot tell an untouched row from an overwritten
      // one.
      const [after] = await db.select().from(schema.account);
      expect(after).toStrictEqual(before);
    });

    it("cannot create a row on a first sign-in either", async () => {
      // The other write, and the other person: a newcomer's grant lands on an
      // `account` insert preceded by a `user` insert, so "nothing was written"
      // is a claim about two tables.
      const users = await db.select().from(schema.user);
      const accounts = await db.select().from(schema.account);

      const response = await signInThroughGitHub(grant, NEWCOMER);
      expect(response.status).toBe(500);

      await expect(db.select().from(schema.user)).resolves.toStrictEqual(users);
      await expect(db.select().from(schema.account)).resolves.toStrictEqual(
        accounts
      );
    });
  });
});
