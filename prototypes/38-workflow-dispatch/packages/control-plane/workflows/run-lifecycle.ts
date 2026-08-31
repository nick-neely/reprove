// The Run's durable spine, owned by @proto38/control-plane.
//
// It schedules; it does not decide. Acceptance has already written the Run's
// terminal status by the time the result hook resumes this run, so the
// workflow never becomes a second source of truth about a Run's outcome. That
// is what keeps ADR 0006's stale-result boundary in the database, where it
// holds against a Worker that is buggy, partitioned or hostile.
import { createHook, sleep } from 'workflow';
import { withOwner } from '../db.ts';

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
  await withOwner(ownerId, (c) =>
    c.query(`update run set status = 'queued' where id = $1 and status = 'queued'`, [runId]),
  );
  return runId;
}

/**
 * The only state this workflow owns is the deadline. `unscheduled` is the one
 * terminal status no other actor can write, because it means "nobody ever
 * claimed this" - and it is conditional on the Run still being live, so a
 * Result accepted microseconds before the deadline still wins.
 */
async function settle(runId: string, ownerId: number, outcome: LifecycleOutcome) {
  'use step';
  if (outcome.kind !== 'deadline') return;
  await withOwner(ownerId, (c) =>
    c.query(
      `update run set status = 'unscheduled', failure_reason = 'claimable_deadline_expired'
        where id = $1 and status in ('queued','claimed','executing')`,
      [runId],
    ),
  );
}
