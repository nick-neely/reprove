/**
 * Hosted dispatch: the entry point that claims a Run and starts its pass.
 *
 * It is a module of its own, and that is a **build** decision rather than a
 * taxonomy: this function calls `controlPlane()` and `hostedPlacement()` at
 * module scope, and everything a module holding a `'use workflow'` function
 * reaches is inlined into the workflow bundle - which runs in a VM with no
 * `require`. Left beside `hostedPass` it dragged the control plane, the
 * Postgres driver and the whole harness stack into that bundle, and the
 * Workflow builder refused the build naming a Node built-in in an innocent
 * file. That is exactly the failure ADR 0014 built the real-builder gate for,
 * and the fix is the same one the gate's own documentation gives: a workflow
 * body reaches steps and the runtime's primitives, and nothing else.
 *
 * ```text
 * plane.claimRun                      execution ownership, the same conditional
 *                                     UPDATE the Worker endpoint reaches
 * start(hostedPass, [grant, owner])   the pass is now genuinely running
 * -- the window ADR 0016's abandoned case is about --
 * plane.markExecuting                 claimed -> executing, pass id recorded
 * ```
 *
 * The ordering itself is `@reprove/worker-hosted`'s, deliberately: it is the
 * fact [ADR 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md)
 * reasons about, and it belongs beside the placement it orders rather than
 * being restated by every composition that drives one. What is here is the
 * wiring: which control plane, which workflow, which Owner.
 *
 * **Nothing in this repository dispatches automatically yet.** ADR 0016's
 * scenario drives the claim endpoint itself and needs the Run left claimable,
 * so wiring this into the ingress spine would dispatch every Run before that
 * scenario could reach one. This is the entry point the scenario
 * ([#58](https://github.com/nick-neely/reprove/issues/58)) and the tests call;
 * saying so is the point, because an exported function with no caller reads
 * like a live path.
 *
 * **What this deliberately does not claim.** `not_composed` is a statement
 * about *this deployment* and not about the Run: nothing was claimed, nothing
 * was started, and the Run is left exactly as claimable as it was, for whatever
 * placement it belongs to. It is not a failure and is not retried - a
 * self-hosted control plane declining to execute a hosted pass is ADR 0010's
 * deployment table working - so a caller that treated it as one would put an
 * alert behind a correct configuration. And it decides nothing about the
 * dispatch it does perform: the order, the window between `start()` and the
 * write, and every outcome name below are `@reprove/worker-hosted`'s.
 */
import type { ControlPlane } from "@reprove/control-plane";
import type {
  HostedDispatchOutcome,
  HostedPlacement,
} from "@reprove/worker-hosted";
import { start } from "workflow/api";

import { controlPlane } from "./composition.js";
import type { HostedNotComposed } from "./pass.js";
import { hostedPass } from "./pass.js";
import { hostedPlacement } from "./placement.js";

/** How one hosted dispatch ended, or that this deployment composes none. */
export type DispatchOutcome = HostedDispatchOutcome | HostedNotComposed;

/**
 * The two compositions one dispatch reaches, as an argument.
 *
 * The control plane is narrowed to the two statements dispatch uses, so what
 * this depends on is legible and a double is the same shape the deployment
 * passes rather than a weaker one.
 */
interface HostedComposition {
  readonly controlPlane: () => Promise<
    Pick<ControlPlane, "claimRun" | "markExecuting">
  >;
  readonly hostedPlacement: () => Promise<HostedPlacement | null>;
}

/** What this package composes, which is what `dispatchHostedPass` dispatches through. */
const COMPOSED: HostedComposition = { controlPlane, hostedPlacement };

/**
 * Claims a Run through a given composition and starts its pass, in the order
 * the module header above sets out and for the reasons it gives.
 *
 * Exported for this module's own test, which drives it over doubles rather than
 * over the composed deployment, for the same reason `composeHostedPlacement`
 * takes its loader: the branch worth testing is the one where **no** hosted
 * placement is composed, and no test can uninstall a package from the workspace
 * it is running in. What the composed path does is `spine.test.ts`'s subject,
 * against the real World and the real control plane.
 *
 * @param composition The control plane and the hosted placement to dispatch
 *   through.
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run to dispatch.
 * @returns What the dispatch concluded, or that no hosted placement is composed.
 */
export const dispatchThrough = async (
  composition: HostedComposition,
  ownerId: number,
  runId: string
): Promise<DispatchOutcome> => {
  const placement = await composition.hostedPlacement();
  if (placement === null) {
    return { kind: "not_composed" };
  }
  const plane = await composition.controlPlane();
  return await placement.dispatchHostedRun(
    {
      claimRun: (request) => plane.claimRun(request),
      markExecuting: (execution) => plane.markExecuting(execution),
      startPass: async (granted) => {
        const run = await start(hostedPass, [granted, ownerId]);
        return { hostedWorkflowRunId: run.runId };
      },
    },
    { ownerId, runId }
  );
};

/**
 * Claims a Run for this deployment's hosted placement and starts its pass.
 *
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run to dispatch. Hosted dispatch always names its Run,
 *   because polling is the half of the protocol hosted never exercises.
 * @returns What the dispatch concluded, or that no hosted placement is composed.
 */
export const dispatchHostedPass = async (
  ownerId: number,
  runId: string
): Promise<DispatchOutcome> => await dispatchThrough(COMPOSED, ownerId, runId);
