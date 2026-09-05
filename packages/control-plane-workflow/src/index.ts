/**
 * Every workflow and step definition for the hosted control plane, and all step
 * configuration ([ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)).
 *
 * `apps/control-plane` composes this: its `next.config.ts` wraps the build with
 * `withWorkflow`, and its webhook route calls `controlPlane()` and hands the
 * request on. `@reprove/control-plane` neither defines nor configures a step,
 * and reads no environment variable; this package does both, because a `'use
 * step'` function compiles into a bundle whose module graph is fixed at build
 * time, so the layer that defines steps is the only layer that can configure
 * them.
 *
 * **The workflow functions are exported for the builder, not for callers.**
 * A `'use workflow'` function has to be reachable from the application's
 * module graph for the Workflow build to discover and register it, and it is
 * discovered here because this package declares `workflow` as a dependency -
 * the builder follows a bare import only into a package that does. Starting
 * one goes through `startDelivery()`, which the control plane is composed
 * with; nothing else in Reprove calls `start()`.
 */
export type { CompositionOptions, Environment } from "./environment.js";
export { configFromEnvironment, ENVIRONMENT } from "./environment.js";
export { controlPlane } from "./composition.js";
export type { DispatchedLifecycle, IngressConclusion } from "./ingress.js";
export { ingressDelivery, RE_DRIVE, startDelivery } from "./ingress.js";
export type { LifecycleOutcome, LifecycleSignal } from "./lifecycle.js";
export { lifecycleToken, runLifecycle } from "./lifecycle.js";
export type { Notified } from "./notify.js";
export { notifyLifecycle } from "./notify.js";

export const packageName = "@reprove/control-plane-workflow" as const;
