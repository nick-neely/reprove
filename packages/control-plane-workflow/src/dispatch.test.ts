/**
 * `dispatchHostedPass`, which is wiring: which control plane, which workflow,
 * which Owner - and what it answers where there is no hosted placement to wire
 * to.
 *
 * The wiring is the only thing here that has no other home. The ordering it
 * drives is `@reprove/worker-hosted`'s and that package's own `dispatch.test.ts`
 * fixes it; the
 * whole path against a real World and a real database is `spine.test.ts`'s, and
 * it reaches the shipped entry point for the happy case. What neither can reach
 * is the self-hosted branch - no test can uninstall a package from the
 * workspace it is running in - so that branch is measured here, over the
 * composition this module takes as an argument.
 */
import type { ClaimOutcome } from "@reprove/control-plane";
import type {
  HostedDispatchPorts,
  HostedDispatchRequest,
  HostedPlacement,
} from "@reprove/worker-hosted";
import { hostedPlacement } from "@reprove/worker-hosted";
import { describe, expect, it } from "vitest";

import { dispatchThrough } from "./dispatch.js";

const ACME = 1001;
const RUN_ID = "run_hosted";

/** What one dispatch handed the ordering, recorded rather than acted on. */
interface Dispatched {
  ports: HostedDispatchPorts;
  request: HostedDispatchRequest;
}

/**
 * The real hosted placement with its ordering replaced by a recorder, so no
 * case here starts a durable run: what the ordering does with these arguments
 * is the driver's own subject, and doing it for real is `spine.test.ts`'s.
 */
const recordingPlacement = (calls: Dispatched[]): HostedPlacement => ({
  ...hostedPlacement,
  dispatchHostedRun: (ports, request) => {
    calls.push({ ports, request });
    return Promise.resolve({ kind: "not_claimed", reason: "no_run_available" });
  },
});

/** The control plane, recording which of its own statements a port reached. */
const recordingPlane = (reached: string[]) => ({
  claimRun: (request: HostedDispatchRequest): Promise<ClaimOutcome> => {
    reached.push(`claimRun:${request.runId}`);
    return Promise.resolve({ kind: "no_run_available" });
  },
  markExecuting: (): Promise<boolean> => {
    reached.push("markExecuting");
    return Promise.resolve(true);
  },
});

/** A deployment that composed no hosted placement, which is the self-hosted one. */
const selfHosted = (composed: string[]) => ({
  controlPlane: () => {
    composed.push("controlPlane");
    return Promise.resolve(recordingPlane([]));
  },
  hostedPlacement: () => Promise.resolve(null),
});

describe("dispatching a hosted pass", () => {
  it("answers not_composed where the deployment composes no hosted placement", async () => {
    // ADR 0010's self-hosted deployment, at the one entry point that would
    // otherwise crash on it. It is a value rather than a throw because it is
    // not a failure: a control plane that dispatches only to self-hosted
    // Workers is working as the deployment table describes it.
    await expect(
      dispatchThrough(selfHosted([]), ACME, RUN_ID)
    ).resolves.toStrictEqual({ kind: "not_composed" });
  });

  it("composes no control plane at all on that path", async () => {
    // Nothing is claimed and nothing is started, so the Run is left exactly as
    // claimable as it was - and a deployment that will never dispatch does not
    // open a connection pool to say so.
    const composed: string[] = [];

    await dispatchThrough(selfHosted(composed), ACME, RUN_ID);

    expect(composed).toStrictEqual([]);
  });

  it("wires the claim and the transition to the composed control plane", async () => {
    // The ports are the control plane's own functions - the same statements the
    // Worker-facing endpoints reach - rather than a hosted pair beside them.
    const calls: Dispatched[] = [];
    const reached: string[] = [];
    const composition = {
      controlPlane: () => Promise.resolve(recordingPlane(reached)),
      hostedPlacement: () => Promise.resolve(recordingPlacement(calls)),
    };

    await dispatchThrough(composition, ACME, RUN_ID);
    const ports = calls[0]?.ports;
    if (!ports) {
      throw new Error("the placement was not asked to dispatch");
    }
    await ports.claimRun({ ownerId: ACME, runId: RUN_ID });
    await ports.markExecuting({
      executionToken: "tok",
      hostedWorkflowRunId: "wrun_pass",
      ownerId: ACME,
      runId: RUN_ID,
    });

    expect(reached).toStrictEqual([`claimRun:${RUN_ID}`, "markExecuting"]);
    // And the Run this was asked to dispatch is the one the ordering was given.
    expect(calls[0]?.request).toStrictEqual({ ownerId: ACME, runId: RUN_ID });
  });
});
