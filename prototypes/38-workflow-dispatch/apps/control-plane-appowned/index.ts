// The app-owned composition. It owns config parsing, the workflow definitions
// and the step bodies; the packages own the substance the steps call into.
export { appOwnedRun } from './workflows/app-run.ts';
export { appConfig } from './config.ts';
