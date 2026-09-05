/**
 * The Run row as the arbiter between lifecycles, which is [ADR
 * 0014](../../../../docs/adr/0014-workflow-orchestration-seam.md)'s answer to a
 * `start()` that cannot be made idempotent:
 *
 * ```text
 * start(runLifecycle)            a durable run exists; nothing records it yet
 *   -> recordLifecycle           first writer of workflow_run_id wins
 *   -> the loser cancels itself  and, if it wakes anyway, matches nothing below
 * ```
 *
 * So every write here carries `workflow_run_id = <the writer>` in its `WHERE`,
 * and none of them is a read followed by a write. An orphaned lifecycle - one
 * that started and lost the race to be recorded - wakes at its deadline, finds a
 * predicate that names someone else, and ends having changed nothing.
 *
 * Nothing in this module is exported from `src/index.ts`. Every signature names
 * a Drizzle transaction, and ADR 0010 forbids the only consumer from depending
 * on Drizzle; the orchestration package reaches this through the
 * `RunLifecyclePort` that `createControlPlane()` composes.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type { RunStatus } from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type { RunSchedule } from "./schedule.js";

/**
 * Records which durable run schedules this Run, if none is recorded yet.
 *
 * `IS NULL` rather than `IS DISTINCT FROM`, so the write is once and only once:
 * a predicate that let the recorded lifecycle re-assert its own id would be the
 * same predicate that lets a different id through after a crash and a retry.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param runId The Run.
 * @param workflowRunId The lifecycle claiming it.
 * @returns Whether this call wrote the id.
 */
export const recordLifecycle = async (
  tx: TenantTransaction,
  runId: string,
  workflowRunId: string
): Promise<boolean> => {
  const recorded = await tx
    .update(schema.run)
    .set({ workflowRunId })
    .where(and(eq(schema.run.id, runId), isNull(schema.run.workflowRunId)))
    .returning({ id: schema.run.id });
  return recorded.length > 0;
};

/**
 * The state a lifecycle wakes to.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param runId The Run.
 * @returns Status, deadline and recorded lifecycle, or `null` where this Owner
 *   has no such Run.
 */
export const readSchedule = async (
  tx: TenantTransaction,
  runId: string
): Promise<RunSchedule | null> => {
  const [row] = await tx
    .select({
      status: schema.run.status,
      claimableUntil: schema.run.claimableUntil,
      workflowRunId: schema.run.workflowRunId,
    })
    .from(schema.run)
    .where(eq(schema.run.id, runId))
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    // SAFETY: the column is `text` because ADR 0008 keeps the state machine in
    // the application, and every writer in this package spells a status from
    // the closed set. A value outside it is a defect this read has no better
    // answer for than to report it as it stands.
    status: row.status as RunStatus,
    claimableUntil: row.claimableUntil,
    workflowRunId: row.workflowRunId,
  };
};

/**
 * `queued` to `unscheduled`, and no other transition.
 *
 * ADR 0007 defines `unscheduled` as "never dispatched", and `CONTEXT.md`
 * reserves Failure for a Run that began executing, so writing either over a
 * claimed or executing Run would state something false about it. The status
 * predicate is what keeps this honest; the lifecycle predicate is what keeps an
 * orphan inert.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param runId The Run.
 * @param workflowRunId The lifecycle whose deadline fired.
 * @returns Whether the transition was written.
 */
export const expireUnclaimed = async (
  tx: TenantTransaction,
  runId: string,
  workflowRunId: string
): Promise<boolean> => {
  const expired = await tx
    .update(schema.run)
    .set({ status: "unscheduled" })
    .where(
      and(
        eq(schema.run.id, runId),
        eq(schema.run.status, "queued"),
        eq(schema.run.workflowRunId, workflowRunId)
      )
    )
    .returning({ id: schema.run.id });
  return expired.length > 0;
};
