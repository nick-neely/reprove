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
import type { RunStatus } from "../db/schema-values.js";

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
   * The lifecycle the Run records, or `null` inside the window between
   * `start()` returning and the id being written. The database decides which
   * lifecycle owns a Run; a lifecycle reading a different id here is an orphan
   * and ends.
   */
  readonly workflowRunId: string | null;
}

/**
 * The lifecycle's whole reach into a Run, composed over a tenant transaction.
 *
 * Three operations and no fourth: recording which durable run schedules the
 * Run, reading the state that decides what to do next, and the one transition
 * `claimableUntil` owns. Every write is conditional on the lifecycle being the
 * recorded one, which is what makes ADR 0014's orphan inert.
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
}
