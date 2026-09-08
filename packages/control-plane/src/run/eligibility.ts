/**
 * [ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)'s
 * Result-eligibility window, defined here and nowhere else.
 *
 * ```text
 * Result-eligible Run = status IN (claimed, executing)
 *                     + acceptedAt IS NULL
 *                     + executionToken matches
 * ```
 *
 * The ADR requires it be "defined **once** and shared, never restated", because
 * two conditional updates race over exactly it:
 *
 * ```text
 * Acceptance             eligible + valid Result       -> completed / incomplete
 * liveness termination   eligible + liveness expired   -> failed(worker_lost)
 * ```
 *
 * Whichever wins closes the other path, and a detector scoped more narrowly than
 * Acceptance would leave the guarantee holed - reachably rather than
 * theoretically, since a Run abandoned at `claimed` with no pass ever recorded
 * is one `claimableUntil` never touches.
 *
 * **The window and the token are two functions rather than one.** The last line
 * of the ADR's box is the execution's *identity*, and only Acceptance holds one:
 * a Worker submits the token it was granted, while the watchdog's entire
 * evidence is that nobody is answering. So the token is a conjunct Acceptance
 * adds, and the shared half is everything above it. Both spellings live in this
 * module so that the split is structural: `eligibility.test.ts` renders the two
 * through the pinned dialect and compares, which is what makes "never restated"
 * a measured property rather than a convention.
 *
 * It lives under `run/` rather than beside Acceptance because the liveness
 * transition is a lifecycle-side write, and a lifecycle module reaching into
 * `worker/` for the window would invert the dependency the ADR describes: one
 * window, two callers, owned by neither.
 *
 * `ownerId` is in the predicate as well as in the tenant context, which is ADR
 * 0008 rule 1: application scoping **plus** RLS, "not either alone".
 */
import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { RESULT_ELIGIBLE_RUN_STATUSES } from "../db/schema-values.js";
import * as schema from "../db/schema.js";

/**
 * The window both racers share: this Owner's Run, still inside the statuses a
 * Result may be accepted over, with no Result accepted yet.
 *
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run, already checked with `isRunId` where it came from a
 *   caller rather than from the database.
 * @returns The window, as a predicate a conditional UPDATE may carry.
 */
export const resultEligibleWindow = (
  ownerId: number,
  runId: string
): SQL | undefined =>
  and(
    eq(schema.run.ownerId, ownerId),
    eq(schema.run.id, runId),
    inArray(schema.run.status, RESULT_ELIGIBLE_RUN_STATUSES),
    isNull(schema.run.acceptedAt)
  );

/**
 * Acceptance's whole predicate: the window above, plus the identity of the
 * execution authorized to submit against this Run.
 *
 * @param ownerId The submitting Owner.
 * @param runId The Run, already checked with `isRunId`.
 * @param executionTokenHash The stored form of the presented token.
 * @returns The window and the token, as a predicate an UPDATE may carry.
 */
export const resultEligible = (
  ownerId: number,
  runId: string,
  executionTokenHash: string
): SQL | undefined =>
  and(
    resultEligibleWindow(ownerId, runId),
    eq(schema.run.executionTokenHash, executionTokenHash)
  );

/**
 * The status half of the window, read back off a probed row.
 *
 * The re-probes that name a refusal read a row rather than carry a predicate,
 * so they need the same membership test as a value rather than as SQL. Sharing
 * it with the predicate above is the same guarantee at one remove: a status
 * added to the window is a status the probes stop misnaming.
 */
export const statusIsEligible = (status: string): boolean =>
  // SAFETY: the probe reads a `text` column, because ADR 0008 keeps the state
  // machine in the application rather than in a Postgres `ENUM`, so the value
  // is a string that may or may not be one of these. Widening the tuple is what
  // lets an unknown status be asked about at all; narrowing the string instead
  // would assert a membership this line exists to test.
  (RESULT_ELIGIBLE_RUN_STATUSES as readonly string[]).includes(status);
