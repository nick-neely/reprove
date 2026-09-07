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
import type { RunSpec } from "@reprove/protocol/v1";

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
 * `run.placement`, which is also `RunSpec.placement` on the wire.
 *
 * Spelled against the protocol's own type rather than beside it, so a placement
 * this package can write is exactly a placement a Worker accepts - the same
 * rule `Phase0RunProfile` follows, and for the same reason: there is no second
 * vocabulary for the two to drift against.
 */
export const RUN_PLACEMENTS = [
  "self_hosted",
  "hosted",
] as const satisfies readonly RunSpec["placement"][];
export type RunPlacement = (typeof RUN_PLACEMENTS)[number];

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
 * UNIQUE (owner_id, repository_id, pull_request_number)
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
 * The statuses over which a Run may still accept a Result, and the status half
 * of [ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)'s
 * eligibility window:
 *
 * ```text
 * Result-eligible Run = status IN (claimed, executing)
 *                     + acceptedAt IS NULL
 *                     + executionToken matches
 * ```
 *
 * The ADR requires that window be "defined **once** and shared, never
 * restated", because Acceptance and the liveness termination that ends an
 * abandoned Run (#56) are two conditional updates racing over exactly it. A
 * detector scoped more narrowly than Acceptance leaves the guarantee holed, and
 * the hole is reachable rather than theoretical.
 *
 * It excludes `queued` deliberately: a Run that was never claimed has no
 * execution to submit on behalf of, and `claimableUntil` is what ends it.
 */
export const RESULT_ELIGIBLE_RUN_STATUSES = [
  "claimed",
  "executing",
] as const satisfies readonly RunStatus[];
export type ResultEligibleRunStatus =
  (typeof RESULT_ELIGIBLE_RUN_STATUSES)[number];

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

/**
 * `run.failure_reason`, on `failed`.
 *
 * One member, and [ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
 * argues for it at length: `worker_lost` serves **both Worker kinds and all
 * three detectors**, because ADR 0001's single Worker concept is load-bearing
 * and "my daemon or your infrastructure?" is answered by the detector, which is
 * evidence rather than domain vocabulary.
 *
 * It is the fallback for an execution that ended without a more specific
 * acceptable terminal report reaching the control plane. An uncaught throw
 * qualifies even though Reprove witnessed it, because a crash is not an
 * acceptable terminal report. A structured Failure from `worker-core` does
 * **not**: that path keeps its own specific reason, so
 * `sandbox_teardown_incomplete` is never collapsed into this.
 */
export const RUN_FAILURE_REASONS = ["worker_lost"] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

/**
 * `run.failure_detail.detector`: which of ADR 0015's three noticed.
 *
 * ```text
 * hosted_prompt     hosted, in-process   an uncaught throw in the pass    milliseconds
 * hosted_watchdog   hosted, lifecycle    no usable signal by deadline     bounded
 * lease_expired     self-hosted, later   renewal stops                    bounded
 * ```
 *
 * All three call the same transition on the same predicate. They differ because
 * the **evidence** differs; the terminal write does not fork.
 *
 * `lease_expired` is declared before it is reachable, deliberately. It is ADR
 * 0015's fixed vocabulary, and the property that makes self-hosted renewal "a
 * column write rather than a second liveness system" is easier to keep true
 * when the vocabulary it lands in already exists.
 */
export const EXECUTION_LOST_DETECTORS = [
  "hosted_prompt",
  "hosted_watchdog",
  "lease_expired",
] as const;
export type ExecutionLostDetector = (typeof EXECUTION_LOST_DETECTORS)[number];

/**
 * `run.failure_detail.observation`: what the detector actually saw.
 *
 * ```text
 * uncaught_throw                    the pass threw and Reprove was on the stack
 * workflow_failed                   the durable pass ended failed
 * workflow_cancelled                the durable pass was cancelled
 * workflow_terminal_without_result  it ended, and no Result was ever submitted
 * workflow_state_unavailable        its state could not be read at all
 * deadline_elapsed                  nothing usable arrived by executionExpiresAt
 * ```
 *
 * Only `uncaught_throw` and `deadline_elapsed` are reachable in Phase 0. The
 * other four describe a **pass's** durable run, which arrives with the hosted
 * placement (#57); they are declared here because they are ADR 0015's fixed set
 * and inventing code paths to reach them early would prove nothing.
 */
export const EXECUTION_LOST_OBSERVATIONS = [
  "uncaught_throw",
  "workflow_failed",
  "workflow_cancelled",
  "workflow_terminal_without_result",
  "workflow_state_unavailable",
  "deadline_elapsed",
] as const;
export type ExecutionLostObservation =
  (typeof EXECUTION_LOST_OBSERVATIONS)[number];

/**
 * `run.failure_detail.lostFrom`: which side of the eligibility window the Run
 * was abandoned on.
 *
 * It is `ResultEligibleRunStatus` **reused rather than restated**, because it is
 * the same fact: the terminal transition writes over exactly Acceptance's
 * window, so a Run can only be lost from inside it. A second list here would be
 * the divergence ADR 0015 forbids, in the one place it would be least visible.
 */
export type LostFrom = ResultEligibleRunStatus;
