/**
 * The two seams around the hosted pass that are decided in this package rather
 * than in `@reprove/worker-hosted`: whether a hosted placement is composed at
 * all, and what the watchdog calls what it read.
 *
 * Neither needs a database or a durable runtime. What the pass *does* is
 * `spine.test.ts`'s subject, against the real World and the real control plane.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { composeHostedPlacement } from "./composition.js";
import { observationFor } from "./lifecycle.js";

/** Node's own error for a package that is not installed. */
const notInstalled = (): Error =>
  Object.assign(new Error("Cannot find package '@reprove/worker-hosted'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });

describe("the hosted composition seam", () => {
  it("composes no hosted dispatch when the hosted driver is not installed", async () => {
    // ADR 0010's self-hosted deployment: `control-plane` +
    // `control-plane-workflow`, and no harness code anywhere. The import has to
    // answer rather than throw, or that deployment has no control plane at all.
    await expect(
      composeHostedPlacement(() => Promise.reject(notInstalled()))
    ).resolves.toBeNull();
  });

  it("reports a hosted driver that is installed and broken rather than hiding it", async () => {
    // Answering `null` here would report a defective deployment as a
    // self-hosted one, which is the one wrong answer available.
    await expect(
      composeHostedPlacement(() =>
        Promise.reject(new SyntaxError("Unexpected token"))
      )
    ).rejects.toThrow("Unexpected token");
  });

  it("composes what the package exports when it is installed", async () => {
    const placement = await composeHostedPlacement(
      () => import("@reprove/worker-hosted")
    );

    expect(placement).toMatchObject({
      createPhase0WorkerCore: expect.any(Function),
      dispatchHostedRun: expect.any(Function),
      phase0RunInput: expect.any(Function),
      runHostedPlacement: expect.any(Function),
    });
  });

  it("sets ADR 0016's injection point in no shipped module of this package", () => {
    // The impurity ADR 0016 accepted is one *option*, and this is what holds it
    // to that: `pass.ts` declares the parameter, because the scenario has to
    // reach the window through the shipped ordering, and nothing this package
    // ships ever assigns it. A test and the gate that drives the scenario are
    // the only callers that may.
    const source = path.join(import.meta.dirname);
    const shipped = readdirSync(source).filter(
      (file) => file.endsWith(".ts") && !file.includes(".test")
    );
    const assigning = shipped.filter((file) =>
      /interruptBeforeRecordingPass\s*:/u.test(
        readFileSync(path.join(source, file), "utf-8")
      )
    );

    expect(assigning).toStrictEqual([]);
    // And the scan is looking at something: the shipped modules are here.
    expect(shipped).toContain("pass.ts");
  });
});

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
