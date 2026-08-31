// The app's workflow entry.
//
// Both workflows are defined *inside packages* and only re-exported here. That
// is the question this file exists to answer: whether a `'use workflow'`
// function can ship inside a published package and still be compiled by the
// consuming app's build.
export { runLifecycle, ingressDelivery } from '@proto38/control-plane';
export { hostedPass } from '@proto38/worker-hosted/workflows';
