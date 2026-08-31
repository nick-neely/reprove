// @proto38/worker-core - stands in for Adapter + Sandbox + Evidence cross-check.
// It carries the @ai-sdk/* dependency, so nothing in the control plane may reach it.
import { HARNESS_MARKER } from 'ai-sdk-harness-stub';
import { RunSpecSchema, ResultSchema, RefusalSchema, PROTOCOL_VERSION } from '@proto38/protocol/v1';
import type { RunSpec, Result, Refusal } from '@proto38/protocol/v1';

export const WORKER_BUILD_VERSION = '0.0.0-proto38';

export type WorkerOutcome =
  | { kind: 'result'; result: Result }
  | { kind: 'refusal'; refusal: Refusal }
  /** ADR 0006 / #35: Failure is internal. It has no v1 wire representation. */
  | { kind: 'failure'; code: string };

/** #35's fault profiles, chosen by the caller so scenarios stay deterministic. */
export type FaultProfile = 'clean' | 'partial' | 'refuse-isolation' | 'internal-failure';

/**
 * The Worker-core entry: RunSpec in, Result | Refusal | Failure out.
 * Real execution is out of scope here (#35 settled that seam); what matters
 * is that this is the only function worker-hosted drives, and that it parses
 * the RunSpec on the way in and its own output on the way out.
 */
export async function executeRun(rawSpec: unknown, fault: FaultProfile): Promise<WorkerOutcome> {
  void HARNESS_MARKER;
  const spec: RunSpec = RunSpecSchema.parse(rawSpec);

  if (fault === 'refuse-isolation') {
    return {
      kind: 'refusal',
      refusal: RefusalSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        runId: spec.runId,
        reason: 'isolation_insufficient',
        requirement: 'isolation',
        required: 'container-rootless',
        actual: 'container',
        workerBuildVersion: WORKER_BUILD_VERSION,
      } satisfies Refusal),
    };
  }
  if (fault === 'internal-failure') {
    return { kind: 'failure', code: 'sandbox_teardown_incomplete' };
  }

  const partial = fault === 'partial';
  return {
    kind: 'result',
    result: ResultSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      runId: spec.runId,
      completeness: partial ? 'partial' : 'complete',
      stoppedBy: partial ? 'budget' : undefined,
      summary: partial ? 'Budget exhausted mid-review.' : 'Reviewed the diff.',
      findings: [
        {
          path: 'src/index.ts',
          line: 12,
          severity: 'high',
          verification: 'verified',
          title: 'Unawaited promise drops the error',
        },
      ],
      workerBuildVersion: WORKER_BUILD_VERSION,
    } satisfies Result),
  };
}
