// @proto38/control-plane-workflow - all durable orchestration, and all step
// configuration.
//
// @proto38/control-plane holds the substance and knows nothing about Workflow;
// this package holds the workflow and step definitions and the environment they
// read.
//
// The constraint behind the split is real: a step is compiled into a bundle
// whose module graph is fixed at build time, so the layer that defines steps is
// the only layer that can reliably configure them. But the split is a CHOSEN
// TRADEOFF, not a forced move, and an earlier draft overstated it. Two
// alternatives remain technically possible: keep the definitions in the core
// package behind a documented no-fallback environment contract, or duplicate
// them in each app. This package wins because shared orchestration outweighs the
// cost of one more published-by-necessity package, and because ADR 0010 requires
// Cloud to consume published artifacts rather than duplicate control-plane
// substance.
//
// The name is qualified deliberately. `Adapter` is already a CONTEXT.md noun -
// Reprove's per-Harness code - so naming an orchestration package after it would
// collide with the domain vocabulary. Per naming rule 4, Vercel's word is the one
// that gets qualified at the seam.
import { start } from 'workflow/api';
import {
  claimRun,
  withOwner,
  type Phase0RunProfile,
  type RunSpecLike,
} from '@proto38/control-plane';
import { ingressDelivery } from './workflows/ingress-delivery.ts';
import { acceptedToken, cancelledToken } from './workflows/run-lifecycle.ts';

export * from './workflows/index.ts';
export { stepConfig, ADAPTER_ENV } from './config.ts';

export type HostedDispatcher = {
  readonly protocolVersion: number;
  readonly workerBuildVersion: string;
  dispatch(spec: unknown, ingest: unknown): Promise<{ workflowRunId: string }>;
  cancel(workflowRunId: string): Promise<void>;
};

/** Ingress commits the envelope; this moves it onto the durable spine. */
export async function startDelivery(
  deliveryId: number,
  ownerId: number,
  profile: Phase0RunProfile,
) {
  return start(ingressDelivery, [deliveryId, ownerId, profile]);
}

/**
 * Resolve the lifecycle the Run currently records, then resume its hook.
 *
 * A notifier cannot derive a hook token from the Run id alone now that tokens
 * are lifecycle-scoped, and that is the point: the database decides which
 * lifecycle owns the Run, so the database is what a notification must consult.
 * An orphaned lifecycle is never notified, because it is never recorded.
 */
async function currentLifecycle(runId: string, ownerId: number): Promise<string | null> {
  return withOwner(ownerId, async (c) => {
    const r = await c.query(`select workflow_run_id from run where id = $1`, [runId]);
    return (r.rows[0]?.workflow_run_id as string | null) ?? null;
  });
}

export async function notifyAccepted(
  runId: string,
  ownerId: number,
  status: 'completed' | 'incomplete',
) {
  const wf = await currentLifecycle(runId, ownerId);
  if (!wf) return { notified: false as const, reason: 'no_recorded_lifecycle' };
  const { resumeHook } = await import('workflow/api');
  await resumeHook(acceptedToken(runId, wf), { status });
  return { notified: true as const, workflowRunId: wf };
}

export async function notifyCancelled(runId: string, ownerId: number, reason: string) {
  const wf = await currentLifecycle(runId, ownerId);
  if (!wf) return { notified: false as const, reason: 'no_recorded_lifecycle' };
  const { resumeHook } = await import('workflow/api');
  await resumeHook(cancelledToken(runId, wf), { reason });
  return { notified: true as const, workflowRunId: wf };
}

export { claimRun };
export type { Phase0RunProfile, RunSpecLike };
