/**
 * What a Run's lifecycle reads and writes, as types a consumer may hold.
 *
 * These live apart from `lifecycle.ts` for the same boundary reason
 * `github/delivery.ts` gives: [ADR
 * 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids `apps/control-plane` from depending on Drizzle, and
 * `tools/verify-packages.mjs` measures that by type-checking the packed
 * declarations. A type that merely lives in a module importing Drizzle drags
 * its declaration graph into that check, so the types the published surface
 * names are declared here over the closed value sets and nothing else.
 */
import type {
  ExecutionLostDetector,
  ExecutionLostObservation,
  LostFrom,
  RunStatus,
} from "../db/schema-values.js";

/**
 * The authoritative state a lifecycle re-reads on every wake, rather than
 * trusting the timestamp it slept toward ([ADR
 * 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)).
 */
export interface RunSchedule {
  readonly status: RunStatus;
  /** When the unclaimed window closes. Immutable; written at creation. */
  readonly claimableUntil: Date;
  /**
   * When the **executing** window closes: `claimedAt + livenessFor`, written at
   * claim and carried by both placements (ADR 0015).
   *
   * `null` on a Run that was never claimed. A self-hosted Worker's Lease is
   * what may advance it, which is why the lifecycle re-reads this on every wake
   * rather than trusting the value it slept toward: renewal moves the column,
   * and a stale wake sleeps again.
   */
  readonly executionExpiresAt: Date | null;
  /**
   * The lifecycle the Run records, or `null` inside the window between
   * `start()` returning and the id being written. The database decides which
   * lifecycle owns a Run; a lifecycle reading a different id here is an orphan
   * and ends.
   */
  readonly workflowRunId: string | null;
}

/**
 * What ends an execution, as the evidence rather than as the conclusion.
 *
 * ADR 0015's three detectors reach **one** transition on **one** predicate, and
 * differ only in what they can show for it. That difference is this type, and
 * keeping it here rather than inside the statement is what stops the terminal
 * write forking per detector:
 *
 * ```text
 * deadline    nothing usable arrived by executionExpiresAt, and the writer is
 *             the lifecycle the Run records
 * execution   the execution authorized to submit crashed, and the caller can
 *             present its token to prove which one it was
 * ```
 */
export type ExecutionLossEvidence =
  | {
      /**
       * The watchdog, and later a stopped Lease renewal. Both are "the deadline
       * passed", which is why Lease expiry needs no third shape here.
       */
      readonly kind: "deadline";
      /** The waking lifecycle. ADR 0014's ownership guard, on this window too. */
      readonly workflowRunId: string;
      /** When it woke. Compared against `executionExpiresAt` inside the statement. */
      readonly now: Date;
    }
  | {
      /**
       * The in-process detector: Reprove's own code was on the stack when the
       * pass threw, so it does not wait out a deadline for a crash it saw.
       */
      readonly kind: "execution";
      /**
       * The token that execution held. It is this detector's ownership guard,
       * where the deadline case carries the recorded lifecycle: only the
       * current execution can present it. Hashed before it reaches SQL.
       */
      readonly executionToken: string;
    };

/** One attempt to end a Run whose execution stopped answering. */
export interface ExecutionLoss {
  readonly ownerId: number;
  readonly runId: string;
  /** Which detector noticed, recorded as evidence rather than as vocabulary. */
  readonly detector: ExecutionLostDetector;
  /** What it saw. */
  readonly observation: ExecutionLostObservation;
  /** What it can show, which is the only thing that differs between detectors. */
  readonly evidence: ExecutionLossEvidence;
}

/**
 * What one attempt at the terminal transition decided.
 *
 * A union rather than one shape with two nullable fields, because the two
 * outcomes carry different facts and only one of them has a `lostFrom` at all.
 * Narrowing on `terminalized` is then what hands a caller the status, so
 * nothing downstream needs a fallback for a value that cannot be missing.
 */
export type ExecutionLossOutcome =
  | {
      /**
       * This call wrote the transition. It is what gates reclamation: the
       * database write is the correctness boundary and cancelling a
       * still-running pass is best-effort clean-up that follows it (ADR 0015).
       */
      readonly terminalized: true;
      /**
       * Which side of the window the Run was lost from. Read back out of the
       * row rather than taken from the caller, because the statement is what
       * decided.
       */
      readonly lostFrom: LostFrom;
    }
  | {
      /** The window had closed, or this caller's evidence did not hold. */
      readonly terminalized: false;
      readonly lostFrom: null;
    };

/**
 * The lifecycle's whole reach into a Run, composed over a tenant transaction.
 *
 * Four operations, one per thing the lifecycle is allowed to do: record which
 * durable run schedules the Run, read the state that decides what to do next,
 * and the one transition each of its **two** windows owns - `unscheduled` for
 * the unclaimed window, and `failed(worker_lost)` for the executing one
 * ([ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)).
 * Every write is conditional on the lifecycle being the recorded one, which is
 * what makes ADR 0014's orphan inert.
 */
export interface RunLifecyclePort {
  /**
   * Records the lifecycle, if none is recorded yet. First writer wins.
   *
   * @returns `true` when this call wrote the id; `false` when another already
   *   holds it, or the Run is not this Owner's.
   */
  readonly record: (
    ownerId: number,
    runId: string,
    workflowRunId: string
  ) => Promise<boolean>;
  /** The state a lifecycle wakes to, or `null` for a Run this Owner cannot see. */
  readonly schedule: (
    ownerId: number,
    runId: string
  ) => Promise<RunSchedule | null>;
  /**
   * The one transition the unclaimed window owns: `queued` to `unscheduled`,
   * written only over a Run that was never claimed and only by the recorded
   * lifecycle. A claimed, executing or terminal Run is left exactly as it was.
   *
   * @returns Whether the transition was written.
   */
  readonly expireUnclaimed: (
    ownerId: number,
    runId: string,
    workflowRunId: string
  ) => Promise<boolean>;
  /**
   * The one transition the executing window owns: `failed(worker_lost)`, over
   * exactly Acceptance's eligibility window, written only when the caller's
   * evidence holds.
   *
   * It is on this port rather than beside Acceptance because it is a
   * lifecycle-side write, and it is reachable by the in-process detector too -
   * one transition reached two ways, which is what stops a second liveness
   * story appearing beside this one.
   *
   * @returns Whether the transition was written, and what it was lost from.
   */
  readonly terminateLostExecution: (
    loss: ExecutionLoss
  ) => Promise<ExecutionLossOutcome>;
}
