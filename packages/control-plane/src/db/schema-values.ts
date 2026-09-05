/**
 * The closed value sets the schema's `text` columns hold, as types.
 *
 * `src/db/schema.ts` documents each of these in a comment beside its column and
 * cannot express them: a Postgres `ENUM` is a type whose values are altered by
 * migration rather than by a diff, and ADR 0008 keeps the state machines in the
 * application. This module is what stops the comment being the only statement -
 * it names no Drizzle type, so it is reachable from anywhere in the package and
 * from its published surface alike.
 */

/** `owner.type`. */
export type OwnerType = "user" | "organization";

/**
 * `ingress_delivery.state`. ADR 0013: none of these is Refusal or Failure
 * vocabulary, because nothing was refused and nothing executed. They are
 * ingress machinery before execution.
 */
export const INGRESS_STATES = ["received", "done", "discarded"] as const;
export type IngressState = (typeof INGRESS_STATES)[number];

/**
 * `ingress_delivery.disposition`, on `discarded`. Each one is terminal, and
 * each is a conclusion about the delivery rather than about a Run:
 *
 * ```text
 * concluded from the delivery alone            -> inert
 * canonical state ineligible - closed, draft   -> ineligible
 * a Run already exists at the canonical head   -> duplicate_head
 * canonical state needed nothing done          -> unchanged
 * grant definitively gone                      -> grant_gone
 * ```
 *
 * `inert` and `unchanged` are the pair worth keeping apart, because collapsing
 * them would make the ledger lie about what a delivery cost.
 *
 * **`inert` means concluded from the delivery alone** - no advisory lock taken
 * and no request issued to GitHub. It is ADR 0013's own word for the last row of
 * its trigger table, "everything else | inert", and it covers two shapes: an
 * event or action that is not a trigger, which is every `edited` delivery and
 * each of the three events GitHub delivers to every App unconditionally; and an
 * acting delivery that names no repository or pull request to act on, which no
 * later attempt can supply. Both are decided by reading the envelope.
 *
 * **`unchanged` means the work was done and nothing needed doing.** The lock was
 * taken and canonical state was read, and it disagreed with the delivery: a
 * stale `closed` for a pull request that has since reopened is ADR 0013's own
 * example, and cancelling on it is exactly what the canonical fetch exists to
 * prevent. Recording that as `inert` would claim no request was made, and
 * recording it as `ineligible` would claim canonical state refused the pull
 * request when it did the opposite.
 *
 * Neither needs a migration. `disposition` is a `text` column and ADR 0008 keeps
 * the state machines in the application rather than in a Postgres `ENUM`, which
 * is exactly the case this is.
 */
export const INGRESS_DISPOSITIONS = [
  "inert",
  "ineligible",
  "duplicate_head",
  "unchanged",
  "grant_gone",
] as const;
export type IngressDisposition = (typeof INGRESS_DISPOSITIONS)[number];

/**
 * `ingress_delivery.retry_class`, on a nonterminal `received`.
 *
 * ADR 0013 classifies retryability **by typed cause, never by HTTP status**,
 * because `403 Resource not accessible by integration`, a missing permission, a
 * revoked grant and a misconfigured App are all permanent and "all 401/403
 * retry with backoff" produces an invisible loop:
 *
 * ```text
 * network failure, 5xx, 429, secondary rate limiting  -> transient
 * auth or App configuration cannot establish access   -> operator_attention
 * advisory lock contention                            -> contended
 * ```
 *
 * `transient` and `contended` are the two ADR 0013 makes a Phase 0 exit
 * condition: every nonterminal `received` caused by either must have an
 * automatic re-drive path, which #38 chooses the mechanism for.
 */
export const INGRESS_RETRY_CLASSES = [
  "transient",
  "operator_attention",
  "contended",
] as const;
export type IngressRetryClass = (typeof INGRESS_RETRY_CLASSES)[number];

/**
 * `run.status`. ADR 0007's machine: `queued` -> `claimed` -> `executing`,
 * terminating in one of the six below.
 */
export const RUN_STATUSES = [
  "queued",
  "claimed",
  "executing",
  "completed",
  "incomplete",
  "failed",
  "superseded",
  "cancelled",
  "unscheduled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The statuses ADR 0013 calls **live**, and the ones the partial unique index
 * `run_one_live_per_pull_request` is predicated on:
 *
 * ```sql
 * UNIQUE (repository_id, pull_request_number)
 *   WHERE status IN ('queued', 'claimed', 'executing')
 * ```
 *
 * The index spells them again rather than importing this list, because a
 * migration is a text artifact that has already run in databases this list
 * cannot reach. `run-creation.test.ts` measures the two against each other by
 * inserting a second live Run at each status rather than by comparing strings.
 */
export const LIVE_RUN_STATUSES = [
  "queued",
  "claimed",
  "executing",
] as const satisfies readonly RunStatus[];
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number];

/**
 * `run.cancellation_reason`, on `cancelled`.
 *
 * Both come from ADR 0013's trigger table - "`closed` | cancel the live Run;
 * create none" and "`converted_to_draft` | cancel the live Run; create none" -
 * and both are decided from **canonical state** rather than from the action
 * that arrived, so a stale `closed` for a pull request that has since reopened
 * cancels nothing. `superseded` is deliberately not here: it is a status of its
 * own, and recording it twice would let the two disagree.
 */
export const RUN_CANCELLATION_REASONS = [
  "pull_request_closed",
  "pull_request_drafted",
] as const;
export type RunCancellationReason = (typeof RUN_CANCELLATION_REASONS)[number];
