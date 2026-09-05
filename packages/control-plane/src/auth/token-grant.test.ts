/**
 * The one property in this package that is about a **settings page**.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)
 * keeps a person's GitHub credential in Reprove's database on the strength of
 * one fact: a GitHub App user access token expires in eight hours and is backed
 * by a refresh token. That fact is a toggle - "Expire user authorization
 * tokens" - and turning it off silently converts every stored token into a
 * permanent one. "A security property that depends on a settings page nobody
 * re-reads is not a property", so the App's configuration is measured on every
 * grant rather than trusted.
 *
 * No network and no database here on purpose: the grant is a value, so the
 * condition it carries can be shown to fail from a literal.
 */
import { describe, expect, it } from "vitest";

import {
  assertGitHubTokenGrant,
  GitHubTokenGrantError,
} from "./token-grant.js";

const IN_EIGHT_HOURS = new Date(Date.now() + 8 * 60 * 60 * 1000);

/** What GitHub returns when the App is configured the way ADR 0008 assumes. */
const conforming = {
  accessToken: "gho_access",
  refreshToken: "ghr_refresh",
  accessTokenExpiresAt: IN_EIGHT_HOURS,
};

describe("the GitHub token grant assertion", () => {
  it("accepts an expiring access token backed by a refresh token", () => {
    expect(() => assertGitHubTokenGrant(conforming)).not.toThrow();
  });

  it("refuses a non-expiring access token, and names that condition", () => {
    expect(() =>
      assertGitHubTokenGrant({ ...conforming, accessTokenExpiresAt: undefined })
    ).toThrow(/non-expiring access token/u);
  });

  it("refuses a grant carrying no refresh token, and names that condition", () => {
    expect(() =>
      assertGitHubTokenGrant({ ...conforming, refreshToken: undefined })
    ).toThrow(/refresh token/u);
  });

  it("refuses a grant carrying no access token at all", () => {
    // Distinct from the non-expiring case, which would otherwise absorb it and
    // send the reader to the wrong settings page.
    expect(() =>
      assertGitHubTokenGrant({ ...conforming, accessToken: undefined })
    ).toThrow(/no access token/u);
  });

  it("names the App setting that produces the failure", () => {
    expect(() =>
      assertGitHubTokenGrant({ ...conforming, accessTokenExpiresAt: undefined })
    ).toThrow(/Expire user authorization tokens/u);
  });

  it("reports both conditions when both are broken", () => {
    let raised: unknown;
    try {
      assertGitHubTokenGrant({
        accessToken: "gho_access",
        refreshToken: undefined,
        accessTokenExpiresAt: undefined,
      });
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(GitHubTokenGrantError);
    // SAFETY: narrowed by the assertion immediately above.
    expect((raised as GitHubTokenGrantError).conditions).toStrictEqual([
      "non-expiring access token",
      "no refresh token",
    ]);
  });

  it("treats an empty string as absent, because a blank token is not a token", () => {
    expect(() =>
      assertGitHubTokenGrant({ ...conforming, refreshToken: "" })
    ).toThrow(/no refresh token/u);
  });
});
