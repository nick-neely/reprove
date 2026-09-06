/**
 * Waking a Run's lifecycle, after the control plane has already decided.
 *
 * [ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md): "the
 * database write is what makes a Result accepted. Resuming the durable run is a
 * notification that follows it." The same order holds for a supersession or a
 * cancellation: the status is committed by the transaction that decided it,
 * and this is called afterwards, from the orchestration package, with nothing
 * left for the notification to decide.
 *
 * It reads the **currently recorded** lifecycle from the database before it
 * resumes anything, because hook tokens are scoped to the lifecycle rather
 * than to the Run. An orphaned lifecycle is never notified, because it was
 * never recorded; a Run with no recorded lifecycle yet is not notified either,
 * and its lifecycle finds the decision at its next wake.
 *
 * A notification that cannot be delivered is reported, not thrown. The
 * lifecycle's deadline still bounds the Run, so a lost notification costs
 * latency and never correctness - which is what lets this be called from a step
 * without turning a cosmetic failure into a failed workflow run.
 */
import { resumeHook } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";

import { controlPlane } from "./composition.js";
import type { LifecycleSignal } from "./lifecycle.js";
import { lifecycleToken } from "./lifecycle.js";

/** What became of one notification. */
export type Notified =
  | {
      readonly runId: string;
      readonly notified: true;
      readonly workflowRunId: string;
    }
  | {
      readonly runId: string;
      readonly notified: false;
      /**
       * `no_recorded_lifecycle` - the Run is not visible or nothing has been
       * recorded for it yet; `no_open_hook` - the recorded lifecycle has no
       * hook open under its token, because it has not reached the hook yet or
       * has already ended.
       */
      readonly reason: "no_recorded_lifecycle" | "no_open_hook";
    };

/**
 * Wakes the lifecycle the Run records, if there is one to wake.
 *
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run whose status the control plane has already written.
 * @param reason Why the lifecycle should look.
 * @returns Whether a lifecycle was woken, and which.
 */
export const notifyLifecycle = async (
  ownerId: number,
  runId: string,
  reason: LifecycleSignal["reason"]
): Promise<Notified> => {
  const plane = await controlPlane();
  const schedule = await plane.lifecycle.schedule(ownerId, runId);
  const workflowRunId = schedule?.workflowRunId ?? null;
  if (workflowRunId === null) {
    return { runId, notified: false, reason: "no_recorded_lifecycle" };
  }

  const signal: LifecycleSignal = { reason };
  try {
    await resumeHook(lifecycleToken(runId, workflowRunId), signal);
  } catch (error) {
    if (HookNotFoundError.is(error) || WorkflowRunNotFoundError.is(error)) {
      return { runId, notified: false, reason: "no_open_hook" };
    }
    throw error;
  }
  return { runId, notified: true, workflowRunId };
};
