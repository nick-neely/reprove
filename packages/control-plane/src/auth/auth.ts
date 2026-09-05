/**
 * Better Auth, composed over the four tables Reprove adopted rather than over
 * four Better Auth manages.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s
 * Better Auth seam, as code. Three decisions live here and each is load-bearing:
 *
 * 1. **The Drizzle adapter is handed the schema module's own tables.** Better
 *    Auth's CLI emits a schema file the application owns, so `user`, `session`,
 *    `account` and `verification` share Reprove's single migration history and
 *    Better Auth manages none of its own. The adapter resolves every field
 *    against the object passed here, so the tables in `../db/schema.js` are the
 *    definition, not a copy of one.
 * 2. **`account.encryptOAuthTokens` is on.** Better Auth stores OAuth tokens in
 *    plaintext by default; enabling it gives AES-256-GCM keyed from the
 *    `secret` below. The refresh token this protects is the six-month one.
 * 3. **The GitHub grant is asserted at both points it arrives.** See
 *    {@link assertingGitHubProvider}.
 *
 * These tables sit **outside Owner RLS** and carry no Owner policy, which is
 * `classification.ts`'s decision rather than this file's: a User can
 * legitimately reach several Owners, so Owner tenancy would model the
 * relationship incorrectly. Nothing here writes an `owner_id`, and `owner` has
 * no foreign key to `user` in either direction.
 *
 * **Not exported from `src/index.ts`.** ADR 0010 forbids `apps/control-plane`
 * from depending on `better-auth`, so a published signature returning the
 * Better Auth instance would hand the only consumer a type it may not import -
 * the same boundary `db/index.js` keeps against Drizzle and `pg`.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { GithubOptions } from "better-auth/social-providers";
import { github } from "better-auth/social-providers";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { requireNonEmpty } from "../db/config.js";
import * as schema from "../db/schema.js";
import { assertGitHubTokenGrant } from "./token-grant.js";

/** The GitHub App's OAuth credentials. Not read from the environment. */
export interface GitHubAppCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * What `createAuth()` composes over. No value here is read from the
 * environment, and every one of them is checked before an instance exists -
 * Better Auth would otherwise fall back to `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL`, which is the ambient resolution this package refuses for
 * the same reason `pg` may not resolve a connection string from `PGHOST`.
 */
export interface AuthConfig {
  /**
   * The Drizzle client the four tables are reached through. It is **not** a
   * tenant transaction: these tables carry no Owner policy, and `withOwner`
   * would be asserting a tenancy the authentication model does not have.
   */
  readonly database: NodePgDatabase<typeof schema>;
  /**
   * The signing secret, which is also what the OAuth token encryption key is
   * derived from. Rotating it invalidates every stored token.
   */
  readonly secret: string;
  /** The origin Better Auth builds its callback URLs from. */
  readonly baseURL: string;
  readonly github: GitHubAppCredentials;
}

/** The composed instance. */
export type Auth = ReturnType<typeof createAuth>;

/**
 * The GitHub social provider, with ADR 0008's token-grant requirement wrapped
 * around the two points a raw grant from GitHub is visible.
 *
 * - `getUserInfo` is called on **every** OAuth callback, with the token
 *   response as Better Auth mapped it, before anything is written.
 * - `refreshAccessToken` is called on every refresh.
 *
 * Both are provider *options*, so supplying one replaces the stock behaviour
 * rather than running beside it. The stock behaviour is therefore constructed
 * here and delegated to: `github()` consults `options.getUserInfo` first, and
 * the instance below is built without one, so it runs GitHub's own profile and
 * refresh calls. Reprove owns the assertion and Better Auth keeps owning the
 * request.
 *
 * The database hooks on `account` were the obvious alternative and are the
 * wrong seam: on a repeat sign-in Better Auth filters `undefined` out of the
 * update it writes, so the absent `accessTokenExpiresAt` that *is* the
 * non-expiring condition never reaches a hook. The condition is only visible
 * where the grant is still the grant.
 *
 * @param credentials The GitHub App's OAuth credentials.
 * @returns Provider options that assert before they yield.
 */
const assertingGitHubProvider = (
  credentials: GitHubAppCredentials
): GithubOptions => {
  const stock = github(credentials);

  return {
    ...credentials,
    getUserInfo: async (tokens) => {
      assertGitHubTokenGrant(tokens);
      return await stock.getUserInfo(tokens);
    },
    refreshAccessToken: async (refreshToken) => {
      const tokens = await stock.refreshAccessToken(refreshToken);
      assertGitHubTokenGrant(tokens);
      return tokens;
    },
  };
};

/**
 * Composes Better Auth against Reprove's adopted tables.
 *
 * @param config The database client and the credentials, passed in rather than
 *   read from anywhere.
 * @returns The Better Auth instance.
 * @throws {TypeError} Naming the field, when a credential or the secret is
 *   absent, null or empty.
 */
export const createAuth = (config: AuthConfig) => {
  const secret = requireNonEmpty(config.secret, "AuthConfig.secret");
  const baseURL = requireNonEmpty(config.baseURL, "AuthConfig.baseURL");
  const clientId = requireNonEmpty(
    config.github?.clientId,
    "AuthConfig.github.clientId"
  );
  const clientSecret = requireNonEmpty(
    config.github?.clientSecret,
    "AuthConfig.github.clientSecret"
  );

  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(config.database, {
      provider: "pg",
      // Named one by one rather than spread, so a table added to the schema
      // module never silently becomes a Better Auth model.
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    account: {
      // ADR 0008. Plaintext is Better Auth's default and is not an option here:
      // the refresh token is the six-month one.
      encryptOAuthTokens: true,
    },
    socialProviders: {
      github: assertingGitHubProvider({ clientId, clientSecret }),
    },
    // Off explicitly rather than by default, because the default is read from
    // `BETTER_AUTH_TELEMETRY` and this package resolves nothing from the
    // environment.
    telemetry: { enabled: false },
  });
};
