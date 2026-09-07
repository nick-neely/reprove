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
 *   and (the Result carries no Patch or autonomy = 'fix')
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
 * not visible                              -> unknown_run
 * status not eligible, or already accepted -> not_eligible
 * still eligible, token is not ours        -> execution_mismatch
 * a Patch this Run's Autonomy forbids      -> malformed
 * anything else                            -> not_eligible
 * ```
 *
 * The second line is the **whole** eligibility half of the predicate rather
 * than terminality alone, which matters for the one case terminality misses: a
 * `queued` Run holds no execution at all, so answering `execution_mismatch`
 * would blame a token for a Run that was never claimed.
 *
 * **The Autonomy line is last, and it is inside the statement rather than in
 * front of it.** ADR 0007 rejects a `Patch` under any Autonomy but `fix`, and
 * that check began life as a `select` ahead of the UPDATE - which made it a
 * second thing that decided, reachable before the boundary had run at all. A
 * concurrent submission committing between the two statements then produced a
 * `422` naming the Autonomy of a Run that had already ended, where the promised
 * answer is `not_eligible`. So the Autonomy is a conjunct of the one statement,
 * and the re-probe names it only after terminal state and token identity, which
 * is the same ordering every other name here obeys.
 *
 * **The re-probe takes the row lock**, which is what makes each of those names
 * true when it is answered rather than merely when it was read: a concurrent
 * acceptance either committed before the probe, and the probe sees it, or waits
 * behind it. Every path here locks the same single row and no other, so there
 * is no ordering for two of them to disagree about.
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

/** One named refusal, as the outcome the caller returns. */
const rejected = (reason: ResultRejection): AcceptanceOutcome => ({
  kind: "rejected",
  reason,
});

/**
 * Reads the Run again, only to say what happened to it.
 *
 * Nothing is written here and nothing is decided: the conditional UPDATE above
 * already decided, and this turns its zero rows into a word. The order is the
 * decision, and it is documented at the top of this module.
 *
 * `for update` is what makes the word true at the moment it is answered. The
 * UPDATE above matched nothing and therefore locked nothing, so without it a
 * concurrent acceptance could commit between this read and the response, and
 * the name would describe a row that no longer exists in that state. The lock
 * costs a rejection waiting behind an acceptance on the same row, which is one
 * row and one short transaction, and it cannot deadlock: every path through
 * this module locks that row and no other.
 */
const nameRefusal = async (
  tx: TenantTransaction,
  probe: {
    readonly ownerId: number;
    readonly runId: string;
    readonly executionTokenHash: string;
    /** Where the payload carries a Patch, or `-1`. */
    readonly patchAt: number;
  }
): Promise<AcceptanceOutcome> => {
  const [row] = await tx
    .select({
      status: schema.run.status,
      acceptedAt: schema.run.acceptedAt,
      autonomy: schema.run.autonomy,
      executionTokenHash: schema.run.executionTokenHash,
    })
    .from(schema.run)
    .where(
      and(eq(schema.run.ownerId, probe.ownerId), eq(schema.run.id, probe.runId))
    )
    .limit(1)
    .for("update");

  if (!row) {
    return rejected("unknown_run");
  }
  // The eligibility half first, and the whole of it. A Result arriving after a
  // `worker_lost` transition has won is `not_eligible` rather than
  // `execution_mismatch`: the Run ended, which is the stronger and clearer
  // fact, and it is what proves terminal state rather than token rotation is
  // the stale-result boundary. The same reading covers `queued`, which holds no
  // execution at all, so blaming its token would be blaming the wrong thing.
  if (!statusIsEligible(row.status) || row.acceptedAt !== null) {
    return rejected("not_eligible");
  }
  if (row.executionTokenHash !== probe.executionTokenHash) {
    return rejected("execution_mismatch");
  }
  if (probe.patchAt !== -1 && row.autonomy !== "fix") {
    // ADR 0007's payload rule, reached only once the Run itself has answered
    // for nothing. It is a `422` beside the schema failures rather than a
    // seventh entry in ADR 0016's rejection set, because it is a statement
    // about the payload measured against the Run's immutable spec.
    return {
      kind: "malformed",
      reason: `findings.${probe.patchAt}.patch is not accepted under autonomy=${row.autonomy}`,
    };
  }
  // Eligible, with the current token, carrying nothing this Run forbids, and
  // the UPDATE still matched nothing: a row whose state moved under a snapshot
  // this transaction cannot see. Reporting it as acceptable would be the one
  // answer that is certainly wrong.
  return rejected("not_eligible");
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
  // `fix`." Autonomy lives in the Run's immutable spec, so it is a conjunct of
  // the one statement rather than a read in front of it: as a separate `select`
  // it was a second thing that decided, and a concurrent submission committing
  // between the two produced a `422` naming the Autonomy of a Run that had
  // already ended. `nameRefusal` reaches it last, after terminal state and
  // token identity, so a Run that ended answers for itself first.
  const patchAt = result.findings.findIndex((finding) => finding.patch);

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
    .where(
      and(
        resultEligible(ownerId, runId, executionTokenHash),
        // `and` drops an `undefined`, so a Result carrying no Patch adds no
        // conjunct at all and the window stays exactly ADR 0015's.
        patchAt === -1 ? undefined : eq(schema.run.autonomy, "fix")
      )
    )
    .returning({ id: schema.run.id });

  if (!accepted) {
    return await nameRefusal(tx, {
      executionTokenHash,
      ownerId,
      patchAt,
      runId,
    });
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
