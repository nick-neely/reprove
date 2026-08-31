// @proto38/control-plane
//
// The whole substance of the control plane lives here, never in route
// handlers, and nothing in this package can reach a Harness: the dependency
// matrix in tools/boundary.ts is what proves it rather than this comment.
//
// Hosted execution is *composed in*, not depended on. `createControlPlane`
// takes an optional HostedDispatcher; the self-hosted deployment passes none
// and the same code path leaves the Run queued for a self-hosted Worker.
import { randomUUID } from 'node:crypto';
import { resumeHook } from 'workflow/api';
import type { RunSpec } from '@proto38/protocol/v1';
import { withOwner } from './db.ts';
import type { GitHubPort, Phase0RunProfile } from './ingress.ts';
import {
  acceptResult,
  acceptRefusal,
  PROTOCOL_CURRENT,
  PROTOCOL_MINIMUM,
  type AcceptanceOutcome,
} from './acceptance.ts';

export * from './acceptance.ts';
export * from './ingress.ts';
export * from './db.ts';
export { runLifecycle } from './workflows/run-lifecycle.ts';
export { ingressDelivery } from './workflows/ingress-delivery.ts';

/**
 * The seam worker-hosted implements. It is deliberately the *whole* surface:
 * a Phase 0 Worker is RunSpec in, Result or Refusal back through the same
 * ingest a self-hosted Worker will POST to. No claim, lease, progress or
 * cancellation message crosses it, because #32 kept those out of v1 until an
 * execution path proves them.
 */
export type HostedDispatcher = {
  readonly protocolVersion: number;
  readonly workerBuildVersion: string;
  /**
   * Returns as soon as execution is durably scheduled, never when it finishes.
   * Everything it receives is JSON, because a workflow's arguments are the only
   * thing that survives into a step bundle.
   */
  dispatch(
    spec: RunSpec,
    ingest: { resultUrl: string; refusalUrl: string; token: string; ownerId: number },
  ): Promise<{ workflowRunId: string }>;
  /** Control-plane-owned cancellation, delivered into the hosted execution. */
  cancel(workflowRunId: string): Promise<void>;
};

export type ControlPlaneConfig = {
  profile: Phase0RunProfile;
  /**
   * Used only on the request path. A workflow step resolves its own port from
   * the environment (see step-config.ts); this one cannot reach it.
   */
  github: GitHubPort;
  /** Absent in the self-hosted composition. Its absence is the whole difference. */
  hosted?: HostedDispatcher;
  /** Where a Worker - hosted or self-hosted - submits. */
  ingestBaseUrl: string;
};

let cfg: ControlPlaneConfig;

export function createControlPlane(config: ControlPlaneConfig) {
  cfg = config;
  return {
    receiveDelivery,
    startDelivery,
    dispatchHosted,
    claimRun,
    submitResult,
    submitRefusal,
    supersedeTo,
    protocol: { current: PROTOCOL_CURRENT, minimum: PROTOCOL_MINIMUM },
    hostedComposed: Boolean(config.hosted),
  };
}

export function controlPlane() {
  return cfg;
}

/**
 * The webhook handler. It commits a bounded envelope and nothing else, then
 * returns. If it cannot commit, it must return non-2xx, because GitHub never
 * auto-redelivers (ADR 0013).
 */
export async function receiveDelivery(env: {
  ownerId: number;
  installationId: number;
  repositoryId: number;
  repositoryLocator: string;
  pullRequestNumber: number;
  event: string;
  action: string;
  deliveryGuid: string;
}): Promise<{ deliveryId: number; duplicate: boolean }> {
  return withOwner(env.ownerId, async (c) => {
    const w = await c.query(
      `insert into ingress_delivery
         (owner_id, installation_id, repository_id, repository_locator,
          pull_request_number, event, action, delivery_guid, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'received')
       on conflict (delivery_guid) do nothing
       returning id`,
      [
        env.ownerId,
        env.installationId,
        env.repositoryId,
        env.repositoryLocator,
        env.pullRequestNumber,
        env.event,
        env.action,
        env.deliveryGuid,
      ],
    );
    if (w.rowCount === 1) return { deliveryId: Number(w.rows[0].id), duplicate: false };
    // ADR 0013's stateful GUID rule: a redelivery of a terminal ledger entry
    // is a no-op; a nonterminal one is re-kicked rather than ignored.
    const prior = await c.query(`select id, state from ingress_delivery where delivery_guid = $1`, [
      env.deliveryGuid,
    ]);
    return {
      deliveryId: Number(prior.rows[0].id),
      duplicate: prior.rows[0].state !== 'received',
    };
  });
}

/**
 * Claim. Phase 0 has no wire claim message, so this is control-plane state
 * shared by both placements: the hosted dispatcher calls it in-process, and a
 * self-hosted Worker will later reach the same function over HTTP.
 */
export async function claimRun(
  runId: string,
  ownerId: number,
  claimant: { workerId: string | null; protocolVersion: number; workerBuildVersion: string },
): Promise<{ claimed: true; leaseToken: string; spec: RunSpec } | { claimed: false; reason: string }> {
  if (claimant.protocolVersion < PROTOCOL_MINIMUM || claimant.protocolVersion > PROTOCOL_CURRENT)
    return {
      claimed: false,
      reason: `upgrade_required minimum=${PROTOCOL_MINIMUM} actual=${claimant.protocolVersion}`,
    };

  return withOwner(ownerId, async (c) => {
    const leaseToken = `lease_${randomUUID().slice(0, 12)}`;
    const w = await c.query(
      `update run
          set status = 'claimed', lease_token = $1, worker_id = $2,
              protocol_version = $3, worker_build_version = $4
        where id = $5 and owner_id = $6 and status = 'queued'
          and claimable_until > now()
        returning spec`,
      [
        leaseToken,
        claimant.workerId,
        claimant.protocolVersion,
        claimant.workerBuildVersion,
        runId,
        ownerId,
      ],
    );
    if (w.rowCount !== 1) return { claimed: false as const, reason: 'not_claimable' };
    return { claimed: true as const, leaseToken, spec: w.rows[0].spec as RunSpec };
  });
}

/**
 * The single ingest path. Acceptance decides; the hook only reports.
 *
 * The two are deliberately not one await: the database write is what makes the
 * Result accepted, and resuming the durable run is a notification that follows
 * it. A route that resumed before responding would also be re-entering the
 * workflow runtime from inside a request the runtime is waiting on.
 */
export async function submitResult(env: {
  ownerId: number;
  runId: string;
  leaseToken: string;
  protocolVersion: number;
  rawBody: string;
}): Promise<AcceptanceOutcome> {
  return acceptResult(env);
}

/** Called after the ingest response is written, never before Acceptance commits. */
export async function notifyLifecycle(outcome: AcceptanceOutcome) {
  if (!outcome.accepted) return;
  await resumeHook(`run:${outcome.runId}:accepted`, { status: outcome.status }).catch(() => {});
}

export async function submitRefusal(env: {
  ownerId: number;
  runId: string;
  leaseToken: string;
  protocolVersion: number;
  rawBody: string;
}): Promise<AcceptanceOutcome> {
  return acceptRefusal(env);
}

/**
 * Supersession is control-plane-owned because only the control plane sees the
 * sequence of pushes.
 *
 * Cancellation then rides two *different* mechanisms, because a Run has two
 * durable runs and they need opposite treatment. The lifecycle run must reach
 * a terminal state it can report, so it is resumed through its cancel hook and
 * returns normally. The hosted pass is work to abandon, so it is cancelled
 * outright. Cancelling the lifecycle instead - the bug this prototype caught -
 * makes the Run's own schedule throw rather than resolve, and leaves the Worker
 * running.
 *
 * Neither mechanism is load-bearing for correctness. Acceptance already
 * refuses a superseded Run's Result whatever the Worker does.
 */
export async function supersedeTo(runIds: string[], ownerId: number, reason: string) {
  const rows = await withOwner(ownerId, async (c) => {
    const r = await c.query(
      `select id, workflow_run_id, hosted_workflow_run_id
         from run where id = any($1::text[]) and owner_id = $2`,
      [runIds, ownerId],
    );
    return r.rows as {
      id: string;
      workflow_run_id: string | null;
      hosted_workflow_run_id: string | null;
    }[];
  });
  for (const r of rows) {
    await resumeHook(`run:${r.id}:cancelled`, { reason }).catch(() => {});
    if (cfg.hosted && r.hosted_workflow_run_id)
      await cfg.hosted.cancel(r.hosted_workflow_run_id).catch(() => {});
  }
  return rows.map((r) => r.id);
}

/**
 * The request-path half of ingress: commit the envelope, then hand it to the
 * durable spine. The profile crosses as a workflow argument because a step
 * cannot be handed one any other way.
 */
export async function startDelivery(deliveryId: number, ownerId: number) {
  const { ingressDelivery } = await import('./workflows/ingress-delivery.ts');
  const { start } = await import('workflow/api');
  return start(ingressDelivery, [deliveryId, ownerId, cfg.profile]);
}

/**
 * Dispatch to the hosted Worker. The control plane claims on its behalf,
 * because ADR 0006 says a hosted Worker holds no durable identity and never
 * claims, polls or leases - and Phase 0 has no wire claim message at all.
 */
export async function dispatchHosted(runId: string, ownerId: number) {
  if (!cfg.hosted) return { dispatched: false as const, reason: 'no_hosted_composition' };
  const claim = await claimRun(runId, ownerId, {
    workerId: null,
    protocolVersion: cfg.hosted.protocolVersion,
    workerBuildVersion: cfg.hosted.workerBuildVersion,
  });
  if (!claim.claimed) return { dispatched: false as const, reason: claim.reason };
  const { workflowRunId } = await cfg.hosted.dispatch(claim.spec, {
    resultUrl: `${cfg.ingestBaseUrl}/v1/runs/${runId}/result`,
    refusalUrl: `${cfg.ingestBaseUrl}/v1/runs/${runId}/refusal`,
    token: claim.leaseToken,
    ownerId,
  });
  await withOwner(ownerId, (c) =>
    c.query(
      `update run set status = 'executing', hosted_workflow_run_id = $2
        where id = $1 and status = 'claimed'`,
      [runId, workflowRunId],
    ),
  );
  return { dispatched: true as const, workflowRunId, leaseToken: claim.leaseToken };
}
