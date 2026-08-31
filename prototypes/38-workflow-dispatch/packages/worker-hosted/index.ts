// @proto38/worker-hosted - the hosted execution lifecycle.
//
// It may depend on worker-core, protocol and workflow, and on nothing of the
// control plane's.
//
// It deliberately contains NO transport. An earlier revision carried a workflow
// that POSTed a Result to a run-scoped ingest URL, on the belief that HTTP was
// the only composition available. It is not: the hosted app composes both halves
// and calls Acceptance directly. That transport code was left behind unexercised,
// which made it dead code that looked like evidence, so it is deleted.
//
// The authenticated HTTP submission a self-hosted Worker will use is real and is
// defined by ADR 0006. Exercising it belongs to
// https://github.com/nick-neely/reprove/issues/39, whose end-to-end scenario
// should submit through the Worker-facing endpoint rather than call
// acceptResult() directly.
export { executeRun as executePass } from '@proto38/worker-core';
export type { FaultProfile, WorkerOutcome } from '@proto38/worker-core';
export { WORKER_BUILD_VERSION } from '@proto38/worker-core';
