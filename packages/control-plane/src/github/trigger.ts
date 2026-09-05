/**
 * Which deliveries act, and what each of them is asking for.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * fixes the table:
 *
 * | `pull_request` action | effect |
 * | --- | --- |
 * | `opened` | create a Run, if not draft |
 * | `synchronize` | supersede the live Run and create one at the canonical head, if not draft |
 * | `reopened` | create if not draft and no Run exists at that head |
 * | `ready_for_review` | create if no Run exists at that head |
 * | `closed` | cancel the live Run; create none |
 * | `converted_to_draft` | cancel the live Run; create none |
 * | everything else | inert |
 *
 * The per-action conditions are deliberately **not** repeated here, because
 * every one of them is a statement about canonical state rather than about the
 * action, and ADR 0013 resolves canonical state inside the critical section
 * precisely so that the action stops being the authority. "If not draft" and "if
 * no Run exists at that head" are the same two checks in all four rows, so
 * `run-creation.ts` makes them once. What survives here is the only distinction
 * the action really carries: whether the delivery could produce a Run at all.
 *
 * **`edited` is inert deliberately**, and it is the row worth stating twice.
 * [ADR 0012](../../../../docs/adr/0012-author-controlled-narrative-input.md)
 * classifies the title and description as Author-controlled narrative, so
 * letting an edit re-trigger would hand the Author an unlimited free re-roll of
 * the review at no cost.
 *
 * The switch is **explicit and closed** rather than an allowlist over
 * `pull_request` alone: GitHub delivers `installation`,
 * `installation_repositories` and `github_app_authorization` to every App by
 * default and they "cannot be subscribed to or unsubscribed from", so the
 * handler "may not assume that an unsubscribed event never arrives".
 */

/** The `pull_request` actions that can produce a Run. */
const REVIEWS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** The `pull_request` actions that can only end one. */
const CANCELS: ReadonlySet<string> = new Set(["closed", "converted_to_draft"]);

/** What a delivery is asking the critical section to consider doing. */
export type DeliveryIntent =
  /** Create a Run at the canonical head, if canonical state allows one. */
  | "review"
  /** End the live Run, if canonical state agrees the pull request is over. */
  | "cancel"
  /** Nothing. No lock is taken and no canonical fetch is made. */
  | "inert";

/**
 * Reads one delivery's event and action.
 *
 * @param event `X-GitHub-Event`, as the envelope recorded it.
 * @param action The payload's action, or `null` where it carried none.
 * @returns What this delivery is asking for.
 */
export const intentOf = (
  event: string,
  action: string | null
): DeliveryIntent => {
  if (event !== "pull_request" || action === null) {
    return "inert";
  }
  if (REVIEWS.has(action)) {
    return "review";
  }
  return CANCELS.has(action) ? "cancel" : "inert";
};
