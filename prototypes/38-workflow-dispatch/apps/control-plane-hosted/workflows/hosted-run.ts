// The hosted composition, owned by the app.
//
// ADR 0010's matrix permits an app to depend on both halves, so a step here
// reaches worker-core (through worker-hosted) and Acceptance (through
// control-plane) with no HTTP and no injection. This is the counterexample that
// retired the claim that ADR 0006 had to be reversed: the transport changed,
// the trust boundary did not, and Acceptance is still the only path by which a
// Result enters a Run.
import type { FaultProfile } from '@proto38/worker-hosted';

export async function hostedRun(
  spec: any,
  ownerId: number,
  leaseToken: string,
  fault: FaultProfile,
) {
  'use workflow';
  const executed = await passStep(spec, fault);
  const absorbed = await absorbStep(ownerId, spec.runId, leaseToken, executed);
  return { outcome: executed.kind, absorbed };
}

async function passStep(spec: any, fault: FaultProfile) {
  'use step';
  const { executePass } = await import('@proto38/worker-hosted');
  return executePass(spec, fault);
}

async function absorbStep(ownerId: number, runId: string, leaseToken: string, executed: any) {
  'use step';
  const { stepConfig, notifyAccepted } = await import('@proto38/control-plane-workflow');
  const { acceptResult, acceptRefusal, reportHostedFailure } = await import(
    '@proto38/control-plane/acceptance'
  );
  stepConfig();
  const env = {
    ownerId,
    runId,
    leaseToken,
    protocolVersion: 1,
    rawBody: JSON.stringify(executed.result ?? executed.refusal ?? {}),
  };
  if (executed.kind === 'result') {
    const out = await acceptResult(env);
    if (out.accepted) await notifyAccepted(runId, ownerId, out.status);
    return out;
  }
  if (executed.kind === 'refusal') return acceptRefusal(env);
  // A Failure is signalled, not submitted. The control plane decides whether
  // the Run is still eligible; this step never writes status itself.
  const failed = await reportHostedFailure({ ownerId, runId, leaseToken, code: executed.code });
  return { accepted: false, rejection: `internal_failure:${executed.code}`, failed };
}
