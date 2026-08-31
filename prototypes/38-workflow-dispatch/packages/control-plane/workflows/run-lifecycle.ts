// The Run's durable spine, owned by @proto38/control-plane.
//
// It schedules; it does not decide. Acceptance has already written the Run's
// terminal status by the time the result hook resumes this run, so the
// workflow never becomes a second source of truth about a Run's outcome. That
// is what keeps ADR 0006's stale-result boundary in the database, where it
// holds against a Worker that is buggy, partitioned or hostile.
import { createHook, sleep, getWorkflowMetadata } from 'workflow';

// NOT a static import of ../db.ts.
//
// Every workflow in an app is compiled into ONE shared workflow bundle, which
// inlines the entire transitive static import graph and externalizes nothing.
// `pg` is CommonJS, so a single static `import { withOwner } from '../db.ts'`
// anywhere in that graph puts `require(...)` into a VM that has none - and it
// breaks every *other* workflow in the app too, not just this one. A dynamic
// import inside a step body is outside the static graph, so the workflow
// bundle never sees it and the step resolves it at runtime.
async function dbApi() {
  return import('../db.ts');
}

export type LifecycleOutcome =
  | { kind: 'accepted'; status: 'completed' | 'incomplete' }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'deadline' };

export async function runLifecycle(
  runId: string,
  ownerId: number,
  claimableUntilIso: string,
): Promise<LifecycleOutcome> {
  'use workflow';

  await markDispatched(runId, ownerId);

  using accepted = createHook<{ status: 'completed' | 'incomplete' }>({
    token: `run:${runId}:accepted`,
  });
  using cancelled = createHook<{ reason: string }>({ token: `run:${runId}:cancelled` });

  const outcome: LifecycleOutcome = await Promise.race([
    accepted.then((p) => ({ kind: 'accepted' as const, status: p.status })),
    cancelled.then((p) => ({ kind: 'cancelled' as const, reason: p.reason })),
    sleep(new Date(claimableUntilIso)).then(() => ({ kind: 'deadline' as const })),
  ]);

  await settle(runId, ownerId, outcome);
  return outcome;
}

async function markDispatched(runId: string, ownerId: number) {
  'use step';
  const { withOwner } = await dbApi();
  await withOwner(ownerId, (c) =>
    c.query(`update run set status = 'queued' where id = $1 and status = 'queued'`, [runId]),
  );
  return runId;
}

/**
 * `start()` takes no idempotency key and no caller-supplied run id, so the
 * window between starting a lifecycle and recording its id on the Run cannot be
 * closed - a crash inside it orphans a durable run that no conditional update
 * can find, and the retry starts a second one.
 *
 * The answer is not to prevent the orphan but to make it inert. Every write
 * this workflow performs is conditional on it being the Run's *current*
 * lifecycle, which an orphan never became. An orphan then wakes at its deadline,
 * matches nothing, and ends - which is exactly what should happen to a durable
 * run nobody is listening to.
 */
function ownWorkflowRunId(): string {
  return getWorkflowMetadata().workflowRunId;
}

/**
 * The only state this workflow owns is the deadline, and the deadline means two
 * different things depending on how far the Run got.
 *
 * ADR 0007 defines `unscheduled` as "claimableUntil expired; never dispatched",
 * and CONTEXT.md reserves Failure for a Run that began executing. So the
 * deadline may only write `unscheduled` over a Run that was never dispatched.
 * An `executing` Run whose deadline expires is a Worker that stopped answering:
 * that is ADR 0006's `worker_lost`, which is a Failure, not a scheduling
 * outcome. Writing `unscheduled` over it - which this prototype did until the
 * adversarial review caught it - states that nothing ran, about a Run that ran.
 *
 * Both writes stay conditional on the Run still being live, so a Result
 * accepted microseconds before the deadline still wins.
 */
async function settle(runId: string, ownerId: number, outcome: LifecycleOutcome) {
  'use step';
  if (outcome.kind !== 'deadline') return;
  const mine = ownWorkflowRunId();
  const { withOwner } = await dbApi();
  await withOwner(ownerId, async (c) => {
    await c.query(
      `update run set status = 'unscheduled', failure_reason = 'claimable_deadline_expired'
        where id = $1 and status in ('queued','claimed') and workflow_run_id = $2`,
      [runId, mine],
    );
    await c.query(
      `update run set status = 'failed', failure_reason = 'worker_lost'
        where id = $1 and status = 'executing' and workflow_run_id = $2`,
      [runId, mine],
    );
  });
}
