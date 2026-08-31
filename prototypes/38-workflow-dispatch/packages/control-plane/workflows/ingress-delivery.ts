// ADR 0013 left two things to #38: the mechanism that kicks a durably received
// delivery into out-of-band processing, and the mandatory automatic re-drive
// for `contended` and `transient` dispositions.
//
// Both are this workflow. Ingress commits the envelope and returns 2xx; the
// work happens here, and Workflow's own step retry *is* the re-drive, so no
// sweeper and no second job system appears beside the one #6 already settled.
//
// Note what crosses into the steps: the Phase0RunProfile travels as a JSON
// argument, because it can, and the GitHub port is resolved by the step from
// its own environment, because it cannot. That split is forced by the compiler,
// not chosen.
import { RetryableError, FatalError } from 'workflow';
import { start } from 'workflow/api';
import { withOwner } from '../db.ts';
import { createRunForDelivery, type Disposition, type Phase0RunProfile } from '../ingress.ts';
import { resolveGitHubPort } from '../step-config.ts';
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
  const out = await createRunForDelivery(deliveryId, ownerId, profile, resolveGitHubPort());
  // `contended` and `transient` are retried by the platform. Throwing is the
  // whole mechanism: there is no Reprove-owned backoff table to get wrong.
  if (out.disposition === 'contended' || out.disposition === 'transient')
    throw new RetryableError(`re-drive: ${out.disposition}`);
  if (out.disposition === 'unauthorized') throw new FatalError('unauthorized delivery');
  return out;
}

/**
 * `start()` has no idempotency key, so a retried step would create a second
 * durable run for the same Reprove Run. The Reprove row is the arbiter: the
 * first writer of `workflow_run_id` wins and the loser cancels its own run.
 */
async function dispatchRun(runId: string, ownerId: number, claimableUntil: string) {
  'use step';
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
