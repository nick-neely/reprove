/**
 * The Worker core the hosted placement composes **in Phase 0**, and the Run
 * input it hands one.
 *
 * [ADR 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md) asserts
 * what the Phase 0 exit leaves absent, in its own words: "No checkout, no
 * Workspace, no Sandbox, no Harness. The Result is `worker-core`'s fixture."
 * This module is that sentence as code. `createPhase0WorkerCore()` satisfies
 * `WorkerCore` and produces a Result the way Worker core produces one - through
 * `composeResult`, against `@reprove/protocol`'s own schema - without launching
 * a Sandbox or invoking an Adapter.
 *
 * **It is a fixture and says so.** A real hosted core is
 * `createWorkerCore({ adapter, sandboxes, materialize, ... })`, and composing
 * one needs `@reprove/adapters` and `@reprove/sandbox-container`, which [ADR
 * 0010](../../../docs/adr/0010-package-graph-and-open-core-boundary.md) keeps
 * out of this package: the harness stack belongs to whoever composes the
 * deployment, and `runHostedPlacement` takes the core as an argument precisely
 * so that this package never has to choose one. Phase 1 replaces what this
 * module returns; nothing that consumes it has to change, because both are the
 * same `WorkerCore`.
 *
 * **What it is not.** It is not a test double: it is shipped, it is what the
 * hosted composition runs today, and it is the honest Phase 0 answer rather
 * than a stand-in for something absent from the build. It is also not a review:
 * the Result it composes has no Findings and says so in its summary, so nothing
 * downstream can read it as a clean bill of health a Reviewer gave. Every claim
 * about review quality is Phase 1's.
 */
import type { RunSpec } from "@reprove/protocol/v1";
import type {
  AdapterPassOutput,
  RunInput,
  WorkerCore,
} from "@reprove/worker-core";
import { composeResult } from "@reprove/worker-core";

/**
 * The summary the fixture Result carries. It names itself, because a Result
 * whose summary read like a review would be the one way this fixture could
 * mislead someone reading a Run back.
 */
export const PHASE_0_SUMMARY =
  "No review was performed. This Run executed the Phase 0 hosted placement, which composes no Harness and no Sandbox and reports no Findings.";

/** What Phase 0 has to say about the Run it did not review. */
const PHASE_0_PASS: AdapterPassOutput = {
  disprovedHypothesisCount: 0,
  failureReason: null,
  findings: [],
  observed: [],
  outcome: "completed",
  repairTurnUsed: false,
  // `null` rather than the pinned Model: nothing resolved a Model, and naming
  // the pinned one here would claim a Harness confirmed it.
  resolvedModel: null,
  stoppedBy: null,
  summary: PHASE_0_SUMMARY,
  usage: { inputTokens: 0, outputTokens: 0 },
};

export interface Phase0WorkerCoreOptions {
  /** The build this Worker reports as its own, recorded on every Pass. */
  readonly workerBuildVersion: string;
  /** The clock the Pass record is stamped from. Injected so a test can pin it. */
  readonly clock?: () => number;
  /** Mints the Pass id. Injected so a test can pin it. */
  readonly newId?: () => string;
}

/**
 * Composes the Phase 0 hosted Worker core.
 *
 * @param options The build version, and the clock and id source a test pins.
 * @returns A `WorkerCore` that composes the fixture Result for any Run.
 * @throws {Error} When the composed Result does not validate. That is a defect
 *   in this module rather than something a Run did, and there is no honest
 *   outcome to degrade to: a Failure would claim a Pass ran and failed.
 */
export const createPhase0WorkerCore = (
  options: Phase0WorkerCoreOptions
): WorkerCore => {
  const clock = options.clock ?? Date.now;
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  return {
    execute: async (input: RunInput) => {
      const at = new Date(clock()).toISOString();
      const composed = composeResult({
        endedAt: at,
        findings: [],
        pass: PHASE_0_PASS,
        passId: newId(),
        spec: input.spec,
        startedAt: at,
        workerBuildVersion: options.workerBuildVersion,
      });
      if (composed.complaint !== null) {
        throw new Error(
          `the Phase 0 fixture Result did not validate: ${composed.complaint.detail}`
        );
      }
      return await Promise.resolve({
        kind: "result" as const,
        result: composed.result,
      });
    },
  };
};

/**
 * The Run as Phase 0 hands it to Worker core.
 *
 * Every field below the spec is empty on purpose, and each absence is one of
 * ADR 0016's: no narrative reaches any Reviewer, so the inherited ADR 0013
 * constraint stays inherited; no conventions are read, because there is no
 * checkout to read them from; and `Exposure` is `none`, because no credential
 * is resolved for a Pass that invokes no Harness. The fixture core reads none
 * of it - it is here because `WorkerCore.execute` takes a `RunInput` and a real
 * core would read all of it, so the shape the composition passes is the shape
 * Phase 1 keeps.
 *
 * @param spec The Run's immutable spec, exactly as the claim granted it.
 * @returns The Run input for one Phase 0 hosted pass.
 */
export const phase0RunInput = (spec: RunSpec): RunInput => ({
  conventions: [],
  exposure: "none",
  narrative: { description: null, title: `Run ${spec.runId}` },
  spec,
});
