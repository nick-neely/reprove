/**
 * The App's grant, held to [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md).
 *
 * A permission is not like a line of code: adding one later requires every
 * existing installation to approve it, and the App keeps operating under the old
 * grant until they do. So the set is asserted **exactly** rather than by
 * membership - a widening has to be a failing test beside the decision that
 * forbids it, not a field somebody added.
 */
import { describe, expect, it } from "vitest";

import {
  APP_EVENTS,
  APP_PERMISSIONS,
  githubAppManifest,
  WEBHOOK_PATH,
} from "./manifest.js";

const MANIFEST = githubAppManifest({
  name: "Reprove",
  baseUrl: "https://reprove.example",
});

describe("the GitHub App manifest", () => {
  it("requests Metadata: read and Pull requests: read, and nothing else", () => {
    expect(MANIFEST.default_permissions).toStrictEqual({
      metadata: "read",
      pull_requests: "read",
    });
    expect(APP_PERMISSIONS).toStrictEqual(MANIFEST.default_permissions);
  });

  it("pre-declares no write authority at all", () => {
    // Named one by one, because these three are the ones a later phase will
    // want and the ones an install consent screen would overstate today.
    expect(Object.keys(MANIFEST.default_permissions)).not.toContain("contents");
    expect(Object.keys(MANIFEST.default_permissions)).not.toContain("checks");
    expect(Object.values(MANIFEST.default_permissions)).not.toContain("write");
  });

  it("publishes no Check, because no Refusal is reachable in Phase 0", () => {
    // The Check lands with the first phase that can produce a Refusal and must
    // land at the same time as it, so its absence is checked from both sides:
    // the permission that would let one be written, and any subscription that
    // would suggest one is read.
    expect(MANIFEST.default_permissions.checks).toBeUndefined();
    expect(MANIFEST.default_events).not.toContain("check_run");
    expect(MANIFEST.default_events).not.toContain("check_suite");
  });

  it("subscribes to exactly one event", () => {
    // The other three - `installation`, `installation_repositories` and
    // `github_app_authorization` - arrive at every App unconditionally and
    // cannot be subscribed to or unsubscribed from, so their absence here says
    // nothing about whether they are handled.
    expect(MANIFEST.default_events).toStrictEqual(["pull_request"]);
    expect(APP_EVENTS).toStrictEqual(MANIFEST.default_events);
  });

  it("points its one hook at the route that handles it", () => {
    // A GitHub App has exactly one webhook URL and one secret, so this is not
    // one address among several.
    expect(MANIFEST.hook_attributes).toStrictEqual({
      url: `https://reprove.example${WEBHOOK_PATH}`,
      active: true,
    });
    expect(WEBHOOK_PATH).toBe("/api/github/webhook");
  });

  it("is private unless a deployment says otherwise", () => {
    expect(MANIFEST.public).toBeFalsy();
    expect(
      githubAppManifest({
        name: "Reprove",
        baseUrl: "https://reprove.example",
        public: true,
      }).public
    ).toBeTruthy();
  });
});
