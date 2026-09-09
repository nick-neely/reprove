/**
 * What a Run looks like from outside, as one read that decides nothing.
 *
 * This is the **observation** half of the Run's published surface, and it is
 * separate from `schedule.ts` on purpose. `RunSchedule` is the authoritative
 * state a lifecycle wakes to and re-reads on every wake, and `RunLifecyclePort`
 * is deliberately four operations - what a lifecycle may do to a Run, and
 * nothing else. Adding `acceptedAt` or a failure detail to that type would put
 * fields no lifecycle reads inside a contract whose smallness is the point, so
 * the observation is its own read instead.
 *
 * [ADR 0016](../../../../docs/adr/0016-phase-0-acceptance-scenario.md) is what
 * asks for it: the Phase 0 exit observes "the `run` row read back through
 * `withOwner()` on the pooled runtime role - status, token, `acceptedAt`,
 * structured failure detail". The alternative was to read those columns with
 * `psql` as the admin role, which reproduces neither the runtime role nor the
 * transaction-local tenant context and so would not be the read the criterion
 * names. Going through `createControlPlane()` gets both for free.
 *
 * It lives apart from the module that queries it for the same boundary reason
 * `schedule.ts` and `github/delivery.ts` do: ADR 0010 forbids
 * `apps/control-plane` from depending on Drizzle, and `verify-packages`
 * measures that by type-checking the packed declarations, so a published type
 * declared in a module that imports Drizzle drags its declaration graph into
 * that check. Every field below is spelled over the closed value sets and the
 * primitives, and names nothing from a driver.
 */
import type {
  ExecutionLostDetector,
  ExecutionLostObservation,
  LostFrom,
  RunFailureReason,
  RunPlacement,
  RunStatus,
} from "../db/schema-values.js";

/**
 * The structured account of a lost execution, as the terminal transition wrote
 * it.
 *
 * Three fields rather than a free `jsonb` shape, because they are what
 * `terminateLostExecution` builds: the detector that noticed, what it saw, and
 * which side of the window the Run was lost from. ADR 0015's operational
 * question - "my daemon or your infrastructure?" - is answered by `detector`
 * rather than by a second failure reason, which is why reading it back matters
 * at all.
 */
export interface ExecutionLostDetail {
  readonly detector: ExecutionLostDetector;
  readonly observation: ExecutionLostObservation;
  readonly lostFrom: LostFrom;
}

/**
 * One Run, as an observer sees it.
 *
 * Deliberately a **subset** of the row rather than all of it. The spec half is
 * immutable and already known to whoever created the Run; what is worth
 * publishing is the state that moved, and the evidence for why it moved.
 */
export interface RunRecord {
  readonly status: RunStatus;
  /**
   * Which placement the Run was created for. Read here because the two
   * placements reach the same claim and the same Acceptance, so the placement
   * is the only thing that says which story a given row is telling.
   */
  readonly placement: RunPlacement;
  /**
   * `sha256:<hex>` over the token the claim minted, or `null` on a Run that was
   * never claimed.
   *
   * The digest rather than the token, because the plaintext is returned to the
   * Worker exactly once and is not recoverable from the row afterwards - that
   * is the whole reason the column stores a digest. Publishing a digest is safe
   * for the same reason storing one is: it authorizes nothing.
   */
  readonly executionTokenHash: string | null;
  /** When Acceptance absorbed a Result, and `null` where it never has. */
  readonly acceptedAt: Date | null;
  /** `worker_lost`, on a `failed` Run. `null` on every other Run. */
  readonly failureReason: RunFailureReason | null;
  /** What was observed, beside the reason that names it. */
  readonly failureDetail: ExecutionLostDetail | null;
  /** The Reviewer's prose, from the accepted Result. */
  readonly resultSummary: string | null;
  /**
   * The **pass** the Run records - one hosted Worker's attempt at it. `null`
   * means no pass is recorded, never that none is running: the window between
   * `start()` and `markExecuting` cannot be closed, and a crash inside it
   * leaves exactly this shape (ADR 0016).
   */
  readonly hostedWorkflowRunId: string | null;
}
