/**
 * The **pass**: one hosted Worker's attempt at a Run, as a durable run of its
 * own ([ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)).
 *
 * ```text
 * dispatchHostedPass                    plain function; nothing durable yet
 *   plane.claimRun                      execution ownership, the same UPDATE
 *                                       the Worker endpoint reaches
 *   start(hostedPass, [grant, owner])   the pass is now running
 *   -- the window ADR 0016 pays to reach --
 *   plane.markExecuting                 claimed -> executing, pass id recorded
 *
 * hostedPass                            'use workflow'
 *   step executeHostedPass              worker-hosted drives worker-core and
 *                                       reports through the control plane
 * ```
 *
 * **The workflow lives here and the behaviour lives in
 * `@reprove/worker-hosted`.** ADR 0014 gives this package "every workflow and
 * step definition, and all step configuration", because a `'use step'` function
 * compiles into a bundle whose module graph is fixed at build time, so the
 * layer that defines steps is the only layer that can configure them - and
 * `@reprove/worker-hosted` reads no environment and depends on no control
 * plane, by ADR 0010's matrix. So the ordering, the placement and the Phase 0
 * Worker core are that package's, reached here through ports; the durable
 * shape, the step boundaries and the composition are this one's.
 *
 * **Everything the workflow body reaches is inlined into the workflow bundle,
 * which runs in a VM with no `require`.** The body below calls one step and
 * nothing else, and the harness stack is reached only from inside that step,
 * where a Node module graph is permitted. `tools/verify-workflow-build.mjs`
 * asserts the emitted bundle names no module but the workflow runtime, and
 * names none of `@reprove/worker-core`, `@reprove/adapters`,
 * `@reprove/sandbox-container` or `@ai-sdk/*` in particular.
 *
 * **The grant travels in the pass's arguments, and that includes the execution
 * token.** It has to: the control plane stores only `sha256(token)`, so the
 * plaintext cannot be re-read, and a pass that could not present it could
 * neither submit a Result nor report itself lost. The consequence is stated
 * rather than hidden - the token is at rest in the World's storage for the life
 * of the durable run, where the Workflow SDK's own payload encryption is what
 * protects it, and the control plane's row still holds a digest only.
 *
 * **Nothing in this repository starts a pass automatically yet.** ADR 0016's
 * Phase 0 scenario drives the claim endpoint itself and leaves the Run
 * claimable, so wiring dispatch into the ingress spine would dispatch every Run
 * before that scenario could reach it. `dispatchHostedPass` is the entry point
 * the scenario ([#58](https://github.com/nick-neely/reprove/issues/58)) and the
 * tests call; saying so is the point, because an exported function with no
 * caller reads like a live path.
 */
import type { ClaimGrant } from "@reprove/protocol/v1";
import type { HostedPassOutcome } from "@reprove/worker-hosted";

import { controlPlane, hostedPlacement } from "./composition.js";

/*
 * `'use step'` and `'use workflow'` are directives the Workflow SDK's compiler
 * reads off **function declarations**, and its own documentation writes every
 * one that way, so `func-style` yields to the SDK in this module.
 */
/* oxlint-disable func-style */

/**
 * What a deployment that composed no hosted placement answers with.
 *
 * It is a value rather than a throw because it is not a failure: a self-hosted
 * control plane not executing hosted passes is the deployment working as ADR
 * 0010 describes it. A throw would put a retry loop and an alert behind a
 * correct configuration.
 */
export interface HostedNotComposed {
  readonly kind: "not_composed";
}

/** How one hosted pass ended, or that this deployment composes none. */
export type PassOutcome = HostedNotComposed | HostedPassOutcome;

const NOT_COMPOSED: HostedNotComposed = { kind: "not_composed" };

/**
 * The Phase 0 build version a hosted pass reports as its own.
 *
 * A fixture, and the same shape a self-hosted Worker's would be: ADR 0006 makes
 * `workerBuildVersion` a Worker's statement about itself, and the hosted
 * placement's build is the deployment's. It is a constant here because lockstep
 * versioning (ADR 0010) means there is nothing else it could honestly be until
 * a release pipeline stamps one.
 */
export const HOSTED_WORKER_BUILD_VERSION = "0.0.0";

/**
 * Executes the Run and reports the outcome, which is the whole of the pass.
 *
 * Every port here is the control plane's own function - the same Acceptance the
 * authenticated endpoint reaches, and the same terminal transition the watchdog
 * reaches - so the hosted placement grows neither a submission path nor a
 * liveness story of its own.
 */
async function executeHostedPass(
  grant: ClaimGrant,
  ownerId: number
): Promise<PassOutcome> {
  "use step";
  const placement = await hostedPlacement();
  if (placement === null) {
    return NOT_COMPOSED;
  }
  const plane = await controlPlane();
  const execution = {
    executionToken: grant.executionToken,
    ownerId,
    runId: grant.runSpec.runId,
  };
  return await placement.runHostedPlacement({
    core: placement.createPhase0WorkerCore({
      workerBuildVersion: HOSTED_WORKER_BUILD_VERSION,
    }),
    execution,
    input: placement.phase0RunInput(grant.runSpec),
    ports: {
      acceptResult: (submission) => plane.acceptResult(submission),
      reportExecutionLost: (loss) => plane.reportExecutionLost(loss),
    },
  });
}

/**
 * One hosted Worker's attempt at one Run.
 *
 * @param grant The claim grant, which carries the Run's spec and the token the
 *   execution submits with.
 * @param ownerId The Owner the Run belongs to, which every step scopes to.
 * @returns How the pass ended.
 */
export async function hostedPass(
  grant: ClaimGrant,
  ownerId: number
): Promise<PassOutcome> {
  "use workflow";
  return await executeHostedPass(grant, ownerId);
}
