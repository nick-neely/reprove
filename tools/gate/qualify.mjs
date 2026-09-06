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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * @param {{ kind: string, candidate?: string, baseline?: string, ledger: string }} options The parsed command line.
 */
const resolveArms = async (options) => {
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
      ) &&
      !options.baseline
    ) {
      throw new Error(
        "the corpus or scoring version moved since the baseline qualified; run a requalification of the baseline first"
      );
    }
  } else {
    baseline = null;
  }
  if (options.kind === "requalification") {
    candidate ??= ledger.baseline?.gitSha ?? null;
    if (candidate === null) {
      throw new Error("a requalification needs a standing baseline");
    }
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

const plan = async (options) => {
  const corpus = loadCorpus();
  const { revisions } = await identities(options);
  const batch = planFor(options, revisions, corpus);
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
  const records = await runBatch({
    plan: { trials },
    corpus,
    runTrial: (trial, signal) => drivers[trial.arm].runTrial(trial, signal),
    onTrial: (record, index, total) =>
      log(
        `[${index + 1}/${total}] ${record.trial.id} ${record.judgement.status}${judgementSuffix(record.judgement)}`
      ),
  });
  const output = {
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
    completedAt: new Date().toISOString(),
    records,
  };
  const file =
    options.records?.[0] ??
    `gate-records-${shard.index}-of-${shard.total}.json`;
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(output)}\n`);
  log(`wrote ${records.length} records to ${file}`);
};

/**
 * Read every shard file and prove they belong to one evaluation of the
 * requested kind, taken under this checkout's corpus and scoring versions.
 *
 * @param {readonly string[]} files The shard record files.
 * @param {string} kind The kind the caller asked to score.
 * @param {string} corpusVersion This checkout's corpus version.
 * @returns {Promise<{ first: any, shards: any[] }>} The shards and the one they all agree with.
 */
const readShards = async (files, kind, corpusVersion) => {
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
  const seen = new Set(shards.map((shard) => shard.shard.index));
  if (seen.size !== expectedTotal || shards.length !== expectedTotal) {
    throw new Error(
      `expected ${expectedTotal} shards, found ${shards.length} (${[...seen].join(",")})`
    );
  }
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
  return { first, shards };
};

/**
 * Prove the records cover the fixed batch exactly once. The budget is fixed,
 * so the batch is re-planned from the recorded identity; a shard that
 * silently dropped trials cannot promote.
 *
 * @param {import("./corpus.mjs").Corpus} corpus The corpus the plan draws from.
 * @param {any} first The shard whose identity the plan is rebuilt from.
 * @param {readonly import("./batch.mjs").TrialRecord[]} records Every record merged.
 */
const checkCoverage = (corpus, first, records) => {
  const planned = planBatch({
    corpus,
    arms: first.baseline === null ? ["candidate"] : ["candidate", "baseline"],
    seed: first.evaluationId,
    repetitions: first.repetitions,
  }).trials.map((trial) => trial.id);
  const recorded = records.map((record) => record.trial.id).toSorted();
  if (JSON.stringify(recorded) !== JSON.stringify(planned.toSorted())) {
    throw new Error(
      `the records do not cover the planned batch: ${recorded.length} of ${planned.length} trials`
    );
  }
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
  const { first, shards } = await readShards(
    options.records ?? [],
    options.kind,
    corpus.version
  );
  const records = shards.flatMap((shard) => shard.records);
  checkCoverage(corpus, first, records);
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
  const ledger = readLedger(options.ledger, PHASE0_LINEAGE);
  const now = Date.now();
  const decision = promotionDecision({
    report,
    baseline: ledger.baseline,
    exceptions: ledger.exceptions,
    now,
  });
  report.exceptionRef = decision.exception;
  const baseline = nextBaseline({
    current: ledger.baseline,
    report,
    decision,
    action: options.rebase ? "rebase" : "promote",
    now: new Date(now).toISOString(),
  });
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
    report: out,
    recorded: recordedAt,
    lineageStatus: lineageStatus([...ledger.reports, report], now).status,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = (
    options.rebase ? baseline?.reason === "rebase" : decision.promotable
  )
    ? 0
    : 1;
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
