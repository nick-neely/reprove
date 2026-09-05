/**
 * One person, a personal account and an organization: two Owners, and nothing
 * in the schema that could disagree.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md):
 *
 * > `owner` has **no foreign key to any user**. That is what makes #2's test
 * > pass structurally rather than by care: one person installing on a personal
 * > account and on an organization is two `owner` rows, and nothing in the
 * > schema fights that because nothing joins the two concepts at all.
 *
 * Two halves, because "structurally rather than by care" is a claim about the
 * schema and "two rows" is a claim about the database, and neither implies the
 * other. The first half needs no database and is the one that would fail on the
 * pull request adding a membership relation; the second shows the arrangement
 * actually persists.
 *
 * Reprove adds **no** User table and no User-to-Owner membership relation:
 * authorization from a User to a Repository is live GitHub state, not a Reprove
 * row.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import {
  NON_TENANT_TABLES,
  tableName,
  TENANT_TABLES,
} from "./classification.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  createTestDatabase,
  onRuntimeConnection,
  RUNTIME_PASSWORD,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import type { RuntimeDb } from "./runtime.js";
import { createRuntimeDb } from "./runtime.js";
import * as schema from "./schema.js";

const DATABASE = "reprove_test_owner_independence";

/** One GitHub person, and the two Owners they can reach. */
const PERSON_LOGIN = "octocat";
/** GitHub's numeric id for the person's own account, which is also an Owner. */
const PERSONAL_OWNER = 4242;
/** And for an organization they installed the App on. Unrelated by construction. */
const ORGANIZATION_OWNER = 9001;

/** The user id Better Auth would have minted. Its shape is not a tenant key. */
const USER_ID = "user_2abcdefghijklmnop";

let database: TestDatabase;
let runtime: RuntimeDb;

/** Every foreign key a table declares, as `from -> to`. */
const referencesFrom = (
  table: Parameters<typeof getTableConfig>[0]
): { to: string; label: string }[] =>
  getTableConfig(table).foreignKeys.map((key) => {
    const { foreignTable } = key.reference();
    return {
      to: tableName(foreignTable),
      label: `${tableName(table)} -> ${tableName(foreignTable)}`,
    };
  });

describe("the schema joining Owners to Users", () => {
  it("declares no foreign key from a Better Auth table to a tenant table", () => {
    const tenant = new Set(TENANT_TABLES.map(tableName));
    const crossing = NON_TENANT_TABLES.flatMap(referencesFrom)
      .filter((reference) => tenant.has(reference.to))
      .map((reference) => reference.label);

    expect(crossing).toStrictEqual([]);
  });

  it("declares no foreign key from a tenant table to a Better Auth table", () => {
    // The other direction, and the one an `owner.user_id` would land in. Both
    // are asserted because a membership relation is equally wrong whichever end
    // it is hung from.
    const auth = new Set(NON_TENANT_TABLES.map(tableName));
    const crossing = TENANT_TABLES.flatMap(referencesFrom)
      .filter((reference) => auth.has(reference.to))
      .map((reference) => reference.label);

    expect(crossing).toStrictEqual([]);
  });

  it("gives owner no column that could name a user", () => {
    // Not only a foreign key: an unconstrained `owner.user_id` would model the
    // same wrong relationship and pass both assertions above.
    const columns = getTableConfig(schema.owner).columns.map(
      (column) => column.name
    );

    expect(columns).toStrictEqual(["id", "login", "type"]);
  });
});

describe("one person reaching two Owners", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  it("stores the User outside any Owner context, and both Owners inside their own", async () => {
    // The User is written with no tenant context at all, which is only possible
    // because the Better Auth tables carry no Owner policy. There is no
    // `withoutOwner` on the shipped client, so this reaches for the same plain
    // runtime connection the other measurements use.
    await onRuntimeConnection(DATABASE, async (client) => {
      await client.query(
        `insert into "user" (id, name, email) values ($1, $2, $3)`,
        [USER_ID, "Mona Octocat", "octocat@example.com"]
      );
      await client.query(
        `insert into "account" (id, user_id, provider_id, issuer, account_id)
           values ($1, $2, 'github', 'https://github.com', $3)`,
        ["account_1", USER_ID, String(PERSONAL_OWNER)]
      );
    });

    // Two Owners for one person: the personal account and the organization. The
    // second insert needs nothing from the first - no membership row, no
    // lookup, no link - which is the property.
    await runtime.withOwner(PERSONAL_OWNER, (tx) =>
      tx
        .insert(schema.owner)
        .values({ id: PERSONAL_OWNER, login: PERSON_LOGIN, type: "user" })
    );
    await runtime.withOwner(ORGANIZATION_OWNER, (tx) =>
      tx.insert(schema.owner).values({
        id: ORGANIZATION_OWNER,
        login: "acme",
        type: "organization",
      })
    );

    const owners = await onRuntimeConnection(DATABASE, async (client) => {
      // As the admin would see them: no tenant context, so RLS denies every
      // row. Counted through the admin connection instead, which is the only
      // vantage point from which "two rows" is a statement about the table
      // rather than about one tenant.
      const { rows } = await client.query<{ blocked: string }>(
        `select count(*)::text as blocked from "owner"`
      );
      return rows[0]?.blocked;
    });
    expect(owners).toBe("0");

    const stored = await database.admin<{ id: string; type: string }>(
      `select id::text as id, type from "owner" order by id`
    );
    expect(stored).toStrictEqual([
      { id: String(PERSONAL_OWNER), type: "user" },
      { id: String(ORGANIZATION_OWNER), type: "organization" },
    ]);
  });

  it("keeps each Owner's rows invisible to the other", async () => {
    const seen = await runtime.withOwner(PERSONAL_OWNER, (tx) =>
      tx.select().from(schema.owner)
    );

    // The organization is not "the same person's other tenant" as far as the
    // boundary is concerned. It is another tenant, full stop.
    expect(seen.map((row) => row.id)).toStrictEqual([PERSONAL_OWNER]);
  });
});
