// The workflow module imports NOTHING but the workflow runtime.
// Everything with a Node or CommonJS dependency is loaded by dynamic import
// inside a step body. Whether that is enough is what this build measures.
export async function probeComposition(spec: any, ownerId: number, leaseToken: string) {
  'use workflow';
  const inWorkflow = 'workflow-bundle';
  const inStep = await stepInstance();
  const executed = await passStep(spec);
  const absorbed = await absorbStep(ownerId, spec.runId, leaseToken, executed);
  return { inWorkflow, inStep, outcome: executed.kind, absorbed };
}

async function stepInstance() {
  'use step';
  const { MODULE_INSTANCE } = await import('../config.ts');
  return MODULE_INSTANCE;
}

async function passStep(spec: any) {
  'use step';
  const { executePass } = await import('@proto38/worker-hosted');
  return executePass(spec, 'clean');
}

async function absorbStep(ownerId: number, runId: string, leaseToken: string, executed: any) {
  'use step';
  const { acceptResult } = await import('@proto38/control-plane/acceptance');
  const { appDb } = await import('../config.ts');
  appDb();
  return acceptResult({
    ownerId,
    runId,
    leaseToken,
    protocolVersion: 1,
    rawBody: JSON.stringify(executed.result),
  });
}
