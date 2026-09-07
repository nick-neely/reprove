#!/usr/bin/env node
/**
 * The adversarial gate, on demand.
 *
 * ```text
 * node tools/gate/qualify.mjs plan   --kind promotion [--baseline <sha>]
 * node tools/gate/qualify.mjs run    --kind promotion --shard 1/8 --records out.json
 * node tools/gate/qualify.mjs score  --kind promotion --records a.json b.json --out report.json
 * node tools/gate/qualify.mjs status
 * ```
 *
 * `run` executes one shard of the fixed batch against the real Provider and
 * writes its trial records; `score` merges every shard into the compact
 * durable report, decides promotion against the ledger, and optionally
 * records the result there. Splitting the batch is what lets a 576-trial
 * comparison fit inside a driver's job limit while staying one evaluation:
 * every shard is a slice of the same seeded plan, so candidate and baseline
 * remain interleaved inside each one.
 *
 * The Provider credential arrives only as `REPROVE_GATE_OPENAI_API_KEY`.
 * Nothing here reads a `.reprove.yml`, touches the database, or publishes.
 */
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { planBatch, runBatch } from "./batch.mjs";
import { loadCorpus } from "./corpus.mjs";
import {
  baselineNeedsRequalification,
  composeReport,
  evaluationId,
  lineageId,
  lineageStatus,
  nextBaseline,
  PHASE0_LINEAGE,
  promotionDecision,
  readLedger,
  writeBaseline,
  writeReport,
} from "./report.mjs";
import {
  buildRevisionImage,
  describeRevision,
  gitShaOf,
  loadRevision,
  prepareWorktree,
} from "./revision.mjs";
import { SCORING_POLICY, scoringVersion } from "./scoring.mjs";
import { createTrialDriver } from "./trial.mjs";

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..");
export const DEFAULT_LEDGER = path.join(import.meta.dirname, "ledger");
const KINDS = new Set(["first-qualification", "promotion", "requalification"]);

const log = (line) => process.stderr.write(`${line}\n`);

const usage = () => {
  log("usage: qualify.mjs <plan|run|score|status> [options]");
  log("  --kind <first-qualification|promotion|requalification>");
  log("  --candidate <sha>      defaults to this checkout");
  log(
    "  --candidate-sha <sha>  refuse records that qualified another commit (score)"
  );
  log("  --baseline <sha>       defaults to the ledger baseline (promotion)");
  log("  --shard <i/n>          run one slice of the batch (run)");
  log("  --records <file...>    shard output (run) or inputs (score)");
  log("  --out <file>           the report (score)");
  log("  --ledger <dir>         defaults to tools/gate/ledger");
  log(
    "  --write-ledger         record the report and any baseline move (score)"
  );
  log(
    "  --rebase               move the baseline to this revision and record the chain break (score)"
  );
  log(
    "  --repetitions <n>      off-policy budget; such a report cannot promote"
  );
  log("  --runtime <docker|podman>");
  log("  --work <dir>           where baseline worktrees are built");
  process.exit(2);
};

/** Parse `i/n` with 1 <= i <= n. */
export const parseShard = (value) => {
  const match = /^(?<index>\d+)\/(?<total>\d+)$/u.exec(value ?? "1/1");
  const index = Number(match?.groups?.index);
  const total = Number(match?.groups?.total);
  if (!match || index < 1 || total < 1 || index > total) {
    throw new RangeError(`shard must be i/n with 1 <= i <= n, got ${value}`);
  }
  return { index, total };
};

/** The trials a shard owns: every n-th of the seeded plan, offset by i. */
export const shardOf = (trials, { index, total }) =>
  trials.filter((_, position) => position % total === index - 1);

/**
 * Resolve which commits play which arm.
 *
 * The preflight applies however the baseline was chosen: ADR 0018 orders a
 * requalification of the standing baseline before any comparison the corpus
 * or scoring version moved under, and naming the same commit through
 * `--baseline` does not make its recorded qualification current. A
 * requalification, symmetrically, may only judge the standing baseline;
 * pointing it elsewhere is refused here rather than after the paid batch.
 *
 * @param {{ kind: string, candidate?: string, baseline?: string, ledger: string }} options The parsed command line.
 * @returns {Promise<{ candidate: string, baseline: string | null, here: string, ledger: import("./report.mjs").Ledger }>} The arms, this checkout, and the ledger they were read from.
 */
export const resolveArms = async (options) => {
  const ledger = readLedger(options.ledger, PHASE0_LINEAGE);
  const here = await gitShaOf(REPOSITORY);
  let candidate = options.candidate ?? null;
  let baseline = options.baseline ?? null;
  if (options.kind === "promotion") {
    baseline ??= ledger.baseline?.gitSha ?? null;
    if (baseline === null) {
      throw new Error(
        "a promotion needs a baseline; run a first-qualification"
      );
    }
    if (
      baselineNeedsRequalification(
        ledger.baseline,
        loadCorpus().version,
        scoringVersion
      )
    ) {
      throw new Error(
        "the corpus or scoring version moved since the baseline qualified; run a requalification of the baseline first"
      );
    }
  } else {
    baseline = null;
  }
  if (options.kind === "requalification") {
    const standing = ledger.baseline?.gitSha ?? null;
    if (standing === null) {
      throw new Error("a requalification needs a standing baseline");
    }
    if (candidate !== null && candidate !== standing) {
      throw new Error(
        `a requalification judges the standing baseline ${standing}; to move the baseline use score --rebase`
      );
    }
    candidate = standing;
  }
  candidate ??= here;
  return { candidate, baseline, here, ledger };
};

/** A built checkout for a commit: this one when it matches, a worktree otherwise. */
const checkoutFor = async (gitSha, here, workRoot) =>
  gitSha === here
    ? REPOSITORY
    : await prepareWorktree({ repository: REPOSITORY, gitSha, workRoot, log });

const identities = async (options) => {
  const arms = await resolveArms(options);
  const workRoot =
    options.work ?? path.join(tmpdir(), "reprove-gate-worktrees");
  const candidateRoot = await checkoutFor(arms.candidate, arms.here, workRoot);
  const candidate = await loadRevision(candidateRoot);
  const baseline =
    arms.baseline === null
      ? null
      : await loadRevision(
          await checkoutFor(arms.baseline, arms.here, workRoot)
        );
  return {
    ...arms,
    loaded: { candidate, baseline },
    revisions: {
      candidate: describeRevision(candidate),
      baseline: baseline === null ? null : describeRevision(baseline),
    },
  };
};

const planFor = (options, revisions, corpus) => {
  const seed = evaluationId({
    candidate: revisions.candidate,
    baseline: revisions.baseline,
    corpusVersion: corpus.version,
    scoringVersion,
  });
  return planBatch({
    corpus,
    arms:
      revisions.baseline === null ? ["candidate"] : ["candidate", "baseline"],
    seed,
    repetitions: options.repetitions,
  });
};

/**
 * The workflow outputs naming the revisions this plan resolved.
 *
 * A requalification resolves its candidate to the standing baseline, which is
 * commonly not the commit the workflow checked out, so the driver has to be
 * told which revision the result will belong to rather than assuming
 * `github.sha`.
 *
 * @param {{ candidate: import("./report.mjs").Revision, baseline: import("./report.mjs").Revision | null }} revisions The resolved arms.
 * @returns {string} `GITHUB_OUTPUT` lines for the candidate and baseline commits.
 */
export const planOutput = (revisions) =>
  `candidate=${revisions.candidate.gitSha}\nbaseline=${revisions.baseline?.gitSha ?? ""}\n`;

const plan = async (options) => {
  const corpus = loadCorpus();
  const { revisions } = await identities(options);
  const batch = planFor(options, revisions, corpus);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, planOutput(revisions));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        lineage: lineageId(PHASE0_LINEAGE),
        kind: options.kind,
        candidate: revisions.candidate,
        baseline: revisions.baseline,
        corpusVersion: corpus.version,
        scoringVersion,
        evaluationId: batch.seed,
        trials: batch.trials.length,
        first: batch.trials.slice(0, 8).map((trial) => trial.id),
      },
      null,
      2
    )}\n`
  );
};

/**
 * How a finished trial's judgement reads at the end of a progress line.
 *
 * @param {{ status: string, passed?: boolean }} judgement The trial's judgement.
 * @returns {string} " pass", " miss", or nothing when it was not scored.
 */
const judgementSuffix = (judgement) => {
  if (judgement.status !== "scored") {
    return "";
  }
  return judgement.passed ? " pass" : " miss";
};

const run = async (options) => {
  const key = process.env.REPROVE_GATE_OPENAI_API_KEY;
  if (!key) {
    throw new Error("REPROVE_GATE_OPENAI_API_KEY is not set");
  }
  const shard = parseShard(options.shard);
  const corpus = loadCorpus();
  const { loaded, revisions } = await identities(options);
  const batch = planFor(options, revisions, corpus);
  const trials = shardOf(batch.trials, shard);
  const authentication = {
    kind: "api-key",
    provider: PHASE0_LINEAGE.provider,
    key,
  };
  const drivers = {};
  for (const arm of ["candidate", "baseline"]) {
    const revision = loaded[arm];
    if (revision === null) {
      continue;
    }
    const runtime = revision.sandboxContainer.createCliRuntime({
      name: options.runtime ?? "docker",
    });
    const sandboxes =
      options.runtime === "podman"
        ? revision.sandboxContainer.createPodmanProvider({ runtime })
        : revision.sandboxContainer.createDockerProvider({ runtime });
    /*
     * One image build at a time: both arms drive the same container runtime,
     * and building them together would have two `docker build` invocations
     * compete for the same daemon and layer cache on the machine that is about
     * to run trials on it.
     */
    // oxlint-disable-next-line no-await-in-loop -- sequential by design; see above.
    const profile = await buildRevisionImage(revision, {
      runtime: options.runtime ?? "docker",
      log,
    });
    drivers[arm] = createTrialDriver({
      loaded: revision,
      revision: revisions[arm],
      profile,
      corpus,
      authentication,
      runtime,
      sandboxes,
      log,
    });
  }
  const startedAt = new Date().toISOString();
  const file =
    options.records?.[0] ??
    `gate-records-${shard.index}-of-${shard.total}.json`;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const header = {
    lineage: lineageId(PHASE0_LINEAGE),
    kind: options.kind,
    candidate: revisions.candidate,
    baseline: revisions.baseline,
    corpusVersion: corpus.version,
    scoringVersion,
    repetitions: batch.repetitions,
    evaluationId: batch.seed,
    shard,
    startedAt,
  };
  /*
   * The whole file is rewritten after every trial, through a rename so a kill
   * mid-write cannot truncate it. A runner lost at trial 40 of 72 then still
   * uploads the 40 trials whose behavior was observed, which is what keeps
   * the loss a recorded fact rather than an excuse to run them again.
   */
  const keep = (records) => {
    const temporary = `${file}.partial`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...header, completedAt: new Date().toISOString(), records })}\n`
    );
    renameSync(temporary, file);
  };
  keep([]);
  /** @type {import("./batch.mjs").TrialRecord[]} */
  const written = [];
  const records = await runBatch({
    plan: { trials },
    corpus,
    runTrial: (trial, signal) => drivers[trial.arm].runTrial(trial, signal),
    onTrial: (record, index, total) => {
      written.push(record);
      keep(written);
      log(
        `[${index + 1}/${total}] ${record.trial.id} ${record.judgement.status}${judgementSuffix(record.judgement)}`
      );
    },
  });
  keep(records);
  log(`wrote ${records.length} records to ${file}`);
};

/**
 * Read every shard file that arrived and prove they belong to one evaluation
 * of the requested kind, taken under this checkout's corpus and scoring
 * versions.
 *
 * A shard that never arrived is reported rather than refused: #34 wants a
 * durable INVALID report of the batch that was lost, not a scorer that dies
 * before writing one. Two records of the same shard remain an error, because
 * they are two observations of trials the budget allows once.
 *
 * @param {readonly string[]} files The shard record files.
 * @param {string} kind The kind the caller asked to score.
 * @param {string} corpusVersion This checkout's corpus version.
 * @returns {Promise<{ first: any, shards: any[], missing: number[] }>} The shards, the one they all agree with, and the shard indexes nothing arrived for.
 */
export const readShards = async (files, kind, corpusVersion) => {
  if (files.length === 0) {
    throw new Error("score needs --records");
  }
  const shards = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, "utf-8")))
  );
  const [first] = shards;
  if (first.kind !== kind) {
    throw new Error(
      `the records were taken for a ${first.kind}, not a ${kind}`
    );
  }
  const expectedTotal = first.shard.total;
  /** @type {Set<number>} */
  const seen = new Set();
  for (const shard of shards) {
    if (seen.has(shard.shard.index)) {
      throw new Error(
        `shard ${shard.shard.index} of ${expectedTotal} was recorded twice`
      );
    }
    seen.add(shard.shard.index);
  }
  const missing = Array.from(
    { length: expectedTotal },
    (_, position) => position + 1
  ).filter((index) => !seen.has(index));
  for (const shard of shards) {
    for (const field of [
      "evaluationId",
      "kind",
      "corpusVersion",
      "scoringVersion",
      "repetitions",
    ]) {
      if (JSON.stringify(shard[field]) !== JSON.stringify(first[field])) {
        throw new Error(`shards disagree on ${field}`);
      }
    }
  }
  if (
    first.corpusVersion !== corpusVersion ||
    first.scoringVersion !== scoringVersion
  ) {
    throw new Error(
      "the records were taken under a different corpus or scoring version than this checkout"
    );
  }
  return { first, shards, missing };
};

/**
 * The record a trial nobody observed leaves behind.
 *
 * @param {import("./batch.mjs").PlannedTrial} trial The trial that was planned.
 * @param {string} detail Which shard was supposed to run it.
 * @param {string} now The instant the loss was noticed.
 * @returns {import("./batch.mjs").TrialRecord} One non-retryable invalid attempt.
 */
const lostTrialRecord = (trial, detail, now) => {
  /** @type {import("./evaluate.mjs").Judgement} */
  const judgement = {
    status: "invalid",
    fault: "ephemeral_runner_lost",
    retryable: false,
    detail,
  };
  return {
    trial,
    attempts: [
      {
        attempt: 1,
        startedAt: now,
        endedAt: now,
        judgement,
        resolvedModel: null,
      },
    ],
    judgement,
  };
};

/**
 * Merge the shards that arrived into the one report of the batch.
 *
 * The budget is fixed, so the batch is re-planned from the recorded identity
 * and every planned trial is accounted for: a trial no shard recorded is an
 * `ephemeral_runner_lost` attempt that cannot be retried, because its shard's
 * job would replay trials whose behavior was already observed. The batch is
 * then INVALID by #34's rule on a remaining invalid trial, and that INVALID
 * is what the report durably says. Two records of one trial stay an error.
 *
 * @param {object} input The shards and what to judge them against.
 * @param {import("./corpus.mjs").Corpus} input.corpus The corpus the plan draws from.
 * @param {any} input.first The shard whose identity the plan is rebuilt from.
 * @param {readonly any[]} input.shards Every shard that arrived.
 * @param {string} [input.candidateSha] The commit the driver planned, when it wants the attribution proved.
 * @param {string} [input.now] The instant a loss is recorded at.
 * @returns {{ report: import("./report.mjs").Report, records: import("./batch.mjs").TrialRecord[], lost: string[] }} The report, every record behind it, and the trials nothing observed.
 */
export const assembleReport = ({
  corpus,
  first,
  shards,
  candidateSha,
  now = new Date().toISOString(),
}) => {
  if (candidateSha !== undefined && candidateSha !== first.candidate.gitSha) {
    throw new Error(
      `the records qualified ${first.candidate.gitSha}, not ${candidateSha}`
    );
  }
  const planned = planBatch({
    corpus,
    arms: first.baseline === null ? ["candidate"] : ["candidate", "baseline"],
    seed: first.evaluationId,
    repetitions: first.repetitions,
  }).trials;
  /** @type {Map<string, import("./batch.mjs").TrialRecord>} */
  const recorded = new Map();
  for (const shard of shards) {
    for (const record of shard.records) {
      if (recorded.has(record.trial.id)) {
        throw new Error(`${record.trial.id} was recorded twice`);
      }
      recorded.set(record.trial.id, record);
    }
  }
  const plannedIds = new Set(planned.map((trial) => trial.id));
  const stray = [...recorded.keys()].filter((id) => !plannedIds.has(id));
  if (stray.length > 0) {
    throw new Error(
      `the records name trials outside the planned batch: ${stray.join(", ")}`
    );
  }
  /** @type {string[]} */
  const lost = [];
  const records = planned.map((trial, position) => {
    const record = recorded.get(trial.id);
    if (record) {
      return record;
    }
    lost.push(trial.id);
    const index = (position % first.shard.total) + 1;
    return lostTrialRecord(
      trial,
      `shard ${index} of ${first.shard.total} recorded no result for this trial`,
      now
    );
  });
  const report = composeReport({
    kind: first.kind,
    candidate: first.candidate,
    baseline: first.baseline,
    corpusVersion: first.corpusVersion,
    scoringVersion: first.scoringVersion,
    repetitions: first.repetitions,
    records,
    startedAt: shards.map((shard) => shard.startedAt).toSorted()[0],
    completedAt: shards
      .map((shard) => shard.completedAt)
      .toSorted()
      .at(-1),
    diagnosticsDigest: createHash("sha256")
      .update(JSON.stringify(records))
      .digest("hex"),
  });
  return { report, records, lost };
};

/**
 * One line per axis for the summary.
 *
 * @param {import("./scoring.mjs").AxisTest | null} test The test to describe.
 * @returns {string | null} Outcome, point and lower bound.
 */
const describeTest = (test) =>
  test === null
    ? null
    : `${test.outcome} (${test.point.toFixed(3)}, lower ${test.lower.toFixed(3)})`;

const score = async (options) => {
  const corpus = loadCorpus();
  const { first, shards, missing } = await readShards(
    options.records ?? [],
    options.kind,
    corpus.version
  );
  const { report, lost } = assembleReport({
    corpus,
    first,
    shards,
    candidateSha: options["candidate-sha"],
  });
  if (missing.length > 0) {
    log(
      `shards ${missing.join(",")} of ${first.shard.total} never arrived: ${lost.length} trials are invalid and the evaluation cannot be scored`
    );
  }
  const ledger = readLedger(options.ledger, PHASE0_LINEAGE);
  const now = Date.now();
  const decision = promotionDecision({
    report,
    baseline: ledger.baseline,
    exceptions: ledger.exceptions,
    lineage: lineageStatus(ledger.reports, now),
    now,
  });
  report.exceptionRef = decision.exception;
  /*
   * The report records the decision made on it, before it is written anywhere
   * durable: a comparison the ledger refused is still kept, and only the
   * decision distinguishes it from one that moved the baseline.
   */
  report.decision = {
    promotable: decision.promotable,
    reason: decision.reason,
    exception: decision.exception,
  };
  /*
   * A refused rebase is a result, not a crash: the report still has to be
   * written and printed so the reason is visible where every other outcome is.
   */
  let { baseline } = ledger;
  let rebased = false;
  let rebaseRefusal = null;
  try {
    baseline = nextBaseline({
      current: ledger.baseline,
      report,
      decision,
      action: options.rebase ? "rebase" : "promote",
      now: new Date(now).toISOString(),
    });
    rebased = options.rebase === true && baseline?.reason === "rebase";
  } catch (error) {
    rebaseRefusal = error instanceof Error ? error.message : String(error);
    log(rebaseRefusal);
  }
  const out = options.out ?? `gate-report-${report.reportId}.json`;
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  let recordedAt = null;
  if (options["write-ledger"]) {
    recordedAt = writeReport(options.ledger, PHASE0_LINEAGE, report);
    if (baseline !== null && baseline !== ledger.baseline) {
      writeBaseline(options.ledger, PHASE0_LINEAGE, baseline);
    }
  }
  const summary = {
    lineage: report.lineageId,
    kind: report.kind,
    reportId: report.reportId,
    candidate: report.candidate.gitSha,
    baseline: report.baseline?.gitSha ?? null,
    outcome: report.outcome,
    absoluteOutcome: report.absoluteOutcome,
    axes: Object.fromEntries(
      Object.entries(report.scores?.axes ?? {}).map(([axis, axisScore]) => [
        axis,
        {
          absolute: describeTest(axisScore.absolute),
          nonInferiority: describeTest(axisScore.nonInferiority),
        },
      ])
    ),
    validity: report.validity,
    resolvedModels: report.resolvedModels,
    promotable: decision.promotable,
    reason: decision.reason,
    exception: decision.exception,
    baselineMoved: baseline !== ledger.baseline,
    rebase: options.rebase === true,
    rebaseRefusal,
    lostTrials: lost.length,
    report: out,
    recorded: recordedAt,
    lineageStatus: lineageStatus([...ledger.reports, report], now).status,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = (options.rebase ? rebased : decision.promotable) ? 0 : 1;
};

const status = (options) => {
  const ledger = readLedger(options.ledger, PHASE0_LINEAGE);
  const corpus = loadCorpus();
  const state = lineageStatus(ledger.reports, Date.now());
  process.stdout.write(
    `${JSON.stringify(
      {
        lineage: ledger.lineageId,
        status: state.status,
        latest: state.latest?.reportId ?? null,
        latestCompletedAt: state.latest?.completedAt ?? null,
        lastPass: state.lastPass?.reportId ?? null,
        baseline: ledger.baseline,
        baselineNeedsRequalification: baselineNeedsRequalification(
          ledger.baseline,
          corpus.version,
          scoringVersion
        ),
        corpusVersion: corpus.version,
        scoringVersion,
        policy: SCORING_POLICY,
        exceptions: ledger.exceptions.map((exception) => exception.id),
      },
      null,
      2
    )}\n`
  );
  process.exitCode = state.status === "current" ? 0 : 1;
};

const main = async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      candidate: { type: "string" },
      "candidate-sha": { type: "string" },
      baseline: { type: "string" },
      shard: { type: "string" },
      records: { type: "string", multiple: true },
      out: { type: "string" },
      ledger: { type: "string", default: DEFAULT_LEDGER },
      "write-ledger": { type: "boolean", default: false },
      rebase: { type: "boolean", default: false },
      repetitions: { type: "string" },
      runtime: { type: "string" },
      work: { type: "string" },
    },
  });
  // A shell glob after `--records` expands into positionals; they are the
  // remaining record files.
  const [command, ...extraRecords] = positionals;
  const options = {
    ...values,
    records:
      values.records === undefined && extraRecords.length === 0
        ? undefined
        : [...(values.records ?? []), ...extraRecords],
    repetitions:
      values.repetitions === undefined ? undefined : Number(values.repetitions),
  };
  if (command !== "status" && !KINDS.has(options.kind ?? "")) {
    usage();
  }
  switch (command) {
    case "plan": {
      await plan(options);
      break;
    }
    case "run": {
      await run(options);
      break;
    }
    case "score": {
      await score(options);
      break;
    }
    case "status": {
      status(options);
      break;
    }
    default: {
      usage();
    }
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    await main();
  } catch (error) {
    log(
      String(error instanceof Error ? (error.stack ?? error.message) : error)
    );
    process.exit(1);
  }
}
