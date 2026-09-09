/**
 * Hosted dispatch over in-memory ports: the order of the three calls, what each
 * refusal costs, and the one window that cannot be closed.
 *
 * The order is the whole subject. Claim, start, record is not a preference: ADR
 * 0014 makes `start()` non-idempotent, so the sequence is chosen to make the
 * *survivable* failure the one that happens - a pass that runs and can change
 * nothing - rather than a Run owned by no execution or naming a durable run
 * that was never started. A test that only asserted the happy path would hold
 * for every wrong order too, so the cases below assert the recorded sequence
 * and the state each interruption leaves.
 */
import { describe, expect, it } from "vitest";

import type { HostedClaim, HostedDispatchPorts } from "./dispatch.js";
import { dispatchHostedRun } from "./dispatch.js";
import {
  CLAIM_GRANT,
  EXECUTION_TOKEN,
  OWNER_ID,
  RUN_ID,
} from "./phase0.test-support.js";

const REQUEST = { ownerId: OWNER_ID, runId: RUN_ID } as const;

const PASS = "wrun_pass";

/** The composition, recording every call in the order it was made. */
const recordingPorts = (
  claim: HostedClaim,
  { recorded = true }: { recorded?: boolean } = {}
) => {
  const calls: string[] = [];
  const ports: HostedDispatchPorts = {
    claimRun: async () => {
      calls.push("claimRun");
      return await Promise.resolve(claim);
    },
    markExecuting: async (execution) => {
      calls.push(`markExecuting:${execution.hostedWorkflowRunId}`);
      return await Promise.resolve(recorded);
    },
    startPass: async () => {
      calls.push("startPass");
      return await Promise.resolve({ hostedWorkflowRunId: PASS });
    },
  };
  return { calls, ports };
};

const granted: HostedClaim = { grant: CLAIM_GRANT, kind: "granted" };

describe("hosted dispatch", () => {
  it("claims the Run, starts its pass, and records it, in that order", async () => {
    const composed = recordingPorts(granted);

    await expect(
      dispatchHostedRun(composed.ports, REQUEST)
    ).resolves.toStrictEqual({
      executionToken: EXECUTION_TOKEN,
      hostedWorkflowRunId: PASS,
      kind: "dispatched",
    });
    expect(composed.calls).toStrictEqual([
      "claimRun",
      "startPass",
      `markExecuting:${PASS}`,
    ]);
  });

  it("starts nothing when the claim was refused", async () => {
    // The claim is the only thing that grants execution ownership, so a pass
    // started without one would be a second execution of a Run somebody else
    // owns.
    const composed = recordingPorts({
      kind: "refused",
      reason: "already_claimed",
    });

    await expect(
      dispatchHostedRun(composed.ports, REQUEST)
    ).resolves.toStrictEqual({
      kind: "not_claimed",
      reason: "already_claimed",
    });
    expect(composed.calls).toStrictEqual(["claimRun"]);
  });

  it("starts nothing when there was no Run to claim", async () => {
    const composed = recordingPorts({ kind: "no_run_available" });

    await expect(
      dispatchHostedRun(composed.ports, REQUEST)
    ).resolves.toStrictEqual({
      kind: "not_claimed",
      reason: "no_run_available",
    });
    expect(composed.calls).toStrictEqual(["claimRun"]);
  });

  it("reports a pass the Run would not record, which is then inert", async () => {
    // The Run moved between the claim and the write: it ended, or its token was
    // rotated. The pass is running and can change nothing, because the Run it
    // would submit to has closed.
    const composed = recordingPorts(granted, { recorded: false });

    await expect(
      dispatchHostedRun(composed.ports, REQUEST)
    ).resolves.toStrictEqual({
      hostedWorkflowRunId: PASS,
      kind: "unrecorded",
    });
  });

  it("leaves a started pass unrecorded when the write never lands", async () => {
    // ADR 0016's mandatory abandoned case, and the window this ordering exists
    // to make survivable. A `markExecuting` that rejects before its durable
    // write lands is the crash between `start()` and the write: whether the
    // dispatching process died or
    // the statement did, the Run row is the same one - claimed, token assigned,
    // no pass id - and that row is the whole of what the window is.
    const composed = recordingPorts(granted);
    const ports: HostedDispatchPorts = {
      ...composed.ports,
      markExecuting: () =>
        Promise.reject(new Error("the dispatching process died")),
    };

    await expect(dispatchHostedRun(ports, REQUEST)).rejects.toThrow(
      "the dispatching process died"
    );
    // The pass is running. Nothing recorded it, and nothing ever will: this
    // dispatch is gone. `claimableUntil` writes only over `queued`, so
    // execution liveness is the only thing left that can end the Run.
    expect(composed.calls).toStrictEqual(["claimRun", "startPass"]);
  });
});
