/**
 * The GitHub App registration, as the manifest GitHub creates one from.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * fixes the grant and the reason it is this small:
 *
 * ```text
 * Metadata: read          mandatory for every App
 * Pull requests: read     gates delivery of the pull_request event
 * ```
 *
 * That is the complete grant. `Contents: read`, `Pull requests: write` and
 * `Checks: write` are **not** pre-declared, and the asymmetry that tempts the
 * opposite choice is understood rather than overlooked: adding a *permission*
 * later requires every existing installation to approve it and the App keeps
 * operating under the old grant until they do, whereas adding an *event
 * subscription* later is free once the gating permission is held. It does not
 * apply because Phase 0 has no third-party installations, so the migration cost
 * is currently zero and will be paid exactly once, deliberately, before Phase 1
 * launches. Pre-declaring write authority buys nothing today and costs an
 * install consent screen that overstates what the App can do, on a product whose
 * central claim is credential minimalism.
 *
 * **No Check is published**, and that is recorded rather than omitted.
 * `CONTEXT.md` requires every Refusal to be visible on a Check, which looks like
 * it forces `Checks: write` into the grant; it does not, because no Refusal is
 * reachable in Phase 0 - a control-plane Refusal arises from configuration that
 * is invalid or cannot be resolved, and Phase 0 Runs are built from fixed inputs
 * with no repository configuration, while a Worker-side Refusal needs a Worker.
 * The Check lands with the first phase that can actually produce a Refusal, and
 * must land at the same time as it.
 *
 * The App subscribes to exactly `pull_request`. GitHub additionally delivers
 * `installation`, `installation_repositories` and `github_app_authorization` to
 * every App by default and **they cannot be subscribed to or unsubscribed
 * from**, so they are absent here and still recorded: the handler normalizes
 * whatever event it is sent rather than assuming an unsubscribed one never
 * arrives, and the event name is a column on the ledger row so #49 can dispatch
 * on it.
 */

/** The permission levels GitHub accepts in a manifest. */
export type ManifestPermission = "read" | "write" | "admin";

/**
 * The complete grant, and the only place it is written. It is a value rather
 * than prose in a runbook so that a test can hold it to ADR 0013 and a widening
 * shows up as a diff beside the decision that forbids it.
 */
export const APP_PERMISSIONS = {
  metadata: "read",
  pull_requests: "read",
} as const satisfies Readonly<Record<string, ManifestPermission>>;

/** The one explicit subscription. The other three arrive unconditionally. */
export const APP_EVENTS = ["pull_request"] as const;

/** The webhook path the App's single hook URL points at. */
export const WEBHOOK_PATH = "/api/github/webhook";

/** The deployment-specific facts a manifest needs and this package cannot know. */
export interface ManifestOptions {
  /** The App's display name. */
  readonly name: string;
  /** The origin the control plane is deployed at, with no trailing slash. */
  readonly baseUrl: string;
  /** Whether the App may be installed by accounts other than its owner. */
  readonly public?: boolean;
}

/**
 * A GitHub App manifest, in the shape `POST /app-manifests/{code}/conversions`
 * is reached through.
 */
export interface GitHubAppManifest {
  readonly name: string;
  readonly url: string;
  readonly hook_attributes: { readonly url: string; readonly active: true };
  readonly redirect_url: string;
  readonly public: boolean;
  readonly default_events: readonly string[];
  readonly default_permissions: Readonly<Record<string, ManifestPermission>>;
}

/**
 * Builds the manifest a registration is created from.
 *
 * @param options The App name and the origin it is deployed at.
 * @returns The manifest, carrying exactly ADR 0013's grant.
 */
export const githubAppManifest = (
  options: ManifestOptions
): GitHubAppManifest => ({
  name: options.name,
  url: options.baseUrl,
  hook_attributes: { url: `${options.baseUrl}${WEBHOOK_PATH}`, active: true },
  redirect_url: `${options.baseUrl}/api/github/manifest/callback`,
  public: options.public ?? false,
  default_events: APP_EVENTS,
  default_permissions: APP_PERMISSIONS,
});
