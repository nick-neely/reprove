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
 * workspace it is running in - and what neither *should* reach is the injection
 * point, which has to arrive at the ordering as the same function the caller
 * passed rather than merely reach some caller. Both are properties of this
 * module, so both are measured over the composition it takes as an argument.
 */
import type { ClaimOutcome } from "@reprove/control-plane";
import type {
  HostedDispatchOptions,
  HostedDispatchPorts,
  HostedDispatchRequest,
  HostedPlacement,
} from "@reprove/worker-hosted";
import { hostedPlacement } from "@reprove/worker-hosted";
import { describe, expect, it } from "vitest";

import { dispatchThrough } from "./dispatch.js";

const ACME = 1001;
const RUN_ID = "run_hosted";

/** The injection point a case passes, identical on both sides of the forward. */
const interrupt = (): never => {
  throw new Error("the dispatching process died here");
};

/** What one dispatch handed the ordering, recorded rather than acted on. */
interface Dispatched {
  ports: HostedDispatchPorts;
  request: HostedDispatchRequest;
  options: HostedDispatchOptions;
}

/**
 * The real hosted placement with its ordering replaced by a recorder, so no
 * case here starts a durable run: what the ordering does with these arguments
 * is the driver's own subject, and doing it for real is `spine.test.ts`'s.
 */
const recordingPlacement = (calls: Dispatched[]): HostedPlacement => ({
  ...hostedPlacement,
  dispatchHostedRun: (ports, request, options = {}) => {
    calls.push({ options, ports, request });
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
      dispatchThrough(selfHosted([]), ACME, RUN_ID, {})
    ).resolves.toStrictEqual({ kind: "not_composed" });
  });

  it("composes no control plane at all on that path", async () => {
    // Nothing is claimed and nothing is started, so the Run is left exactly as
    // claimable as it was - and a deployment that will never dispatch does not
    // open a connection pool to say so.
    const composed: string[] = [];

    await dispatchThrough(selfHosted(composed), ACME, RUN_ID, {});

    expect(composed).toStrictEqual([]);
  });

  it("forwards ADR 0016's injection point unchanged", async () => {
    // "Unchanged" is the whole property: the scenario reaches the window
    // between `start()` and `markExecuting` only if the option arrives at the
    // ordering as the same function the caller passed. Nothing this package
    // ships supplies one, which `pass.test.ts` asserts by reading the source.
    const calls: Dispatched[] = [];
    const composition = {
      controlPlane: () => Promise.resolve(recordingPlane([])),
      hostedPlacement: () => Promise.resolve(recordingPlacement(calls)),
    };

    await dispatchThrough(composition, ACME, RUN_ID, {
      interruptBeforeRecordingPass: interrupt,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.interruptBeforeRecordingPass).toBe(interrupt);
    expect(calls[0]?.request).toStrictEqual({ ownerId: ACME, runId: RUN_ID });
  });

  it("supplies no injection point of its own when a caller names none", async () => {
    const calls: Dispatched[] = [];
    const composition = {
      controlPlane: () => Promise.resolve(recordingPlane([])),
      hostedPlacement: () => Promise.resolve(recordingPlacement(calls)),
    };

    await dispatchThrough(composition, ACME, RUN_ID, {});

    expect(calls[0]?.options.interruptBeforeRecordingPass).toBeUndefined();
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

    await dispatchThrough(composition, ACME, RUN_ID, {});
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
  });
});
