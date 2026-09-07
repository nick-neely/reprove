/**
 * Acceptance, which is one conditional UPDATE and then a name for why it
 * matched nothing.
 *
 * ```text
 * update run
 *   set status = 'completed' | 'incomplete', accepted_at, result_summary,
 *       result_stopped_by, result_disproved_hypothesis_count, result_usage,
 *       passes
 * where the Run, under this Owner
 *   and status in ('claimed','executing')
 *   and accepted_at is null
 *   and execution_token_hash = sha256(the presented token)
 * ```
 *
 * The eligibility window and the write are **the same statement**, which is
 * what makes [ADR 0006](../../../../docs/adr/0006-worker-protocol.md)'s
 * invariant - "at most one accepted terminal Result for the current Run state" -
 * a property of Postgres rather than of a check somebody remembered to run
 * first. Two concurrent submissions serialize on the row lock: one matches a row
 * and commits, the other re-evaluates its `WHERE` against the committed row and
 * matches zero. A Worker-supplied idempotency key never reaches this module at
 * all, because ADR 0006 says in as many words that it "must not" be what
 * enforces this.
 *
 * Zero rows is therefore ambiguous by construction, and the re-probe that
 * follows exists **only to name it**. Its order is the ticket:
 *
 * ```text
 * not visible                            -> unknown_run
 * status not eligible, or already accepted -> not_eligible
 * still eligible, token is not ours      -> execution_mismatch
 * anything else                          -> not_eligible
 * ```
 *
 * The second line is the **whole** eligibility half of the predicate rather
 * than terminality alone, which matters for the one case terminality misses: a
 * `queued` Run holds no execution at all, so answering `execution_mismatch`
 * would blame a token for a Run that was never claimed.
 *
 * [ADR 0016](../../../../docs/adr/0016-phase-0-acceptance-scenario.md) found
 * that order backwards in the prototype it lifted this from. Testing the token
 * first reports `execution_mismatch` - a rotated token - for a Run whose actual
 * problem is that it **ended**, and ADR 0015 requires the opposite: "the Run is
 * terminal, which is a stronger and clearer fact than token rotation". Both
 * orders return a rejection and both look correct; only the name differs, so
 * nothing but a test that reads the name can catch it.
 *
 * `wrong_tenant` is not reachable and is not missing. The whole of this module
 * runs inside `withOwner`, so another Owner's Run is **invisible** rather than
 * merely ineligible and the only answer available from inside the boundary is
 * `unknown_run`. ADR 0016 makes that indistinguishability the decision: the
 * response stops confirming that a Run exists under an Owner the caller cannot
 * see.
 *
 * **The Findings are inserted in the caller's transaction, after the UPDATE has
 * matched.** A rejected submission issues no insert at all, and a throw
 * anywhere rolls back both - so a Run cannot end `completed` with its Findings
 * missing, nor can Findings exist against a Run that never accepted them.
 */
import { createHash } from "node:crypto";

import type { Finding } from "@reprove/protocol/v1";
import type { SQL } from "drizzle-orm";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type { RunStatus } from "../db/schema-values.js";
import { RESULT_ELIGIBLE_RUN_STATUSES } from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type {
  AcceptanceOutcome,
  AcceptedRunStatus,
  ResultRejection,
  SubmittedResult,
} from "./acceptance-outcome.js";
import { hashExecutionToken } from "./execution-token.js";
import { isRunId } from "./run-id.js";

/** The version of the bucketing algorithm the rows below are keyed under. */
export const BUCKET_KEY_VERSION = 1;

/** What Acceptance is composed over. No value here is read from anywhere. */
export interface AcceptanceConfig {
  /** The clock `acceptedAt` is written from, read once per submission. */
  readonly now: () => Date;
}

/**
 * ADR 0015's Result-eligibility window, as one predicate, defined here and
 * nowhere else.
 *
 * ```text
 * Result-eligible Run = status IN (claimed, executing)
 *                     + acceptedAt IS NULL
 *                     + executionToken matches
 * ```
 *
 * The ADR requires it be "defined **once** and shared, never restated", because
 * two conditional updates race over exactly it: Acceptance below, and the
 * liveness termination to `failed(worker_lost)` (#56). Whichever wins closes the
 * other path, and a detector scoped more narrowly than Acceptance would leave
 * the guarantee holed. #56 composes this with its own deadline conjunct rather
 * than spelling the window again.
 *
 * `ownerId` is in the predicate as well as in the tenant context, which is ADR
 * 0008 rule 1: application scoping **plus** RLS, "not either alone".
 *
 * @param ownerId The submitting Owner.
 * @param runId The Run, already checked with `isRunId`.
 * @param executionTokenHash The stored form of the presented token.
 * @returns The window, as a predicate an UPDATE may carry.
 */
export const resultEligible = (
  ownerId: number,
  runId: string,
  executionTokenHash: string
): SQL | undefined =>
  and(
    eq(schema.run.ownerId, ownerId),
    eq(schema.run.id, runId),
    inArray(schema.run.status, RESULT_ELIGIBLE_RUN_STATUSES),
    isNull(schema.run.acceptedAt),
    eq(schema.run.executionTokenHash, executionTokenHash)
  );

/** The status half of the eligibility window, read back off a probed row. */
const statusIsEligible = (status: string): boolean =>
  // SAFETY: the probe reads a `text` column, because ADR 0008 keeps the state
  // machine in the application rather than in a Postgres `ENUM`, so the value
  // is a string that may or may not be one of these. Widening the tuple is what
  // lets an unknown status be asked about at all; narrowing the string instead
  // would assert a membership this line exists to test.
  (RESULT_ELIGIBLE_RUN_STATUSES as readonly string[]).includes(status);

/**
 * The anchored source a bucket key is taken over, with the whitespace that
 * carries no meaning removed.
 *
 * A re-indent, a reflow or a line ending is not a different defect, so
 * whitespace runs collapse to one space and the ends are trimmed. Nothing else
 * is touched: normalizing case or punctuation would start merging source that
 * genuinely differs.
 */
const normalizeAnchor = (anchoredText: string): string =>
  anchoredText.replaceAll(/\s+/gu, " ").trim();

/**
 * The candidate bucket a Finding belongs to, which is ADR 0007's
 * `path + normalized anchored-source hash` and deliberately nothing else.
 *
 * **Line numbers are excluded** because they move on any unrelated edit above
 * them, so keying on them would report every Finding as new after any push.
 * **Severity is excluded** because the same defect rated `high` on one Run and
 * `medium` on the next must not become a different Finding. The title is
 * excluded because it is the least stable field a Finding has - a model rewords
 * it and every Finding re-posts, which is the top complaint about review bots.
 *
 * The key produces a **candidate bucket** and nothing more. Matching inside it
 * is Reconciliation, which is cross-Run and belongs to the phase that publishes
 * a Review; this module writes the key and leaves `reconciliation` null.
 *
 * @param finding One Finding, as it crossed the Worker boundary.
 * @returns `sha256:` followed by the hex digest of path and normalized anchor.
 */
export const bucketKeyOf = (finding: Finding): string =>
  `sha256:${createHash("sha256")
    .update(
      `${finding.location.path}\n${normalizeAnchor(finding.anchoredText)}`,
      "utf-8"
    )
    .digest("hex")}`;

/** One Finding, as the row that outlives the crossing. */
const findingRow = (
  ownerId: number,
  runId: string,
  finding: Finding
): typeof schema.finding.$inferInsert => ({
  ownerId,
  runId,
  path: finding.location.path,
  // The one location, as the two lines the protocol carries. #2 fixed a Finding
  // to exactly one, and ADR 0007 makes it meaningful only against the Run's
  // `headSha`, so it is stored as the range it arrived as.
  line: finding.location.startLine,
  endLine: finding.location.endLine,
  severity: finding.severity,
  verification: finding.verification,
  title: finding.title,
  body: finding.body,
  anchoredText: finding.anchoredText,
  evidence: finding.evidence,
  patch: finding.patch ?? null,
  bucketKey: bucketKeyOf(finding),
  bucketKeyVersion: BUCKET_KEY_VERSION,
});

/**
 * Reads the Run again, only to say what happened to it.
 *
 * Nothing is written here and nothing is decided: the conditional UPDATE above
 * already decided, and this turns its zero rows into a word. The order is the
 * decision, and it is documented at the top of this module.
 */
const nameRejection = async (
  tx: TenantTransaction,
  probe: {
    readonly ownerId: number;
    readonly runId: string;
    readonly executionTokenHash: string;
  }
): Promise<ResultRejection> => {
  const [row] = await tx
    .select({
      status: schema.run.status,
      acceptedAt: schema.run.acceptedAt,
      executionTokenHash: schema.run.executionTokenHash,
    })
    .from(schema.run)
    .where(
      and(eq(schema.run.ownerId, probe.ownerId), eq(schema.run.id, probe.runId))
    )
    .limit(1);

  if (!row) {
    return "unknown_run";
  }
  // The eligibility half first, and the whole of it. A Result arriving after a
  // `worker_lost` transition has won is `not_eligible` rather than
  // `execution_mismatch`: the Run ended, which is the stronger and clearer
  // fact, and it is what proves terminal state rather than token rotation is
  // the stale-result boundary. The same reading covers `queued`, which holds no
  // execution at all, so blaming its token would be blaming the wrong thing.
  if (!statusIsEligible(row.status) || row.acceptedAt !== null) {
    return "not_eligible";
  }
  if (row.executionTokenHash !== probe.executionTokenHash) {
    return "execution_mismatch";
  }
  // Eligible, with the current token, and the UPDATE still matched nothing:
  // a row whose state moved under a snapshot this transaction cannot see.
  // Reporting it as acceptable would be the one answer that is certainly wrong.
  return "not_eligible";
};

/**
 * Accepts a Result, or names why it could not be accepted.
 *
 * The transaction is the caller's, and that is what makes the Run's terminal
 * status and its Findings one commit: an insert that throws rolls the
 * acceptance back rather than leaving a `completed` Run with nothing to publish.
 *
 * @param tx A tenant transaction already scoped to the submitting Owner.
 * @param config The clock `acceptedAt` is written from.
 * @param submission The Run, the presented token and the validated Result.
 * @returns The acceptance, a named rejection, or a payload refusal.
 */
export const acceptResult = async (
  tx: TenantTransaction,
  config: AcceptanceConfig,
  submission: SubmittedResult
): Promise<AcceptanceOutcome> => {
  const { ownerId, result, runId } = submission;

  if (!isRunId(runId)) {
    // Before any SQL, for the reason `run-id.ts` gives: a `uuid` column rejects
    // the string rather than failing to match it, and a rolled-back transaction
    // reads as `503`.
    return { kind: "rejected", reason: "unknown_run" };
  }

  const executionTokenHash = hashExecutionToken(submission.executionToken);

  // ADR 0007: "A `Patch` is rejected at acceptance under any Autonomy but
  // `fix`." Autonomy lives in the Run's immutable spec, so this is the one
  // payload check that needs a read - and it is issued only when the payload
  // actually carries a Patch, so the ordinary submission pays nothing for it.
  //
  // **It is scoped by the whole eligibility predicate, token included.** On the
  // Run id alone it would answer a caller that cannot submit at all, so a
  // rotated token or a Run that had already ended would learn the Run's
  // Autonomy by sending a Patch - a disclosure with nothing to do with the
  // payload, reached ahead of the rejection order that exists to prevent
  // exactly this. Where the predicate matches nothing, this says nothing: the
  // statement below runs and `nameRejection` answers `unknown_run`,
  // `not_eligible` or `execution_mismatch` as it would for any other Result.
  const patchAt = result.findings.findIndex((finding) => finding.patch);
  if (patchAt !== -1) {
    const [spec] = await tx
      .select({ autonomy: schema.run.autonomy })
      .from(schema.run)
      .where(resultEligible(ownerId, runId, executionTokenHash))
      .limit(1);
    if (spec && spec.autonomy !== "fix") {
      return {
        kind: "malformed",
        reason: `findings.${patchAt}.patch is not accepted under autonomy=${spec.autonomy}`,
      };
    }
  }

  // ADR 0007: `incomplete` is a status rather than a flag inside the Result,
  // because the Run's own status is what reports the operational outcome.
  const runStatus: AcceptedRunStatus =
    result.completeness === "complete" ? "completed" : "incomplete";

  const [accepted] = await tx
    .update(schema.run)
    .set({
      status: runStatus satisfies RunStatus,
      acceptedAt: config.now(),
      resultSummary: result.summary,
      resultStoppedBy: result.stoppedBy,
      resultDisprovedHypothesisCount: result.disprovedHypothesisCount,
      resultUsage: result.usage,
      passes: result.passes,
      // `workerBuildVersion` is deliberately not rewritten. The claim recorded
      // what the Worker advertised when it took execution ownership, and a
      // second value here would be two audit facts that can disagree with no
      // rule for which is true.
    })
    .where(resultEligible(ownerId, runId, executionTokenHash))
    .returning({ id: schema.run.id });

  if (!accepted) {
    return {
      kind: "rejected",
      reason: await nameRejection(tx, { executionTokenHash, ownerId, runId }),
    };
  }

  if (result.findings.length > 0) {
    await tx
      .insert(schema.finding)
      .values(
        result.findings.map((finding) => findingRow(ownerId, runId, finding))
      );
  }

  return { kind: "accepted", runStatus };
};
