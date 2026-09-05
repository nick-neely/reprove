/**
 * The check [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md) states
 * as a code requirement rather than a documented intention:
 *
 * > Reprove verifies at authentication and refresh time that GitHub issued an
 * > expiring access token and a refresh token, and refuses or fails
 * > configuration loudly otherwise.
 *
 * The reasoning it rests on: a GitHub App user access token expires in eight
 * hours and is backed by a six-month refresh token, which is what makes keeping
 * a person's credential in Reprove's database defensible at all. Both halves
 * come from the App's **"Expire user authorization tokens"** setting. It is
 * default-on for a new App and it is still a toggle, and opting out changes
 * nothing observable at sign-in: the flow succeeds, a token is stored, and it
 * is a permanent one. That is the failure that succeeds quietly, which ADR 0004
 * bans outright.
 *
 * A pure function over the grant, deliberately: the condition is a property of
 * a value, so it is falsifiable from a literal with no network and no App.
 */

/**
 * The part of an OAuth grant this assertion is about.
 *
 * Structurally compatible with Better Auth's `OAuth2Tokens` without naming it,
 * so the check is measurable from a literal and holds no opinion about where
 * the grant came from. Better Auth maps GitHub's `expires_in` to
 * `accessTokenExpiresAt` and leaves it `undefined` when the field is absent,
 * which is exactly the non-expiring case.
 */
export interface GitHubTokenGrant {
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
  readonly accessTokenExpiresAt?: Date | undefined;
}

/**
 * The conditions, spelled once. A refusal quotes these verbatim, so the string
 * a reader searches for is the string the code names.
 */
const NO_ACCESS_TOKEN = "no access token";
const NON_EXPIRING_ACCESS_TOKEN = "non-expiring access token";
const NO_REFRESH_TOKEN = "no refresh token";

/**
 * What `createAuth()`'s GitHub seam throws instead of storing the grant.
 *
 * `CONTEXT.md`'s noun is **Refusal**; the `Error` suffix is the JavaScript
 * convention for a throwable and is not a second domain word. It is not a
 * `BootRefusalError`, because this is not the boot assertion: it refuses one
 * sign-in or one refresh, at the moment GitHub answered, rather than refusing
 * to return a database client.
 */
export class GitHubTokenGrantError extends Error {
  /** Every condition the grant broke, in the order they are checked. */
  readonly conditions: readonly string[];

  constructor(conditions: readonly string[]) {
    super(
      [
        `GitHub issued a token grant Reprove will not store: ${conditions.join(" and ")}.`,
        'Enable "Expire user authorization tokens" on the GitHub App.',
        "Without it a user access token never expires and no refresh token is",
        "issued, so every token Reprove stored would be permanent (ADR 0008).",
      ].join("\n")
    );
    this.name = "GitHubTokenGrantError";
    this.conditions = conditions;
  }
}

/**
 * A token as it actually arrives. An empty string is absent: Better Auth would
 * store it, and a blank credential is not one.
 */
const present = (token: string | undefined): boolean =>
  token !== undefined && token !== "";

/**
 * Every condition the grant breaks, empty when it is the grant ADR 0008
 * assumes.
 *
 * `no access token` is separate from `non-expiring access token` rather than
 * absorbed by it, because the two send a reader to different places: one is a
 * broken exchange, the other is the App setting.
 *
 * @param grant The token response, as Better Auth mapped it.
 * @returns One condition per broken clause.
 */
export const gitHubTokenGrantConditions = (
  grant: GitHubTokenGrant
): string[] => {
  const hasAccessToken = present(grant.accessToken);
  return [
    hasAccessToken ? null : NO_ACCESS_TOKEN,
    hasAccessToken && grant.accessTokenExpiresAt === undefined
      ? NON_EXPIRING_ACCESS_TOKEN
      : null,
    present(grant.refreshToken) ? null : NO_REFRESH_TOKEN,
  ].filter((condition) => condition !== null);
};

/**
 * Loudly, and before the grant is written anywhere.
 *
 * @param grant The token response, as Better Auth mapped it.
 * @throws {GitHubTokenGrantError} Naming every condition the grant broke and
 *   the App setting that produces them.
 */
export const assertGitHubTokenGrant = (grant: GitHubTokenGrant): void => {
  const conditions = gitHubTokenGrantConditions(grant);
  if (conditions.length > 0) {
    throw new GitHubTokenGrantError(conditions);
  }
};
