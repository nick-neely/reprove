// Composition and route wiring only.
import { start } from 'workflow/api';
import {
  createControlPlane,
  claimRun,
  markExecuting,
  type GitHubPort,
  type Phase0RunProfile,
} from '@proto38/control-plane';
import { startDelivery, notifyCancelled } from '@proto38/control-plane-workflow';
import type { FaultProfile } from '@proto38/worker-hosted';
import { hostedRun } from './workflows/hosted-run.ts';

export { hostedRun };

export const PHASE_0_PROFILE: Phase0RunProfile = {
  harness: 'codex',
  model: 'gpt-5-codex',
  strategy: 'standard',
  autonomy: 'verify',
  placement: 'hosted',
  allowHostedFallback: false,
  resolvedConfig: { schemaVersion: 1, thresholdSeverity: 'medium', ignore: ['dist/**'] },
  // A Phase 0 FIXTURE value, not a product default, and scoped to the unclaimed
  // scheduling window only.
  //
  // Five minutes rather than thirty: nothing in Phase 0 - no real Worker, poll
  // cadence, Sandbox startup or user workload - supports thirty, so thirty was a
  // guess dressed as a default, and ADR 0013 exists partly to stop Phase 1
  // inheriting one of those unexamined. Five makes `unscheduled` observable
  // during development and fails visibly if it is too short. Replace it with a
  // measured value before Phase 1.
  claimableFor: '5m',
};

export function composeHosted(opts: { github: GitHubPort; fault?: FaultProfile }) {
  const cp = createControlPlane({
    profile: PHASE_0_PROFILE,
    github: opts.github,
    hostedComposed: true,
  });
  return {
    ...cp,
    startDelivery,
    async dispatchHosted(runId: string, ownerId: number) {
      const claim = await claimRun(runId, ownerId, {
        workerId: null, // a hosted Worker holds no durable identity (ADR 0006)
        protocolVersion: 1,
        workerBuildVersion: '0.0.0-proto38',
      });
      if (claim.claimed !== true)
        return { dispatched: false as const, reason: (claim as { reason: string }).reason };
      const run = await start(hostedRun, [
        claim.spec,
        ownerId,
        claim.leaseToken,
        opts.fault ?? 'clean',
      ]);
      await markExecuting(runId, ownerId, run.runId);
      return {
        dispatched: true as const,
        workflowRunId: run.runId,
        leaseToken: claim.leaseToken,
      };
    },
    notifyCancelled,
  };
}
