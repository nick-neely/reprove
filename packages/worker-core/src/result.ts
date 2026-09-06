/**
 * Result construction, and the validation every Result survives before it
 * leaves.
 *
 * One schema with a `completeness` discriminator, not a `Result` plus a
 * `PartialResult`: ADR 0006 makes the shared code path one path on purpose -
 * one schema, one validation, one dedupe - and a parallel type forks it. The
 * schema is `@reprove/protocol`'s and is not restated here; Worker core
 * composes the payload and asks the authoritative schema whether it is one.
 *
 * A malformed bundle is never converted into an empty Result. Empty means
 * "review completed with no Findings" and malformed means "review failed", and
 * conflating them would publish a clean bill of health the Reviewer never gave.
 */
import { resultSchema } from "@reprove/protocol/v1";
import type {
  Finding,
  PassRecord,
  Result,
  RunSpec,
} from "@reprove/protocol/v1";

import type { ConformanceComplaint, AdapterPassOutput } from "./adapter.js";

export interface ResultInput {
  readonly spec: RunSpec;
  readonly pass: AdapterPassOutput;
  /** What survived the Evidence cross-check, in the order it was made. */
  readonly findings: readonly Finding[];
  readonly passId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly workerBuildVersion: string;
}

export type ComposedResult =
  | { readonly result: Result; readonly complaint: null }
  | { readonly result: null; readonly complaint: ConformanceComplaint };

/**
 * The Pass as the Result records it.
 *
 * `outcome` is `completed` even for a partial Pass, and that is not a rounding
 * up: a partial Result is acceptable, so the Pass that produced one did not
 * fail. Why it stopped short lives in the Result's `stoppedBy` rather than
 * being restated as a second, weaker copy on the Pass. A Pass that genuinely
 * failed never reaches here at all - it is an internal Failure, and there is no
 * Result to record it on.
 */
const passRecord = (input: ResultInput): PassRecord => ({
  passId: input.passId,
  harness: input.spec.harness,
  pinnedModel: input.spec.model,
  resolvedModel: input.pass.resolvedModel,
  startedAt: input.startedAt,
  endedAt: input.endedAt,
  outcome: "completed",
  failureReason: null,
  repairTurnUsed: input.pass.repairTurnUsed,
  usage: input.pass.usage,
});

/**
 * Composes a Result and validates it against the authoritative schema.
 *
 * Validation is not a formality here. The schema carries the cross-field rules
 * that no construction step can be trusted to have honoured - `stoppedBy`
 * required exactly when the Result is partial, no Evidence and no `verified`,
 * a reasoned-only Finding carrying no Evidence, and the strict size bound that
 * makes "no bulk data crosses" enforceable at the edge rather than resting on
 * good behaviour.
 *
 * @param input The bundle, the Findings that survived the cross-check, and the
 *   Run it belongs to.
 * @returns A validated Result, or the complaint a repair turn may answer.
 */
export const composeResult = (input: ResultInput): ComposedResult => {
  const candidate = {
    runId: input.spec.runId,
    completeness: input.pass.outcome === "partial" ? "partial" : "complete",
    stoppedBy: input.pass.stoppedBy,
    summary: input.pass.summary,
    disprovedHypothesisCount: input.pass.disprovedHypothesisCount,
    findings: input.findings,
    passes: [passRecord(input)],
    usage: input.pass.usage,
    protocolVersion: 1,
    workerBuildVersion: input.workerBuildVersion,
  };

  const validated = resultSchema.safeParse(candidate);
  if (!validated.success) {
    return {
      result: null,
      complaint: {
        reason: "result_invalid",
        detail: validated.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`
          )
          .join("; "),
      },
    };
  }

  return { result: validated.data, complaint: null };
};
