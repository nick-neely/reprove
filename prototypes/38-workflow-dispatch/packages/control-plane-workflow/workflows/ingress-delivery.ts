// ADR 0013 left two things to #38: the mechanism that moves a durably received
// delivery into out-of-band processing, and the mandatory automatic re-drive
// for `contended` and `transient` dispositions. Both are this workflow, and the
// re-drive is Workflow's own step retry rather than a Reprove sweeper.
import { RetryableError, FatalError } from 'workflow';
import { start } from 'workflow/api';
import type { Disposition, Phase0RunProfile } from '@proto38/control-plane';
// Static, and used only inside step bodies. See run-lifecycle.ts.
import { createRunForDelivery } from '@proto38/control-plane';
import { withOwner } from '@proto38/control-plane/db';
import { stepConfig } from '../config.ts';
import { runLifecycle } from './run-lifecycle.ts';

export async function ingressDelivery(
  deliveryId: number,
  ownerId: number,
  profile: Phase0RunProfile,
) {
  'use workflow';
  const processed = await processDelivery(deliveryId, ownerId, profile);
  let dispatch: { workflowRunId: string | null; duplicateCancelled: string | null } | null = null;
  if (processed.runId)
    dispatch = await dispatchRun(processed.runId, ownerId, processed.claimableUntil!);
  await closeLedger(deliveryId, ownerId, processed.disposition);
  return { ...processed, dispatch };
}

async function processDelivery(deliveryId: number, ownerId: number, profile: Phase0RunProfile) {
  'use step';
  const { github } = stepConfig();
  const out = await createRunForDelivery(deliveryId, ownerId, profile, github);
  if (out.disposition === 'contended' || out.disposition === 'transient')
    throw new RetryableError(`re-drive: ${out.disposition}`);
  if (out.disposition === 'unauthorized') throw new FatalError('unauthorized delivery');
  return out;
}

/**
 * `start()` takes no idempotency key and no caller-supplied run id, so the
 * window between starting a lifecycle and recording its id cannot be closed: a
 * crash inside it orphans a durable run the retry cannot find. The Reprove row
 * arbitrates - first writer of `workflow_run_id` wins - and the loser cancels
 * its own run. Hook tokens are lifecycle-scoped so the two never collide.
 */
async function dispatchRun(runId: string, ownerId: number, claimableUntil: string) {
  'use step';
  stepConfig();
  const run = await start(runLifecycle, [runId, ownerId, claimableUntil]);
  const claimed = await withOwner(ownerId, (c) =>
    c.query(
      `update run set workflow_run_id = $1 where id = $2 and workflow_run_id is null returning id`,
      [run.runId, runId],
    ),
  );
  if (claimed.rowCount !== 1) {
    await run.cancel();
    return { workflowRunId: null, duplicateCancelled: run.runId };
  }
  return { workflowRunId: run.runId, duplicateCancelled: null };
}

async function closeLedger(deliveryId: number, ownerId: number, disposition: Disposition) {
  'use step';
  stepConfig();
  await withOwner(ownerId, (c) =>
    c.query(
      `update ingress_delivery
          set state = case when $1 = 'discarded' then 'discarded' else 'done' end,
              disposition = $1
        where id = $2`,
      [disposition, deliveryId],
    ),
  );
}
