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
 * The module holds **two** windows' transitions, not one:
 *
 * ```text
 * claimableUntil       queued -> unscheduled          expireUnclaimed
 * executionExpiresAt   claimed | executing -> failed  terminateLostExecution
 * ```
 *
 * Beside them is the one transition **inside** the second window rather than
 * out of it: `markExecuting` takes a claimed Run to `executing` and records the
 * pass running it. It is here rather than beside the claim because the pass is
 * a durable run and this module is where the Run's durable runs are written,
 * and its ownership guard is the execution token rather than the recorded
 * lifecycle - the caller is the execution, not the schedule watching it.
 *
 * The second is [ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)'s,
 * and it is the one transition here that is not the lifecycle's alone: the
 * in-process detector reaches it too, presenting an execution token where the
 * watchdog presents the recorded lifecycle. That is why its ownership guard is
 * part of the evidence rather than hard-coded into the statement.
 *
 * Nothing in this module is exported from `src/index.ts`. Every signature names
 * a Drizzle transaction, and ADR 0010 forbids the only consumer from depending
 * on Drizzle; the orchestration package reaches this through the
 * `RunLifecyclePort` that `createControlPlane()` composes.
 */
import { and, eq, isNull, lte, sql } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type {
  LostFrom,
  RunFailureReason,
  RunStatus,
} from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import { hashExecutionToken } from "../worker/execution-token.js";
import { resultEligibleWindow } from "./eligibility.js";
import type {
  ExecutionLoss,
  ExecutionLossEvidence,
  ExecutionLossOutcome,
  HostedExecution,
  RunSchedule,
} from "./schedule.js";

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
      executionExpiresAt: schema.run.executionExpiresAt,
      workflowRunId: schema.run.workflowRunId,
      hostedWorkflowRunId: schema.run.hostedWorkflowRunId,
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
    executionExpiresAt: row.executionExpiresAt,
    workflowRunId: row.workflowRunId,
    hostedWorkflowRunId: row.hostedWorkflowRunId,
  };
};

/**
 * `claimed` to `executing`, recording the pass that is running the Run.
 *
 * ```text
 * update run
 *    set status = 'executing', hosted_workflow_run_id = <the pass>
 *  where <Acceptance's eligibility window>
 *    and status = 'claimed'
 *    and execution_token_hash = sha256(<the presented token>)
 * ```
 *
 * **The window is Acceptance's**, for the reason `terminateLostExecution` below
 * carries it: this write races the same two conditional updates over the same
 * row. A Run that accepted a Result or was terminalized while dispatch was
 * between `start()` and here has closed, and moving it to `executing` would
 * revive a Run whose Acceptance is over.
 *
 * **`status = 'claimed'` is the transition's own half**, added to the shared
 * window rather than replacing it. A Run already `executing` records a pass,
 * and overwriting that id would leave the lifecycle cancelling the wrong
 * durable run - or nothing at all - while the recorded one kept running.
 *
 * **The token is the ownership guard**, where the lifecycle's writes carry
 * `workflow_run_id`. The caller here is the execution rather than the schedule
 * watching it, so the only thing that says which execution it is is the token
 * the claim handed it. Hashed here; the plaintext never reaches SQL.
 *
 * **It cannot be made atomic with `start()`.** ADR 0014: `start()` accepts no
 * caller-supplied run id, so a crash between the two leaves a pass that is
 * genuinely running and a Run that records none. That is not a defect this
 * statement can close, and ADR 0015 is what closes it instead - execution
 * liveness covers the `claimed` half of the window precisely because of this.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param execution The Run, the token that execution holds, and its pass.
 * @returns Whether the transition was written.
 */
export const markExecuting = async (
  tx: TenantTransaction,
  execution: HostedExecution
): Promise<boolean> => {
  const executing = await tx
    .update(schema.run)
    .set({
      status: "executing" satisfies RunStatus,
      hostedWorkflowRunId: execution.hostedWorkflowRunId,
    })
    .where(
      and(
        resultEligibleWindow(execution.ownerId, execution.runId),
        eq(schema.run.status, "claimed"),
        eq(
          schema.run.executionTokenHash,
          hashExecutionToken(execution.executionToken)
        )
      )
    )
    .returning({ id: schema.run.id });
  return executing.length > 0;
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

/**
 * What one detector can show for itself, as the conjunct it adds to the shared
 * window.
 *
 * This is the whole of the difference between ADR 0015's three detectors. The
 * window is Acceptance's and is not restated; the terminal write below is one
 * statement and does not fork.
 */
const evidenceHolds = (evidence: ExecutionLossEvidence) =>
  evidence.kind === "deadline"
    ? and(
        // NULL-safe rather than NULL-blind: a Run carrying no deadline matches
        // nothing here instead of being terminalized on a comparison that is
        // neither true nor false.
        lte(schema.run.executionExpiresAt, evidence.now),
        // ADR 0014's ownership guard, which every lifecycle-side transition
        // keeps. An orphan wakes at the same deadline and stays inert.
        eq(schema.run.workflowRunId, evidence.workflowRunId)
      )
    : eq(
        schema.run.executionTokenHash,
        hashExecutionToken(evidence.executionToken)
      );

/**
 * Ends a Run whose execution stopped answering, or writes nothing.
 *
 * ```text
 * update run
 *    set status = 'failed', failure_reason = 'worker_lost',
 *        failure_detail = { detector, observation, lostFrom: <the OLD status> }
 *  where <Acceptance's eligibility window>
 *    and <this detector's evidence>
 * ```
 *
 * **The window is Acceptance's, exactly.** ADR 0015 makes this and Acceptance
 * two conditional updates racing over one predicate, so whichever wins closes
 * the other path: a Result arriving after this transition is rejected
 * `not_eligible`, and this transition over a Run that just accepted one writes
 * nothing. A detector scoped more narrowly - to `executing` alone, say - would
 * leave a Run abandoned at `claimed` eligible forever, which is the hole ADR
 * 0016 makes the mandatory Phase 0 case.
 *
 * **`lostFrom` is the row's own pre-update `status`.** Inside `SET`, a column
 * reference is the old value, so the detail records `claimed` or `executing`
 * without a second statement that could disagree with the first. That is what
 * keeps this one conditional statement rather than a read and a write.
 *
 * **It decides; it does not reclaim.** The database write is the correctness
 * boundary and `cancel()` of a still-running pass is best-effort clean-up that
 * follows a transition that won - cancelling first would make a resource
 * operation load-bearing for correctness. The caller gets `terminalized` for
 * exactly that ordering. Where no pass was ever recorded there is nothing to
 * cancel, and that is fine: a pass emerging afterwards cannot change a Run
 * whose Acceptance has already closed.
 *
 * @param tx A tenant transaction already scoped to the Run's Owner.
 * @param loss The Run, the detector's account of itself, and its evidence.
 * @returns Whether the transition was written, and what it was lost from.
 */
export const terminateLostExecution = async (
  tx: TenantTransaction,
  loss: ExecutionLoss
): Promise<ExecutionLossOutcome> => {
  const [terminalized] = await tx
    .update(schema.run)
    .set({
      status: "failed" satisfies RunStatus,
      failureReason: "worker_lost" satisfies RunFailureReason,
      // The one place `lostFrom` can be read without a second statement: on the
      // right of `SET`, `run.status` is still the pre-update value.
      failureDetail: sql`jsonb_build_object(
        'detector', ${loss.detector}::text,
        'observation', ${loss.observation}::text,
        'lostFrom', ${schema.run.status})`,
    })
    .where(
      and(
        resultEligibleWindow(loss.ownerId, loss.runId),
        evidenceHolds(loss.evidence)
      )
    )
    .returning({ failureDetail: schema.run.failureDetail });

  if (!terminalized) {
    return { lostFrom: null, terminalized: false };
  }
  // SAFETY: written by the statement above, out of the row's own `status`,
  // which the window has just constrained to exactly these two values.
  const { lostFrom } = terminalized.failureDetail as { lostFrom: LostFrom };
  return { lostFrom, terminalized: true };
};
