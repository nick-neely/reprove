/**
 * The Phase 0 hosted Worker core, which is
 * [ADR 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md)'s "the
 * Result is `worker-core`'s fixture" as an executable claim.
 *
 * Two things are worth measuring about a fixture. That it produces a Result the
 * protocol schema accepts, because a fixture that only looked like one would
 * fail at Acceptance rather than here; and that it says what it is, because the
 * one way this could mislead is a Run read back as a clean review that no
 * Reviewer performed.
 */
import { protocolVersion } from "@reprove/protocol/v1";
import { describe, expect, it } from "vitest";

import {
  createPhase0WorkerCore,
  PHASE_0_SUMMARY,
  phase0RunInput,
} from "./core.js";
import { RUN_SPEC } from "./phase0.test-support.js";

const AT = Date.parse("2026-09-03T12:01:00.000Z");

const core = createPhase0WorkerCore({
  clock: () => AT,
  newId: () => "pass_01",
  workerBuildVersion: "0.0.0",
});

describe("the Phase 0 hosted Worker core", () => {
  it("composes a Result the protocol accepts, with no Findings and one Pass", async () => {
    const outcome = await core.execute(phase0RunInput(RUN_SPEC));

    expect(outcome).toStrictEqual({
      kind: "result",
      result: {
        completeness: "complete",
        disprovedHypothesisCount: 0,
        findings: [],
        passes: [
          {
            endedAt: "2026-09-03T12:01:00.000Z",
            failureReason: null,
            harness: "codex",
            outcome: "completed",
            passId: "pass_01",
            pinnedModel: "gpt-5.6",
            repairTurnUsed: false,
            // Nothing resolved a Model, and saying the pinned one had been
            // resolved would claim a Harness confirmed it.
            resolvedModel: null,
            startedAt: "2026-09-03T12:01:00.000Z",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        ],
        protocolVersion,
        runId: "run_01",
        stoppedBy: null,
        summary: PHASE_0_SUMMARY,
        usage: { inputTokens: 0, outputTokens: 0 },
        workerBuildVersion: "0.0.0",
      },
    });
  });

  it("says in the Result itself that no review was performed", async () => {
    // An empty Result means "the review completed and found nothing", which is
    // a claim Phase 0 has no right to make. The summary is what stops a Run
    // read back from being mistaken for one.
    const outcome = await core.execute(phase0RunInput(RUN_SPEC));

    expect(outcome.kind).toBe("result");
    expect(PHASE_0_SUMMARY).toContain("No review was performed");
  });

  it("hands Worker core a Run carrying no narrative, conventions or Exposure", () => {
    // Each absence is one of ADR 0016's: no narrative reaches any Reviewer, no
    // checkout exists to read conventions from, and no credential is resolved
    // for a Pass that invokes no Harness.
    expect(phase0RunInput(RUN_SPEC)).toStrictEqual({
      conventions: [],
      exposure: "none",
      narrative: { description: null, title: "Run run_01" },
      spec: RUN_SPEC,
    });
  });
});
