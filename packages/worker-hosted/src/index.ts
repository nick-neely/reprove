/**
 * The hosted Worker lifecycle: Worker core, driven by a durable pass, reporting
 * in-process to a control plane composed beside it.
 *
 * This package exists because
 * [ADR 0010](../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids `@reprove/control-plane` from depending on `@reprove/worker-core`,
 * and that prohibition is a product property rather than a layout preference:
 * *"a control plane that dispatches only to self-hosted Workers installs no
 * harness code at all"*. So the hosted composition is
 * `control-plane` + `worker-hosted`, the self-hosted composition omits this
 * package entirely, and what an operator verifies with `pnpm why` is what the
 * package graph says.
 *
 * ```text
 * dispatchHostedRun    claim -> start the pass -> record it   dispatch.ts
 * runHostedPlacement   Worker core -> Acceptance, or the      placement.ts
 *                      in-process `hosted_prompt` detector
 * createPhase0WorkerCore  ADR 0016's fixture Result, with no  core.ts
 *                      Sandbox and no Harness
 * ```
 *
 * **Nothing here holds a workflow or configures a step.** [ADR
 * 0014](../../../docs/adr/0014-workflow-orchestration-seam.md) gives every
 * `'use workflow'` and `'use step'` definition to
 * `@reprove/control-plane-workflow`, on the grounds that *"the layer that
 * defines steps is the only layer that can reliably configure them"* - a step
 * reads its own configuration from the environment, and this package reads no
 * environment and depends on no control plane. What it owns is the placement's
 * behaviour and the dispatch ordering; what starts the durable run is a port.
 *
 * That is also what makes this package's edge **optional**: the orchestration
 * package imports it lazily, and a deployment that omits it composes no hosted
 * dispatch and runs unchanged.
 */
import { protocolVersion } from "@reprove/protocol/v1";
import { composedFrom } from "@reprove/worker-core";

import { createPhase0WorkerCore, phase0RunInput } from "./core.js";
import { dispatchHostedRun } from "./dispatch.js";
import { runHostedPlacement } from "./placement.js";

export const packageName = "@reprove/worker-hosted" as const;

/**
 * The Worker core this package drives, named through its package export.
 * Exercising the edge keeps ADR 0010's matrix row a compiled fact rather than a
 * declaration.
 */
export const drives = {
  protocolVersion,
  workerCore: composedFrom,
} as const;

/**
 * The hosted composition, as one value.
 *
 * It is a bundle rather than four loose exports because of how it is reached:
 * `@reprove/control-plane-workflow` imports this module lazily, inside a step,
 * so that a self-hosted deployment can omit the package. One named object is
 * what that import destructures, and it is what makes "hosted dispatch is
 * composed, or it is not" a single fact at the seam.
 */
export const hostedPlacement = {
  createPhase0WorkerCore,
  dispatchHostedRun,
  phase0RunInput,
  runHostedPlacement,
} as const;

/**
 * The composition's type, so a consumer that imports this package **only as a
 * type** - which is what an optional peer is imported as at the top of a module
 * - never has to write `typeof import(...)` to name it.
 */
export type HostedPlacement = typeof hostedPlacement;

export {
  createPhase0WorkerCore,
  PHASE_0_SUMMARY,
  phase0RunInput,
} from "./core.js";
export type { Phase0WorkerCoreOptions } from "./core.js";
export { dispatchHostedRun } from "./dispatch.js";
export type {
  HostedClaim,
  HostedDispatchOutcome,
  HostedDispatchPorts,
  HostedDispatchRequest,
  StartedPass,
} from "./dispatch.js";
export { runHostedPlacement } from "./placement.js";
export type {
  HostedAcceptance,
  HostedExecution,
  HostedExecutionLoss,
  HostedLossOutcome,
  HostedPassOutcome,
  HostedPlacementPorts,
  HostedPlacementRequest,
  HostedSubmission,
} from "./placement.js";
