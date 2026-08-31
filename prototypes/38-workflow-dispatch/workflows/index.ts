// The app's workflow entry.
//
// Both orchestration workflows come from the app-layer adapter, and the hosted
// one from the app itself. @proto38/control-plane contributes none: it has no
// `workflow` dependency at all now.
export { runLifecycle, ingressDelivery } from '@proto38/control-plane-workflow/workflows';
export { hostedRun } from '@proto38/app-hosted/workflows';

// The static-vs-dynamic module-identity matrix (probe/matrix.ts).
export { matrixWorkflow } from '../probe/matrix.ts';
