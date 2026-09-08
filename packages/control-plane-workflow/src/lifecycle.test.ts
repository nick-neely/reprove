/**
 * What the watchdog calls what it read: `observationFor`, beside the loop that
 * calls it.
 *
 * The mapping is a pure function of one status string, so it needs neither a
 * database nor a durable runtime - and it is the one part of the liveness
 * branch that can be enumerated exhaustively. What the loop *does* with the
 * observation, and that it terminalizes before it cancels, is `spine.test.ts`'s
 * subject, against the real World and the real control plane.
 */
import { describe, expect, it } from "vitest";

import { observationFor } from "./lifecycle.js";

describe("what the watchdog calls what it read", () => {
  it("says only that the deadline elapsed when there is no pass to read", () => {
    // The honest answer: with no pass recorded, the watchdog saw nothing arrive
    // in time and knows nothing about why.
    expect(observationFor(null)).toBe("deadline_elapsed");
  });

  it("says the same for a pass that is still going past the deadline", () => {
    expect(observationFor({ status: "running" })).toBe("deadline_elapsed");
    expect(observationFor({ status: "pending" })).toBe("deadline_elapsed");
  });

  it("names what a pass that ended did", () => {
    // A `completed` pass is not a completed Run: the transition only writes at
    // all over a Run still inside Acceptance's window, so a pass that returned
    // normally and left the Run there submitted no Result.
    expect(observationFor({ status: "completed" })).toBe(
      "workflow_terminal_without_result"
    );
    expect(observationFor({ status: "failed" })).toBe("workflow_failed");
    expect(observationFor({ status: "cancelled" })).toBe("workflow_cancelled");
  });

  it("says the state was unavailable when nothing could be read", () => {
    // `null` is the step's one answer for every way reading can fail: a World
    // that is down and a run id it has never heard of both tell the watchdog
    // nothing about what the pass did.
    expect(observationFor({ status: null })).toBe("workflow_state_unavailable");
  });

  it("says the same for a status this loop does not understand", () => {
    // The World's status vocabulary belongs to a dependency. A lifecycle's job
    // is to schedule rather than to assert, and "its state could not be read"
    // is true of a status this loop cannot interpret.
    expect(observationFor({ status: "quiesced" })).toBe(
      "workflow_state_unavailable"
    );
  });
});
