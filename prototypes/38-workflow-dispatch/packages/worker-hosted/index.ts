// @proto38/worker-hosted - the hosted execution lifecycle.
//
// It may depend on worker-core, protocol and workflow, and on nothing of the
// control plane's. The HostedDispatcher shape it satisfies is declared by the
// control plane; this package never imports that declaration, because the two
// only meet in the app.
import { start, getRun } from 'workflow/api';
import { PROTOCOL_VERSION } from '@proto38/protocol/v1';
import { WORKER_BUILD_VERSION, type FaultProfile } from '@proto38/worker-core';
import { hostedPass, type Ingest } from './workflows/hosted-pass.ts';

export type { Ingest };
export { hostedPass };

export function createHostedDispatcher(opts: { fault?: FaultProfile } = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    workerBuildVersion: WORKER_BUILD_VERSION,
    async dispatch(spec: unknown, ingest: Ingest) {
      const run = await start(hostedPass, [spec, ingest, opts.fault ?? 'clean']);
      return { workflowRunId: run.runId };
    },
    async cancel(workflowRunId: string) {
      await getRun(workflowRunId).cancel();
    },
  };
}
