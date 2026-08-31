// @proto38/control-plane
//
// Substance only. It owns ingress, Run creation, claim, Acceptance and
// supersession, and it knows nothing about Workflow: no `workflow` dependency,
// no workflow or step definitions, and no environment variables. All durable
// orchestration lives in @proto38/control-plane-workflow.
//
// That split is not tidiness. A step is compiled into a bundle whose module
// graph is fixed at build time, so the layer that defines steps is the only
// layer that can reliably configure them - and this package must stay
// configurable by its caller, per ADR 0010.
import { randomUUID } from 'node:crypto';
import type { RunSpec } from '@proto38/protocol/v1';
import { withOwner } from './db.ts';
import type { GitHubPort, Phase0RunProfile } from './ingress.ts';
import { PROTOCOL_CURRENT, PROTOCOL_MINIMUM } from './acceptance.ts';

export * from './acceptance.ts';
export * from './ingress.ts';
export * from './db.ts';
export type RunSpecLike = RunSpec;

export type ControlPlaneConfig = {
  profile: Phase0RunProfile;
  /** Used on the request path. A step resolves its own; see the adapter. */
  github: GitHubPort;
  /** Present only in a hosted composition. Its absence is the difference. */
  hostedComposed?: boolean;
};

let cfg: ControlPlaneConfig;

export function createControlPlane(config: ControlPlaneConfig) {
  cfg = config;
  return {
    profile: config.profile,
    protocol: { current: PROTOCOL_CURRENT, minimum: PROTOCOL_MINIMUM },
    hostedComposed: Boolean(config.hostedComposed),
  };
}

export function controlPlane() {
  return cfg;
}

/**
 * The webhook handler. It commits a bounded envelope and nothing else, then
 * returns. If it cannot commit it must return non-2xx, because GitHub never
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
    const prior = await c.query(`select id, state from ingress_delivery where delivery_guid = $1`, [
      env.deliveryGuid,
    ]);
    return { deliveryId: Number(prior.rows[0].id), duplicate: prior.rows[0].state !== 'received' };
  });
}

/**
 * Claim. Phase 0 has no wire claim message (#32), so this is control-plane
 * state shared by both placements: a hosted dispatch calls it in-process, and a
 * self-hosted Worker will later reach the same function over HTTP.
 */
export async function claimRun(
  runId: string,
  ownerId: number,
  claimant: { workerId: string | null; protocolVersion: number; workerBuildVersion: string },
): Promise<
  { claimed: true; leaseToken: string; spec: RunSpec } | { claimed: false; reason: string }
> {
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

/** Mark a Run executing and record which hosted run is executing it. */
export async function markExecuting(runId: string, ownerId: number, hostedWorkflowRunId: string) {
  return withOwner(ownerId, (c) =>
    c.query(
      `update run set status = 'executing', hosted_workflow_run_id = $2
        where id = $1 and status = 'claimed'`,
      [runId, hostedWorkflowRunId],
    ),
  );
}

/**
 * Supersession is control-plane-owned, because only the control plane sees the
 * sequence of pushes. It writes the status and reports which durable runs the
 * caller should now cancel; delivering that cancellation belongs to the layer
 * that owns Workflow. Neither is load-bearing for correctness, because
 * Acceptance already refuses a superseded Run's Result.
 */
export async function supersedeRuns(runIds: string[], ownerId: number) {
  return withOwner(ownerId, async (c) => {
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
}
