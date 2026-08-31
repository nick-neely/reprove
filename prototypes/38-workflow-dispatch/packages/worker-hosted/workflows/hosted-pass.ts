// The hosted execution lifecycle, as its own durable run.
//
// Everything it needs crosses as JSON: the RunSpec, the ingest URL the control
// plane minted for this Run, and the lease-bound token that authorizes exactly
// one submission against it. Nothing is injected, because nothing can be - a
// step is compiled into its own bundle and cannot see the composition root.
//
// The upshot is that the hosted Worker reaches Acceptance the same way a
// self-hosted Worker will: an outbound authenticated POST to a Reprove-owned
// endpoint. ADR 0006 rejected that as symmetry for its own sake; the step
// boundary turns it from a preference into the only shape that keeps
// worker-hosted off the control plane's dependency list.
import { PROTOCOL_VERSION, type Result, type Refusal } from '@proto38/protocol/v1';
import { executeRun, WORKER_BUILD_VERSION, type FaultProfile } from '@proto38/worker-core';

export type Ingest = { resultUrl: string; refusalUrl: string; token: string; ownerId: number };

export async function hostedPass(spec: unknown, ingest: Ingest, fault: FaultProfile) {
  'use workflow';
  const executed = await executeStep(spec, fault);
  const submitted = await submitStep(ingest, executed);
  return { outcome: executed.kind, submitted };
}

/**
 * Stands in for the many short steps a real Pass decomposes into, each under
 * the Function ceiling with the Sandbox outliving them. #35 owns that seam;
 * what matters here is that worker-core is reached from this package and never
 * from the control plane's.
 */
async function executeStep(spec: unknown, fault: FaultProfile) {
  'use step';
  return executeRun(spec, fault);
}

async function submitStep(
  ingest: Ingest,
  executed: { kind: string; result?: Result; refusal?: Refusal; code?: string },
) {
  'use step';
  if (executed.kind === 'failure')
    // Failure has no v1 wire form (#35). Nothing is submitted; the Run reaches
    // its claimable deadline rather than being terminated by a wire message.
    return { submitted: false, reason: `internal_failure:${executed.code}` };

  const url = executed.kind === 'result' ? ingest.resultUrl : ingest.refusalUrl;
  const body = JSON.stringify(executed.kind === 'result' ? executed.result : executed.refusal);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ingest.token}`,
      'x-reprove-protocol-version': String(PROTOCOL_VERSION),
      'x-reprove-worker-build': WORKER_BUILD_VERSION,
      // Stands in for the tenant the control plane resolves from the
      // credential. It is never trusted: Acceptance checks it against the Run.
      'x-reprove-owner': String(ingest.ownerId),
    },
    body,
  });
  return { submitted: true, status: res.status, body: await res.json() };
}
