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
 * the builder follows a bare import only into a package that does. Starting a
 * lifecycle goes through `startDelivery()`, which the control plane is composed
 * with; starting a pass goes through `dispatchHostedPass()`, and nothing else
 * in Reprove calls `start()`.
 *
 * **The hosted pass is here rather than in `@reprove/worker-hosted`** for the
 * reason this package exists at all: ADR 0014 gives it every workflow and step
 * definition, because a step's module graph is fixed at build time and the
 * layer that defines steps is the only layer that can configure them. What the
 * hosted placement *does* is that package's, reached through ports and through
 * an optional import, so a self-hosted deployment omits it and this one runs
 * unchanged.
 */
export type { CompositionOptions, Environment } from "./environment.js";
export { configFromEnvironment, ENVIRONMENT } from "./environment.js";
export {
  composeHostedPlacement,
  controlPlane,
  hostedPlacement,
} from "./composition.js";
export type { DispatchedLifecycle, IngressConclusion } from "./ingress.js";
export { ingressDelivery, RE_DRIVE, startDelivery } from "./ingress.js";
export type { LifecycleOutcome, LifecycleSignal } from "./lifecycle.js";
export { lifecycleToken, runLifecycle } from "./lifecycle.js";
export type { DispatchOutcome } from "./hosted.js";
export { dispatchHostedPass } from "./hosted.js";
export type { HostedNotComposed, PassOutcome } from "./pass.js";
export { HOSTED_WORKER_BUILD_VERSION, hostedPass } from "./pass.js";
export type { Notified } from "./notify.js";
export { notifyLifecycle } from "./notify.js";

export const packageName = "@reprove/control-plane-workflow" as const;
