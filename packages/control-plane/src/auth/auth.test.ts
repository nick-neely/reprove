/**
 * What `createAuth()` composed, at the two seams the composition test cannot
 * reach: the configuration it refuses, and the **refresh** half of ADR 0008's
 * token-grant requirement.
 *
 * `composition.test.ts` drives a whole sign-in and is the stronger proof, but a
 * refresh needs GitHub to answer a refresh token that Reprove already holds,
 * which is a second round trip past the point that file measures. The provider
 * option is called directly here instead, which is the same function Better
 * Auth calls and none of the plumbing between.
 *
 * No database: nothing below reaches the adapter.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { SuppliedField } from "../db/config.js";
import * as schema from "../db/schema.js";
import type { AuthConfig } from "./auth.js";
import { createAuth } from "./auth.js";
import {
  ACCESS_TOKEN,
  EXPIRING_GRANT,
  NO_REFRESH_GRANT,
  NON_EXPIRING_GRANT,
  REFRESH_TOKEN,
  stubGitHub,
} from "./github.test-support.js";

/** Never dialled. Nothing in this file opens a connection. */
const UNREACHABLE = "postgres://nobody@127.0.0.1:1/nowhere";

const database = drizzle(new Pool({ connectionString: UNREACHABLE }), {
  schema,
});

const config: AuthConfig = {
  database,
  secret: "auth-test-secret",
  baseURL: "http://127.0.0.1:3000",
  github: { clientId: "Iv1.test", clientSecret: "github-client-secret" },
};

/** The three shapes a caller produces without meaning to. */
const UNUSABLE: [string, SuppliedField][] = [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
];

/**
 * The field in the type the signature declares, which is the mismatch these
 * guards exist for: the package ships as JavaScript, so nothing enforces it at
 * the boundary.
 */
const supplied = (value: SuppliedField): string =>
  // SAFETY: deliberately unsound. The signature says these fields are strings
  // and the package ships as JavaScript, so nothing enforces that at the
  // boundary - which is exactly what the guards under test are for.
  value as string;

/**
 * The GitHub provider options `createAuth()` actually installed, with both
 * asserted seams narrowed to functions.
 *
 * Narrowed here rather than reached for with `?.` at each call: both are
 * optional on `GithubOptions`, and a seam that stopped being installed would
 * otherwise turn every measurement below into an assertion about `undefined`
 * rather than a failure naming the thing that went missing.
 */
const githubProvider = () => {
  const provider = createAuth(config).options.socialProviders?.github;
  if (!provider) {
    throw new Error("createAuth() installed no GitHub provider");
  }
  const { getUserInfo, refreshAccessToken } = provider;
  if (!getUserInfo || !refreshAccessToken) {
    throw new Error(
      "createAuth() left the GitHub provider without both asserted seams"
    );
  }
  return { getUserInfo, refreshAccessToken };
};

describe("createAuth() handed a field it cannot use", () => {
  it.each(UNUSABLE)("refuses a %s secret", (_label, value) => {
    expect(() => createAuth({ ...config, secret: supplied(value) })).toThrow(
      /AuthConfig\.secret/u
    );
  });

  it.each(UNUSABLE)("refuses a %s base URL", (_label, value) => {
    expect(() => createAuth({ ...config, baseURL: supplied(value) })).toThrow(
      /AuthConfig\.baseURL/u
    );
  });

  it.each(UNUSABLE)("refuses a %s GitHub client id", (_label, value) => {
    expect(() =>
      createAuth({
        ...config,
        github: { ...config.github, clientId: supplied(value) },
      })
    ).toThrow(/AuthConfig\.github\.clientId/u);
  });

  it.each(UNUSABLE)("refuses a %s GitHub client secret", (_label, value) => {
    expect(() =>
      createAuth({
        ...config,
        github: { ...config.github, clientSecret: supplied(value) },
      })
    ).toThrow(/AuthConfig\.github\.clientSecret/u);
  });
});

describe("the composed instance", () => {
  it("encrypts OAuth tokens at rest rather than storing them in plaintext", () => {
    // Better Auth's default is plaintext, so this is the difference between a
    // stolen dump being a list of GitHub credentials and being ciphertext.
    // `composition.test.ts` proves the column actually holds ciphertext; this
    // states the decision where a reader will look for it.
    expect(createAuth(config).options.account?.encryptOAuthTokens).toBeTruthy();
  });

  it("resolves nothing from the environment", () => {
    const { options } = createAuth(config);

    expect(options.secret).toBe(config.secret);
    expect(options.baseURL).toBe(config.baseURL);
    expect(options.telemetry?.enabled).toBeFalsy();
  });
});

describe("the GitHub seam", () => {
  it("refuses a non-expiring grant before it reaches GitHub at all", async () => {
    const restore = stubGitHub(NON_EXPIRING_GRANT);
    try {
      // The stub rejects any request it did not expect, and the profile read
      // this would otherwise make is one of the three it does expect. So the
      // assertion running *first* is what this measures: a refusal naming the
      // condition rather than a profile.
      await expect(
        githubProvider().getUserInfo({ accessToken: ACCESS_TOKEN })
      ).rejects.toThrow(/non-expiring access token/u);
    } finally {
      restore();
    }
  });

  // The condition ADR 0008 names "at refresh time". A GitHub App whose
  // expiration setting is turned off *after* Reprove stored a good grant hands
  // back one of these on the next refresh, and every stored token silently
  // becomes permanent from then on.
  it.each([
    ["stopped expiring", NON_EXPIRING_GRANT, /non-expiring access token/u],
    [
      "came back with nothing to renew it",
      NO_REFRESH_GRANT,
      /no refresh token/u,
    ],
  ] as const)(
    "refuses a refresh whose new grant %s",
    async (_condition, grant, condition) => {
      const restore = stubGitHub(grant);
      try {
        await expect(
          githubProvider().refreshAccessToken(REFRESH_TOKEN)
        ).rejects.toThrow(condition);
      } finally {
        restore();
      }
    }
  );

  it("passes a conforming refresh through, tokens intact", async () => {
    const restore = stubGitHub(EXPIRING_GRANT);
    try {
      const tokens = await githubProvider().refreshAccessToken(REFRESH_TOKEN);

      expect(tokens.accessToken).toBe(ACCESS_TOKEN);
      expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
      expect(tokens.accessTokenExpiresAt).toBeInstanceOf(Date);
    } finally {
      restore();
    }
  });
});
