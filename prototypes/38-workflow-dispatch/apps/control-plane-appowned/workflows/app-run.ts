// The composition the adversarial review proposed, and the reason ADR 0006
// does not have to be reversed.
//
// The app may depend on both @proto38/control-plane and @proto38/worker-hosted
// (ADR 0010's matrix allows exactly that), so an app-owned step can import both
// statically. Static imports are bundled *with* the step, so there is nothing to
// inject and nothing has to cross a module-instance boundary. No HTTP, no
// environment access inside the core package, and neither package depends on
// the other.
import { acceptResult, acceptRefusal, reportHostedFailure } from '@proto38/control-plane';
import { executePass } from '@proto38/worker-hosted';
import { PROTOCOL_VERSION } from '@proto38/protocol/v1';
import { appConfig } from '../config.ts';

export async function appOwnedRun(
  spec: any,
  ownerId: number,
  leaseToken: string,
  fault: 'clean' | 'partial' | 'refuse-isolation' | 'internal-failure',
) {
  'use workflow';
  const executed = await passStep(spec, fault);
  const absorbed = await absorbStep(ownerId, spec.runId, leaseToken, executed);
  return { outcome: executed.kind, absorbed };
}

async function passStep(spec: any, fault: any) {
  'use step';
  return executePass(spec, fault);
}

/**
 * Acceptance still runs control-plane-side and is still the only path that
 * absorbs a Result. What changed is the transport - a function call in the same
 * bundle instead of an authenticated POST - not the trust boundary.
 */
async function absorbStep(ownerId: number, runId: string, leaseToken: string, executed: any) {
  'use step';
  appConfig(); // the app's own module, statically imported, so it is in this bundle
  const env = {
    ownerId,
    runId,
    leaseToken,
    protocolVersion: PROTOCOL_VERSION,
    rawBody: JSON.stringify(executed.result ?? executed.refusal ?? {}),
  };
  if (executed.kind === 'result') return acceptResult(env);
  if (executed.kind === 'refusal') return acceptRefusal(env);
  // A Failure is signalled, not submitted. The control plane decides whether
  // the Run is still eligible to be failed; this step never writes status.
  const failed = await reportHostedFailure({ ownerId, runId, leaseToken, code: executed.code });
  return { accepted: false, rejection: `internal_failure:${executed.code}`, failed };
}
