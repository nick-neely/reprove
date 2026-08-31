// The Run's durable schedule, owned by the app-layer adapter.
//
// It schedules; it does not decide. Acceptance has already written the Run's
// terminal status by the time the accepted hook resumes this run, so the
// workflow never becomes a second source of truth about a Run's outcome.
import { createHook, sleep, getWorkflowMetadata } from 'workflow';
// Static imports, used only inside step bodies.
//
// An earlier revision made these dynamic, on the belief that the workflow
// bundle inlines everything reachable from the module. It does not. It inlines
// what the WORKFLOW FUNCTION BODY reaches - module-scope helpers it calls
// included - and excludes step bodies entirely. `nextcheck` measures this: a
// helper called from the workflow body takes the emitted bundle from 103KB to
// 1176KB and breaks it, while these static imports leave it at 103KB.
import { withOwner } from '@proto38/control-plane/db';
import { stepConfig } from '../config.ts';

export type LifecycleOutcome =
  | { kind: 'accepted'; status: 'completed' | 'incomplete' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'deadline' };

/**
 * Hook tokens are scoped to the LIFECYCLE, not to the Run.
 *
 * The SDK enforces globally unique hook tokens: a second run that creates a
 * hook with a token already held receives `HookConflictError`. A Run-scoped
 * token therefore breaks exactly when two lifecycles exist for one Run - the
 * `start()` orphan window - and it breaks the wrong way round, because the
 * orphan starts first, holds the token, and the lifecycle that is actually
 * recorded on the Run is the one that dies.
 *
 * Scoping the token to `workflowRunId` removes the collision. The cost is that
 * a notifier can no longer derive the token from the Run id alone: it must read
 * the currently recorded lifecycle from the database first. That is the correct
 * dependency direction anyway, since the database is what decides which
 * lifecycle owns the Run.
 */
export function acceptedToken(runId: string, workflowRunId: string) {
  return `run:${runId}:${workflowRunId}:accepted`;
}
export function cancelledToken(runId: string, workflowRunId: string) {
  return `run:${runId}:${workflowRunId}:cancelled`;
}

export async function runLifecycle(
  runId: string,
  ownerId: number,
  claimableUntilIso: string,
): Promise<LifecycleOutcome> {
  'use workflow';
  const mine = getWorkflowMetadata().workflowRunId;

  await markDispatched(runId, ownerId);

  using accepted = createHook<{ status: 'completed' | 'incomplete' }>({
    token: acceptedToken(runId, mine),
  });
  using cancelled = createHook<{ reason: string }>({ token: cancelledToken(runId, mine) });

  const outcome: LifecycleOutcome = await Promise.race([
    accepted.then((p) => ({ kind: 'accepted' as const, status: p.status })),
    cancelled.then((p) => ({ kind: 'cancelled' as const, reason: p.reason })),
    sleep(new Date(claimableUntilIso)).then(() => ({ kind: 'deadline' as const })),
  ]);

  await settle(runId, ownerId, mine, outcome);
  return outcome;
}

async function markDispatched(runId: string, ownerId: number) {
  'use step';
  stepConfig();
  await withOwner(ownerId, (c) =>
    c.query(`update run set status = 'queued' where id = $1 and status = 'queued'`, [runId]),
  );
  return runId;
}

/**
 * `claimableUntil` bounds when a Run may be CLAIMED, and nothing else.
 *
 * An earlier revision let this deadline write `worker_lost` over an executing
 * Run. That is the wrong owner: ADR 0006 gives the liveness of an executing Run
 * to the Lease, and a hosted Worker that disappears needs its own completion
 * signal. Diagnosing execution from a scheduling deadline would report a slow
 * Worker as a dead one.
 *
 * So this writes exactly one transition, over a Run that was never claimed, and
 * only when this lifecycle is the one the Run records. A Run that is claimed or
 * executing when the deadline expires is left alone, deliberately - see the
 * README and the ticket handed on for who must own that.
 */
async function settle(
  runId: string,
  ownerId: number,
  mine: string,
  outcome: LifecycleOutcome,
) {
  'use step';
  if (outcome.kind !== 'deadline') return;
  stepConfig();
  await withOwner(ownerId, (c) =>
    c.query(
      `update run set status = 'unscheduled', failure_reason = 'claimable_deadline_expired'
        where id = $1 and status = 'queued' and workflow_run_id = $2`,
      [runId, mine],
    ),
  );
}
