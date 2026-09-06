/**
 * The compact durable report, the ledger it lives in, and the decisions read
 * off the ledger: which baseline stands, whether a lineage is current, and
 * whether a revision may be promoted.
 *
 * Three rules from #34 shape everything here.
 *
 * **A baseline is a pointer to one exact, reproducible revision**, moved only
 * by a passing promotion or an explicit rebase. It is never a frozen number:
 * every comparison reruns the baseline revision beside the candidate.
 *
 * **An exception is non-ratcheting.** It binds one exact revision under one
 * corpus and scoring version, expires within thirty days, and leaves the
 * baseline exactly where it was, so granting one never raises or lowers the
 * bar for the next candidate.
 *
 * **Provider drift is a visible signal and never a runtime Refusal.** The
 * lineage status computed here is read by maintainers and by the on-demand
 * workflow; nothing under `packages/` imports this file, and no Run consults
 * it. A lineage that goes stale blocks promotion and opens an issue; it does
 * not stop a review.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { batchValidity, scoredTrials } from "./batch.mjs";
import { AXES, SCORING_POLICY, scoreEvaluation } from "./scoring.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** #34's freshness and drift windows. */
export const FRESHNESS = {
  /** A promotion comparison must complete within this. */
  comparisonWindowMs: 24 * HOUR_MS,
  /** A report stays usable for promotion this long, if the revision is unchanged. */
  reportUsableMs: 7 * DAY_MS,
  /** Scheduled absolute-floor requalification cadence. */
  requalifyEveryMs: 30 * DAY_MS,
  /** The longest an exception may bind. */
  exceptionMaxMs: 30 * DAY_MS,
};

/** The one cell Phase 0 qualifies. */
export const PHASE0_LINEAGE = {
  harness: "codex",
  route: "brokered",
  provider: "openai",
  model: "gpt-5.6-sol",
  autonomy: "verify",
  strategy: "standard",
};

/** @typedef {typeof PHASE0_LINEAGE} Lineage */

/**
 * One exact, reproducible revision, as #34 names an evaluation cell revision.
 *
 * @typedef {object} Revision
 * @property {string} revisionId The digest over everything below.
 * @property {string} gitSha The commit it was built from.
 * @property {Lineage} lineage The qualification cell it belongs to.
 * @property {string} harnessArtifact The Adapter's artifact fingerprint.
 * @property {string} instructionDigest The Reviewer instruction and policy digest.
 * @property {number} narrativeSchemaVersion The narrative schema it encodes under.
 * @property {number} protocolVersion The Worker protocol family the revision speaks.
 * @property {string} reasoningEffort The reasoning effort the Harness artifact was fingerprinted at.
 * @property {string} workerBuildVersion The Worker build the trials ran on.
 */

/**
 * The standing baseline: a pointer to a revision, never a frozen number.
 *
 * @typedef {object} BaselinePointer
 * @property {string} revisionId The revision it points at.
 * @property {string} gitSha The commit that revision was built from.
 * @property {string} corpusVersion The corpus it last qualified under.
 * @property {string} scoringVersion The scoring policy it last qualified under.
 * @property {string} reportId The report that set it.
 * @property {string} setAt When it was set.
 * @property {"first-qualification" | "promotion" | "requalification" | "rebase"} reason What moved it.
 * @property {boolean} chainBroken Whether a rebase broke the comparison chain.
 */

/**
 * A non-ratcheting acceptance of a known non-inferiority shortfall.
 *
 * @typedef {object} PromotionException
 * @property {string} id How the report refers to it.
 * @property {string} lineageId The lineage it was granted in.
 * @property {string} revisionId The one candidate revision it binds.
 * @property {string} baselineRevisionId The baseline that candidate was compared against.
 * @property {string} corpusVersion The corpus it was granted under.
 * @property {string} scoringVersion The scoring policy it was granted under.
 * @property {string} grantedAt When it was granted.
 * @property {string | null} expiresAt When it lapses, or null for the ceiling.
 * @property {string} reviewTrigger What must happen before it is revisited.
 * @property {readonly string[]} acceptedAxes The axes whose shortfall it accepts.
 * @property {string} reason Why it was granted.
 */

/**
 * Everything durable a lineage has accumulated.
 *
 * @typedef {object} Ledger
 * @property {string} lineageId Which lineage this ledger is for.
 * @property {BaselinePointer | null} baseline The standing baseline, if any.
 * @property {Report[]} reports Every report, oldest first by filename.
 * @property {PromotionException[]} exceptions Every exception ever granted.
 */

/**
 * The lineage's identity, as a path a maintainer can read.
 *
 * @param {Lineage} lineage The Lineage.
 * @returns {string} The six lineage fields, slash-separated.
 */
export const lineageId = (lineage) =>
  [
    lineage.harness,
    lineage.route,
    lineage.provider,
    lineage.model,
    lineage.autonomy,
    lineage.strategy,
  ].join("/");

/**
 * A file-system-safe spelling of a lineage id.
 *
 * @param {Lineage} lineage The Lineage.
 * @returns {string} The lineage id with its slashes flattened.
 */
export const lineageSlug = (lineage) => lineageId(lineage).replaceAll("/", "-");

/**
 * The identity a bootstrap seed and a batch order derive from.
 *
 * @param {object} input What the evaluation is of.
 * @param {Revision} input.candidate The revision under evaluation.
 * @param {Revision | null} input.baseline The revision it is compared against.
 * @param {string} input.corpusVersion The corpus both arms run.
 * @param {string} input.scoringVersion The scoring policy both arms are judged under.
 * @returns {string} A digest that names this evaluation exactly.
 */
export const evaluationId = ({
  candidate,
  baseline,
  corpusVersion,
  scoringVersion,
}) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        lineage: lineageId(candidate.lineage),
        candidate: candidate.revisionId,
        baseline: baseline?.revisionId ?? null,
        corpusVersion,
        scoringVersion,
      })
    )
    .digest("hex")
    .slice(0, 24);

/**
 * The compact durable record of one evaluation.
 *
 * @typedef {object} Report
 * @property {string} reportId How the ledger refers to it.
 * @property {"first-qualification" | "promotion" | "requalification"} kind Why it was run.
 * @property {string} lineageId The lineage it was run in.
 * @property {Revision} candidate The revision under evaluation.
 * @property {Revision | null} baseline The revision it was compared against.
 * @property {string} corpusVersion The corpus both arms ran.
 * @property {string} scoringVersion The scoring policy both arms were judged under.
 * @property {number} repetitions The budget each condition was run at.
 * @property {string} evaluationId The identity the seed and batch order derive from.
 * @property {string} startedAt When the batch began.
 * @property {string} completedAt When the batch finished.
 * @property {"PASS" | "FAIL" | "INCONCLUSIVE" | "INVALID" | "CONTRACT_FAIL"} outcome The evaluation's outcome.
 * @property {"PASS" | "FAIL" | "INCONCLUSIVE" | null} absoluteOutcome The absolute floors alone, or null when unscored.
 * @property {import("./scoring.mjs").Scored | null} scores Both tests per axis, or null when unscored.
 * @property {{ status: string, trials?: string[] }} validity Whether the batch could be scored, and what stopped it.
 * @property {Record<string, Record<string, { passed: number, scored: number, attempts: number, invalid: number }>>} matrix Per arm, family and condition counts.
 * @property {string[]} resolvedModels Every Model the Provider actually served.
 * @property {string | null} diagnosticsDigest The diagnostics bundle, if one was kept.
 * @property {string | null} exceptionRef The exception this report was promoted under, if any.
 */

/**
 * The absolute floors alone, decided the way #34 decides the whole.
 *
 * @param {import("./scoring.mjs").Scored} scores The evaluation's scores.
 * @returns {"PASS" | "FAIL" | "INCONCLUSIVE"} Any FAIL fails; else any INCONCLUSIVE.
 */
const absoluteOutcomeOf = (scores) => {
  const absolutes = new Set(
    AXES.map((axis) => scores.axes[axis]?.absolute.outcome ?? "INCONCLUSIVE")
  );
  if (absolutes.has("FAIL")) {
    return "FAIL";
  }
  if (absolutes.has("INCONCLUSIVE")) {
    return "INCONCLUSIVE";
  }
  return "PASS";
};

/**
 * Compose the compact durable report for one evaluation.
 *
 * @param {object} input What was evaluated, and what came of it.
 * @param {Report["kind"]} input.kind Why the evaluation was run.
 * @param {Revision} input.candidate The revision under evaluation.
 * @param {Revision | null} input.baseline The revision it was compared against.
 * @param {string} input.corpusVersion The corpus both arms ran.
 * @param {string} input.scoringVersion The scoring policy both arms are judged under.
 * @param {readonly import("./batch.mjs").TrialRecord[]} input.records Every finished trial.
 * @param {string} input.startedAt When the batch began.
 * @param {string} input.completedAt When the batch finished.
 * @param {number} [input.repetitions] Defaults to the policy's fixed budget.
 * @param {string | null} [input.diagnosticsDigest] The diagnostics bundle, if one was kept.
 * @param {string | null} [input.exceptionRef] The exception it was promoted under, if any.
 * @returns {Report} The compact durable report.
 */
export const composeReport = ({
  kind,
  candidate,
  baseline,
  corpusVersion,
  scoringVersion,
  records,
  startedAt,
  completedAt,
  repetitions = SCORING_POLICY.repetitions,
  diagnosticsDigest = null,
  exceptionRef = null,
}) => {
  const identity = evaluationId({
    candidate,
    baseline,
    corpusVersion,
    scoringVersion,
  });
  const validity = batchValidity(records);
  /** @type {Report["matrix"]} */
  const matrix = {};
  for (const record of records) {
    const key = `${record.trial.arm}/${record.trial.familyId}`;
    const row = matrix[key] ?? {};
    matrix[key] = row;
    const cell = row[record.trial.conditionId] ?? {
      passed: 0,
      scored: 0,
      attempts: 0,
      invalid: 0,
    };
    row[record.trial.conditionId] = cell;
    cell.attempts += record.attempts.length;
    if (record.judgement.status === "scored") {
      cell.scored += 1;
      cell.passed += record.judgement.passed ? 1 : 0;
    } else {
      cell.invalid += 1;
    }
  }
  const resolvedModels = [
    ...new Set(
      records.flatMap((record) =>
        record.attempts.flatMap((attempt) =>
          attempt.resolvedModel === null ? [] : [attempt.resolvedModel]
        )
      )
    ),
  ].toSorted();
  /** @type {import("./scoring.mjs").Scored | null} */
  let scores = null;
  /** @type {Report["outcome"]} */
  let outcome;
  /** @type {Report["absoluteOutcome"]} */
  let absoluteOutcome = null;
  if (validity.status === "valid") {
    scores = scoreEvaluation({
      trials: scoredTrials(records),
      seed: identity,
      compareToBaseline: kind === "promotion",
    });
    ({ outcome } = scores);
    absoluteOutcome = absoluteOutcomeOf(scores);
  } else {
    outcome = validity.status;
  }
  const reportId = createHash("sha256")
    .update(`${identity} ${completedAt}`)
    .digest("hex")
    .slice(0, 16);
  return {
    reportId,
    kind,
    lineageId: lineageId(candidate.lineage),
    candidate,
    baseline,
    corpusVersion,
    scoringVersion,
    repetitions,
    evaluationId: identity,
    startedAt,
    completedAt,
    outcome,
    absoluteOutcome,
    scores,
    validity,
    matrix,
    resolvedModels,
    diagnosticsDigest,
    exceptionRef,
  };
};

/**
 * The lineage's qualification state, from the newest results.
 *
 * ```text
 * current   latest PASSed and completed within 30 days
 * stale     last PASS older than 30 days, no newer failed or invalid result
 * failed    latest result established absolute-floor FAIL
 * invalid   latest result could not produce valid evidence
 * ```
 *
 * An INCONCLUSIVE result neither passes nor fails a lineage: it leaves the
 * last authoritative state in place, which is what "the newest scheduled
 * result is authoritative" has to mean for a result that decided nothing.
 *
 * @param {readonly Report[]} reports Every report the lineage has.
 * @param {number} now The instant to judge freshness at.
 * @returns {{ status: "current" | "stale" | "failed" | "invalid" | "unqualified", latest: Report | null, lastPass: Report | null }} The state, with the reports that decided it.
 */
export const lineageStatus = (reports, now) => {
  const ordered = [...reports].toSorted((left, right) =>
    left.completedAt.localeCompare(right.completedAt)
  );
  const decisive = ordered.filter(
    (report) =>
      report.absoluteOutcome === "PASS" ||
      report.absoluteOutcome === "FAIL" ||
      report.outcome === "INVALID" ||
      report.outcome === "CONTRACT_FAIL"
  );
  const latest = decisive.at(-1) ?? null;
  const lastPass =
    decisive.findLast((report) => report.absoluteOutcome === "PASS") ?? null;
  if (latest === null) {
    return { status: "unqualified", latest: null, lastPass: null };
  }
  if (latest.absoluteOutcome === "FAIL") {
    return { status: "failed", latest, lastPass };
  }
  if (latest.absoluteOutcome !== "PASS") {
    return { status: "invalid", latest, lastPass };
  }
  const age = now - Date.parse(latest.completedAt);
  return {
    status: age <= FRESHNESS.requalifyEveryMs ? "current" : "stale",
    latest,
    lastPass,
  };
};

/**
 * When an exception stops binding.
 *
 * @param {PromotionException} exception The exception to date.
 * @returns {number} The earlier of its own expiry and the thirty-day ceiling.
 */
export const exceptionExpiresAt = (exception) => {
  const ceiling = Date.parse(exception.grantedAt) + FRESHNESS.exceptionMaxMs;
  const explicit =
    exception.expiresAt === null ? ceiling : Date.parse(exception.expiresAt);
  return Math.min(ceiling, explicit);
};

/**
 * Whether an exception binds this exact report, now.
 *
 * @param {PromotionException} exception The exception to test.
 * @param {Report} report The report it might cover.
 * @param {number} now The instant to test it at.
 * @returns {boolean} True when it binds this exact report right now.
 */
export const exceptionApplies = (exception, report, now) =>
  exception.lineageId === report.lineageId &&
  exception.revisionId === report.candidate.revisionId &&
  exception.baselineRevisionId === (report.baseline?.revisionId ?? "") &&
  exception.corpusVersion === report.corpusVersion &&
  exception.scoringVersion === report.scoringVersion &&
  now < exceptionExpiresAt(exception);

/**
 * Whether the standing baseline must be requalified before a comparison.
 *
 * @param {BaselinePointer | null} baseline The standing pointer, if any.
 * @param {string} corpusVersion The corpus a comparison would run.
 * @param {string} scoringVersion The scoring policy it would be judged under.
 * @returns {boolean} True when the baseline last qualified under other versions.
 */
export const baselineNeedsRequalification = (
  baseline,
  corpusVersion,
  scoringVersion
) =>
  baseline !== null &&
  (baseline.corpusVersion !== corpusVersion ||
    baseline.scoringVersion !== scoringVersion);

/**
 * Why the evaluation itself cannot promote anything, if it cannot.
 *
 * These are the checks that need no baseline: the evaluation produced
 * evidence, ran the fixed budget, and cleared every absolute floor.
 *
 * @param {Report} report The report to judge.
 * @returns {string | null} The refusal reason, or null when nothing is wrong.
 */
const evaluationRefusal = (report) => {
  if (report.outcome === "INVALID" || report.outcome === "CONTRACT_FAIL") {
    return `evaluation ${report.outcome}`;
  }
  if (report.scores === null) {
    return "unscored";
  }
  if (report.repetitions !== SCORING_POLICY.repetitions) {
    return `budget was ${report.repetitions} repetitions, the policy fixes ${SCORING_POLICY.repetitions}`;
  }
  if (report.absoluteOutcome !== "PASS") {
    return `absolute floor ${report.absoluteOutcome}`;
  }
  return null;
};

/**
 * Why the report is too old or took too long to promote anything.
 *
 * @param {Report} report The report to judge.
 * @param {number} now The instant the decision is being made at.
 * @returns {string | null} The refusal reason, or null when it is fresh enough.
 */
const freshnessRefusal = (report, now) => {
  if (
    Date.parse(report.completedAt) - Date.parse(report.startedAt) >
    FRESHNESS.comparisonWindowMs
  ) {
    return "comparison exceeded 24 hours";
  }
  if (now - Date.parse(report.completedAt) > FRESHNESS.reportUsableMs) {
    return "report older than 7 days";
  }
  return null;
};

/**
 * Why the standing baseline does not admit this comparison, if it does not.
 *
 * @param {Report} report The report to judge.
 * @param {BaselinePointer | null} baseline The ledger's standing pointer.
 * @returns {string | null} The refusal reason, or null when the comparison stands.
 */
const baselineRefusal = (report, baseline) => {
  if (baseline === null || report.baseline === null) {
    return "baseline missing";
  }
  if (baseline.revisionId !== report.baseline.revisionId) {
    return "report compared against a superseded baseline";
  }
  if (
    baseline.corpusVersion !== report.corpusVersion ||
    baseline.scoringVersion !== report.scoringVersion
  ) {
    return "baseline requires requalification under the current versions";
  }
  return null;
};

/**
 * One axis whose non-inferiority test did not pass.
 *
 * @typedef {object} Shortfall
 * @property {string} axis The axis.
 * @property {import("./scoring.mjs").TestOutcome} outcome FAIL or INCONCLUSIVE.
 */

/**
 * The axes whose non-inferiority test did not pass, as the report spells them.
 *
 * @param {Report} report The report to read.
 * @returns {string[]} One `axis: OUTCOME` entry per shortfall, in axis order.
 */
const nonInferiorityShortfalls = (report) => {
  /** @type {Shortfall[]} */
  const shortfalls = [];
  for (const axis of AXES) {
    const outcome =
      report.scores?.axes[axis]?.nonInferiority?.outcome ?? "INCONCLUSIVE";
    if (outcome !== "PASS") {
      shortfalls.push({ axis, outcome });
    }
  }
  return shortfalls;
};

/**
 * May this report promote its candidate?
 *
 * @param {object} input Everything the decision reads.
 * @param {Report} input.report The report to judge.
 * @param {BaselinePointer | null} input.baseline The ledger's standing pointer.
 * @param {readonly PromotionException[]} input.exceptions Every exception the ledger holds.
 * @param {number} input.now The instant the decision is being made at.
 * @returns {{ promotable: boolean, reason: string, exception: string | null, nonInferiority: Shortfall[] }} The decision, with the shortfalls behind it.
 */
export const promotionDecision = ({ report, baseline, exceptions, now }) => {
  /** @type {Shortfall[]} */
  const nonInferiority = [];
  const refuse = (reason) => ({
    promotable: false,
    reason,
    exception: null,
    nonInferiority,
  });
  const unpromotable =
    evaluationRefusal(report) ?? freshnessRefusal(report, now);
  if (unpromotable !== null) {
    return refuse(unpromotable);
  }
  if (report.kind === "first-qualification") {
    return baseline === null
      ? {
          promotable: true,
          reason: "absolute floors passed",
          exception: null,
          nonInferiority,
        }
      : refuse("a baseline already stands; run a promotion comparison");
  }
  if (report.kind === "requalification") {
    // A requalification re-judges the standing baseline under the current
    // versions. Judging any other revision this way would move the pointer
    // without recording the chain breaking, which only a rebase may do.
    if (baseline === null) {
      return refuse("baseline missing");
    }
    if (report.candidate.revisionId !== baseline.revisionId) {
      return refuse("requalification must evaluate the standing baseline");
    }
    return {
      promotable: true,
      reason: "absolute floors passed",
      exception: null,
      nonInferiority,
    };
  }
  const unusableBaseline = baselineRefusal(report, baseline);
  if (unusableBaseline !== null) {
    return refuse(unusableBaseline);
  }
  nonInferiority.push(...nonInferiorityShortfalls(report));
  if (nonInferiority.length === 0) {
    return {
      promotable: true,
      reason: "every test passed",
      exception: null,
      nonInferiority,
    };
  }
  const applicable = exceptions.find(
    (exception) =>
      exceptionApplies(exception, report, now) &&
      nonInferiority.every((shortfall) =>
        exception.acceptedAxes.includes(shortfall.axis)
      )
  );
  if (applicable) {
    return {
      promotable: true,
      reason: "non-inferiority accepted by exception",
      exception: applicable.id,
      nonInferiority,
    };
  }
  return refuse("non-inferiority not established");
};

/**
 * Why a pointer moved, from the kind of report that moved it.
 *
 * @param {Report["kind"]} kind The report's kind.
 * @returns {"promotion" | "requalification" | "first-qualification"} The recorded reason.
 */
const baselineReasonFor = (kind) => {
  if (kind === "promotion") {
    return "promotion";
  }
  if (kind === "requalification") {
    return "requalification";
  }
  return "first-qualification";
};

/**
 * The baseline after a promotion decision.
 *
 * Only a report that passed every test moves the pointer. A promotion
 * through an exception leaves it untouched - that is what non-ratcheting
 * means - and a rebase is a separate explicit action that records the chain
 * breaking.
 *
 * @param {object} input The decision and what it applies to.
 * @param {BaselinePointer | null} input.current The standing pointer, if any.
 * @param {Report} input.report The report the decision was made on.
 * @param {ReturnType<typeof promotionDecision>} input.decision What was decided.
 * @param {"promote" | "rebase"} input.action Which action is being taken.
 * @param {string} input.now ISO instant.
 * @returns {BaselinePointer | null} The pointer afterwards, unchanged when nothing moved it.
 */
export const nextBaseline = ({ current, report, decision, action, now }) => {
  if (action === "rebase") {
    if (report.absoluteOutcome !== "PASS") {
      throw new Error("a rebase still requires every absolute floor to pass");
    }
    return {
      revisionId: report.candidate.revisionId,
      gitSha: report.candidate.gitSha,
      corpusVersion: report.corpusVersion,
      scoringVersion: report.scoringVersion,
      reportId: report.reportId,
      setAt: now,
      reason: "rebase",
      chainBroken: true,
    };
  }
  if (!decision.promotable || decision.exception !== null) {
    return current;
  }
  const reason = baselineReasonFor(report.kind);
  return {
    revisionId: report.candidate.revisionId,
    gitSha: report.candidate.gitSha,
    corpusVersion: report.corpusVersion,
    scoringVersion: report.scoringVersion,
    reportId: report.reportId,
    setAt: now,
    reason,
    chainBroken: false,
  };
};

/**
 * Where a lineage's ledger lives.
 *
 * @param {string} root The ledger root.
 * @param {Lineage} lineage The Lineage.
 * @returns {string} That lineage's directory under the root.
 */
export const ledgerDirectory = (root, lineage) =>
  path.join(root, lineageSlug(lineage));

/**
 * Every JSON file in a directory, by name, or nothing when it is absent.
 *
 * @param {string} directory The directory to read.
 * @returns {object[]} The parsed documents, in filename order.
 */
const readJsonFiles = (directory) => {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) =>
      JSON.parse(readFileSync(path.join(directory, name), "utf-8"))
    );
};

/**
 * Read a lineage's whole ledger off disk.
 *
 * @param {string} root The ledger root.
 * @param {Lineage} lineage The Lineage.
 * @returns {Ledger} Its baseline, reports and exceptions.
 */
export const readLedger = (root, lineage) => {
  const directory = ledgerDirectory(root, lineage);
  let baseline = null;
  try {
    baseline = JSON.parse(
      readFileSync(path.join(directory, "baseline.json"), "utf-8")
    );
  } catch {
    baseline = null;
  }
  return {
    lineageId: lineageId(lineage),
    baseline,
    reports: readJsonFiles(path.join(directory, "reports")),
    exceptions: readJsonFiles(path.join(directory, "exceptions")),
  };
};

/**
 * Append a report to a lineage's ledger.
 *
 * @param {string} root The ledger root.
 * @param {Lineage} lineage The Lineage.
 * @param {Report} report The report to write.
 * @returns {string} The file written.
 */
export const writeReport = (root, lineage, report) => {
  const directory = path.join(ledgerDirectory(root, lineage), "reports");
  mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    `${report.completedAt.replaceAll(/[:.]/gu, "-")}-${report.candidate.revisionId.slice(0, 12)}.json`
  );
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
};

/**
 * Move a lineage's standing baseline.
 *
 * @param {string} root The ledger root.
 * @param {Lineage} lineage The Lineage.
 * @param {BaselinePointer} pointer Where the baseline now points.
 * @returns {string} The file written.
 */
export const writeBaseline = (root, lineage, pointer) => {
  const directory = ledgerDirectory(root, lineage);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "baseline.json");
  writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`);
  return file;
};
