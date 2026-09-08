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
 * -- the window ADR 0016 pays to reach --
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
 */
import type {
  HostedDispatchOptions,
  HostedDispatchOutcome,
} from "@reprove/worker-hosted";
import { start } from "workflow/api";

import { controlPlane, hostedPlacement } from "./composition.js";
import type { HostedNotComposed } from "./pass.js";
import { hostedPass } from "./pass.js";

/** How one hosted dispatch ended, or that this deployment composes none. */
export type DispatchOutcome = HostedDispatchOutcome | HostedNotComposed;

/**
 * Claims a Run for the hosted placement and starts its pass.
 *
 * The ordering is `@reprove/worker-hosted`'s, deliberately: it is the fact ADR
 * 0016 reasons about, and it belongs beside the placement it orders rather than
 * being restated by each composition that drives one.
 *
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run to dispatch. Hosted dispatch always names its Run,
 *   because polling is the half of the protocol hosted never exercises.
 * @param options ADR 0016's test-only injection point, forwarded unchanged.
 *   Nothing in this package sets it, which `pass.test.ts` asserts by reading
 *   this package's own shipped source.
 * @returns What the dispatch concluded, or that no hosted placement is composed.
 */
export const dispatchHostedPass = async (
  ownerId: number,
  runId: string,
  options: HostedDispatchOptions = {}
): Promise<DispatchOutcome> => {
  const placement = await hostedPlacement();
  if (placement === null) {
    return { kind: "not_composed" };
  }
  const plane = await controlPlane();
  return await placement.dispatchHostedRun(
    {
      claimRun: (request) => plane.claimRun(request),
      markExecuting: (execution) => plane.markExecuting(execution),
      startPass: async (granted) => {
        const run = await start(hostedPass, [granted, ownerId]);
        return { hostedWorkflowRunId: run.runId };
      },
    },
    { ownerId, runId },
    options
  );
};
