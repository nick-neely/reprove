/**
 * The hosted placement over in-memory ports: which of Worker core's outcomes
 * reaches which half of the control plane, and which reaches neither.
 *
 * The distinction under test is
 * [ADR 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)'s
 * and it is easy to get wrong in a way no type catches: a *structured* Failure
 * keeps its own specific reason and must never be collapsed into `worker_lost`,
 * while an uncaught throw is exactly what `worker_lost` is for. Both are "the
 * pass did not produce a Result", so only a test that watches which port was
 * called can tell them apart.
 *
 * The doubles record calls rather than asserting inside themselves, because
 * what most of these cases claim is that a port was **not** reached.
 */
import type { RunInput, WorkerCore, WorkerOutcome } from "@reprove/worker-core";
import { describe, expect, it } from "vitest";

import {
  EXECUTION_TOKEN,
  OWNER_ID,
  REFUSAL,
  RESULT,
  RUN_ID,
  RUN_SPEC,
} from "./phase0.test-support.js";
import type {
  HostedAcceptance,
  HostedExecutionLoss,
  HostedSubmission,
} from "./placement.js";
import { runHostedPlacement } from "./placement.js";

const EXECUTION = {
  executionToken: EXECUTION_TOKEN,
  ownerId: OWNER_ID,
  runId: RUN_ID,
} as const;

/**
 * The Run input, which no double below reads. What a real core does with it is
 * `run.test.ts`'s subject in `@reprove/worker-core`; what is under test here is
 * the reporting either side of it.
 */
const INPUT: RunInput = {
  conventions: [],
  exposure: "none",
  narrative: { description: null, title: "a pull request" },
  spec: RUN_SPEC,
};

/** A Worker core that yields exactly what a case wants it to. */
const coreYielding = (outcome: WorkerOutcome): WorkerCore => ({
  execute: () => Promise.resolve(outcome),
});

/** A Worker core whose Pass throws past it. */
const coreThrowing = (error: Error | string): WorkerCore => ({
  execute: (): Promise<never> => {
    throw error;
  },
});

/** The control plane, recording what it was asked to do. */
const recordingPorts = (acceptance: HostedAcceptance, terminalized = true) => {
  const submitted: HostedSubmission[] = [];
  const losses: HostedExecutionLoss[] = [];
  return {
    losses,
    ports: {
      acceptResult: async (
        submission: HostedSubmission
      ): Promise<HostedAcceptance> => {
        submitted.push(submission);
        return await Promise.resolve(acceptance);
      },
      reportExecutionLost: async (loss: HostedExecutionLoss) => {
        losses.push(loss);
        return await Promise.resolve({ terminalized });
      },
    },
    submitted,
  };
};

const accepted: HostedAcceptance = {
  kind: "accepted",
  runStatus: "completed",
};

describe("the hosted placement", () => {
  it("submits a Result to the same Acceptance a self-hosted Worker reaches", async () => {
    const plane = recordingPorts(accepted);

    await expect(
      runHostedPlacement({
        core: coreYielding({ kind: "result", result: RESULT }),
        execution: EXECUTION,
        input: INPUT,
        ports: plane.ports,
      })
    ).resolves.toStrictEqual({ kind: "accepted", runStatus: "completed" });
    // The token travels with the Result, because ADR 0015 makes it the
    // placement-neutral name for the execution authorized to submit: there is
    // no hosted submission shape, so this is the shape the endpoint parses.
    expect(plane.submitted).toStrictEqual([
      {
        executionToken: EXECUTION.executionToken,
        ownerId: EXECUTION.ownerId,
        result: RESULT,
        runId: EXECUTION.runId,
      },
    ]);
    expect(plane.losses).toStrictEqual([]);
  });

  it("reports a Result the Run would not take without retrying or reviving it", async () => {
    // Acceptance is the stale-result boundary and it has already decided. A
    // pass that answered a rejection by trying again, or by reporting the
    // execution lost, would be arguing with a Run that has ended.
    const plane = recordingPorts({ kind: "rejected", reason: "not_eligible" });

    await expect(
      runHostedPlacement({
        core: coreYielding({ kind: "result", result: RESULT }),
        execution: EXECUTION,
        input: INPUT,
        ports: plane.ports,
      })
    ).resolves.toStrictEqual({ kind: "rejected", reason: "not_eligible" });
    expect(plane.submitted).toHaveLength(1);
    expect(plane.losses).toStrictEqual([]);
  });

  it("keeps a structured Failure's own reason and never reports it as worker_lost", async () => {
    // ADR 0015: a structured Failure from Worker core "keeps its own specific
    // reason, so `sandbox_teardown_incomplete` is never collapsed into
    // `worker_lost`". Nothing about this pass is lost - it ended, and it said
    // how.
    const plane = recordingPorts(accepted);

    await expect(
      runHostedPlacement({
        core: coreYielding({
          failure: {
            detail: "teardown could not be confirmed",
            phase: "teardown",
            reason: "sandbox_teardown_incomplete",
          },
          kind: "failure",
        }),
        execution: EXECUTION,
        input: INPUT,
        ports: plane.ports,
      })
    ).resolves.toStrictEqual({
      detail: "teardown could not be confirmed",
      kind: "failed",
      phase: "teardown",
      reason: "sandbox_teardown_incomplete",
    });
    expect(plane.losses).toStrictEqual([]);
    expect(plane.submitted).toStrictEqual([]);
  });

  it("reports a Refusal as itself, absorbing nothing into the Run", async () => {
    // A Refusal is a decision not to execute. It is not a Result, so Acceptance
    // never sees it, and nothing executed, so no execution was lost.
    const plane = recordingPorts(accepted);

    await expect(
      runHostedPlacement({
        core: coreYielding({ kind: "refusal", refusal: REFUSAL }),
        execution: EXECUTION,
        input: INPUT,
        ports: plane.ports,
      })
    ).resolves.toStrictEqual({ kind: "refused", reason: "sandbox_refused" });
    expect(plane.losses).toStrictEqual([]);
    expect(plane.submitted).toStrictEqual([]);
  });

  it("reports a thrown Pass as an uncaught throw, on the token the claim granted", async () => {
    // The in-process detector. ADR 0015: "an uncaught throw is a moment
    // Reprove's own code is running, and waiting out a ten-minute deadline for
    // a crash it witnessed is a choice, not a constraint."
    const plane = recordingPorts(accepted);

    await expect(
      runHostedPlacement({
        core: coreThrowing(new Error("the Pass exploded")),
        execution: EXECUTION,
        input: INPUT,
        ports: plane.ports,
      })
    ).resolves.toStrictEqual({
      detail: "the Pass exploded",
      kind: "lost",
      terminalized: true,
    });
    expect(plane.losses).toStrictEqual([
      {
        detector: "hosted_prompt",
        evidence: {
          executionToken: EXECUTION.executionToken,
          kind: "execution",
        },
        observation: "uncaught_throw",
        ownerId: EXECUTION.ownerId,
        runId: EXECUTION.runId,
      },
    ]);
    expect(plane.submitted).toStrictEqual([]);
  });

  it("reports the control plane's answer to the loss rather than its own", async () => {
    // The transition is conditional and may match nothing - the Run ended while
    // the pass was crashing. The pass reports what it was told.
    const plane = recordingPorts(accepted, false);

    await expect(
      runHostedPlacement({
        core: coreThrowing("a thrown string"),
        execution: EXECUTION,
        input: INPUT,
        ports: plane.ports,
      })
    ).resolves.toStrictEqual({
      detail: "a thrown string",
      kind: "lost",
      terminalized: false,
    });
  });

  it("lets a port failure propagate rather than reporting the execution lost", async () => {
    // A control plane that is unreachable for a moment is not a Pass that
    // crashed, and ending the Run on it would terminalize a Run whose pass is
    // running perfectly well. The caller is a durable step, and the platform's
    // own retry is what this needs.
    const losses: HostedExecutionLoss[] = [];

    await expect(
      runHostedPlacement({
        core: coreYielding({ kind: "result", result: RESULT }),
        execution: EXECUTION,
        input: INPUT,
        ports: {
          acceptResult: (): Promise<never> => {
            throw new Error("the pool is closed");
          },
          reportExecutionLost: async (loss: HostedExecutionLoss) => {
            losses.push(loss);
            return await Promise.resolve({ terminalized: true });
          },
        },
      })
    ).rejects.toThrow("the pool is closed");
    expect(losses).toStrictEqual([]);
  });
});
