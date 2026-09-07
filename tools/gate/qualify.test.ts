import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { PlannedTrial } from "./batch.mjs";
import { planBatch, runBatch } from "./batch.mjs";
import { loadCorpus } from "./corpus.mjs";
import {
  assembleReport,
  planOutput,
  readShards,
  resolveArms,
  shardOf,
} from "./qualify.mjs";
import type { BaselinePointer, Revision } from "./report.mjs";
import { ledgerDirectory, PHASE0_LINEAGE } from "./report.mjs";
import { scoringVersion } from "./scoring.mjs";

const execFileAsync = promisify(execFile);
const corpus = loadCorpus();
const BASELINE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "c".repeat(40);
const EVALUATION_ID = "evaluation";

const candidateRevision: Revision = {
  revisionId: "revision",
  gitSha: CANDIDATE_SHA,
  lineage: PHASE0_LINEAGE,
  harnessArtifact: "artifact",
  instructionDigest: "instructions",
  narrativeSchemaVersion: 1,
  protocolVersion: 1,
  reasoningEffort: "medium",
  workerBuildVersion: "0.0.0",
};

/** A Reviewer that reports exactly the family's defects. */
const perfectReviewer = (trial: PlannedTrial) => {
  const family = corpus.families.find(
    (candidate) => candidate.id === trial.familyId
  );
  const findings = (family?.locations ?? [])
    .filter((location) => location.kind === "defect")
    .map((location) => ({
      severity: "high",
      location: {
        path: location.path,
        startLine: location.startLine,
        endLine: location.endLine,
      },
    }));
  return Promise.resolve({
    outcome: {
      kind: "result" as const,
      result: { completeness: "complete", findings },
    },
    resolvedModel: null,
  });
};

const plan = planBatch({
  corpus,
  arms: ["candidate"],
  seed: EVALUATION_ID,
  repetitions: 1,
});

/** One shard of the fixture batch, as `run` writes it. */
const shardFixture = async (index: number, total: number) => ({
  lineage: "codex/brokered/openai/gpt-5.6-sol/verify/standard",
  kind: "first-qualification",
  candidate: candidateRevision,
  baseline: null,
  corpusVersion: corpus.version,
  scoringVersion,
  repetitions: 1,
  evaluationId: EVALUATION_ID,
  shard: { index, total },
  startedAt: `2026-01-0${index}T00:00:00.000Z`,
  completedAt: `2026-01-0${index}T01:00:00.000Z`,
  records: await runBatch({
    plan: { trials: shardOf(plan.trials, { index, total }) },
    corpus,
    runTrial: perfectReviewer,
  }),
});

const shardFiles = (shards: readonly unknown[]) => {
  const root = mkdtempSync(path.join(tmpdir(), "gate-records-"));
  return shards.map((shard, position) => {
    const file = path.join(root, `gate-records-${position}.json`);
    writeFileSync(file, JSON.stringify(shard));
    return file;
  });
};

/** A ledger root holding one standing baseline. */
const ledgerWith = (baseline: Partial<BaselinePointer>) => {
  const root = mkdtempSync(path.join(tmpdir(), "gate-ledger-"));
  const directory = ledgerDirectory(root, PHASE0_LINEAGE);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "baseline.json"),
    JSON.stringify({
      revisionId: "revision",
      gitSha: BASELINE_SHA,
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "report",
      setAt: "2026-01-01T00:00:00.000Z",
      reason: "first-qualification",
      chainBroken: false,
      ...baseline,
    })
  );
  return root;
};

describe(resolveArms, () => {
  it("judges the standing baseline when a requalification names it", async () => {
    const arms = await resolveArms({
      kind: "requalification",
      candidate: BASELINE_SHA,
      ledger: ledgerWith({}),
    });
    expect(arms.candidate).toBe(BASELINE_SHA);
    expect(arms.baseline).toBeNull();
  });

  it("refuses a requalification aimed at another revision", async () => {
    await expect(
      resolveArms({
        kind: "requalification",
        candidate: "b".repeat(40),
        ledger: ledgerWith({}),
      })
    ).rejects.toThrow(
      `a requalification judges the standing baseline ${BASELINE_SHA}; to move the baseline use score --rebase`
    );
  });

  it("requires the preflight requalification even when the baseline is given", async () => {
    await expect(
      resolveArms({
        kind: "promotion",
        baseline: BASELINE_SHA,
        ledger: ledgerWith({ corpusVersion: "older" }),
      })
    ).rejects.toThrow(/run a requalification of the baseline first/u);
  });

  it("compares against an explicit baseline once the versions agree", async () => {
    const arms = await resolveArms({
      kind: "promotion",
      candidate: "c".repeat(40),
      baseline: "d".repeat(40),
      ledger: ledgerWith({}),
    });
    expect(arms.baseline).toBe("d".repeat(40));
  });
});

describe(planOutput, () => {
  it("names the evaluated candidate and baseline for the workflow", () => {
    expect(
      planOutput({
        candidate: { ...candidateRevision },
        baseline: { ...candidateRevision, gitSha: BASELINE_SHA },
      })
    ).toBe(`candidate=${CANDIDATE_SHA}\nbaseline=${BASELINE_SHA}\n`);
  });

  it("leaves the baseline empty when there is no comparison arm", () => {
    expect(planOutput({ candidate: candidateRevision, baseline: null })).toBe(
      `candidate=${CANDIDATE_SHA}\nbaseline=\n`
    );
  });
});

describe(readShards, () => {
  it("reports which shards of the batch never arrived", async () => {
    const files = shardFiles([await shardFixture(1, 3)]);
    const read = await readShards(files, "first-qualification", corpus.version);
    expect(read.shards).toHaveLength(1);
    expect(read.missing).toStrictEqual([2, 3]);
    expect(read.first.evaluationId).toBe(EVALUATION_ID);
  });

  it("refuses two records of the same shard", async () => {
    const files = shardFiles([
      await shardFixture(1, 2),
      await shardFixture(1, 2),
    ]);
    await expect(
      readShards(files, "first-qualification", corpus.version)
    ).rejects.toThrow(/shard 1 of 2 was recorded twice/u);
  });

  it("refuses records taken for another kind", async () => {
    const files = shardFiles([await shardFixture(1, 1)]);
    await expect(
      readShards(files, "promotion", corpus.version)
    ).rejects.toThrow(/not a promotion/u);
  });
});

describe(assembleReport, () => {
  it("scores a complete batch", async () => {
    const shards = [await shardFixture(1, 2), await shardFixture(2, 2)];
    const { report, records, lost } = assembleReport({
      corpus,
      first: shards[0],
      shards,
      now: "2026-01-03T00:00:00.000Z",
    });
    expect(records).toHaveLength(plan.trials.length);
    expect(lost).toStrictEqual([]);
    expect(report.validity).toStrictEqual({ status: "valid" });
    expect(report.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(report.completedAt).toBe("2026-01-02T01:00:00.000Z");
  });

  it("reports a batch with a lost shard INVALID", async () => {
    const shards = [await shardFixture(1, 2)];
    const { report, records } = assembleReport({
      corpus,
      first: shards[0],
      shards,
      now: "2026-01-03T00:00:00.000Z",
    });
    expect(records).toHaveLength(plan.trials.length);
    expect(report.outcome).toBe("INVALID");
    expect(report.scores).toBeNull();
    expect(report.validity).toMatchObject({ status: "INVALID" });
  });

  it("records a lost shard's trials as one non-retryable invalid attempt", async () => {
    const shards = [await shardFixture(1, 2)];
    const { records, lost } = assembleReport({
      corpus,
      first: shards[0],
      shards,
      now: "2026-01-03T00:00:00.000Z",
    });
    expect(lost).toHaveLength(plan.trials.length / 2);
    const synthesized = records.find((record) =>
      lost.includes(record.trial.id)
    );
    expect(synthesized?.attempts).toHaveLength(1);
    expect(synthesized?.judgement).toStrictEqual({
      status: "invalid",
      fault: "ephemeral_runner_lost",
      retryable: false,
      detail: "shard 2 of 2 recorded no result for this trial",
    });
  });

  it("refuses two records of the same trial", async () => {
    const shard = await shardFixture(1, 2);
    expect(() =>
      assembleReport({ corpus, first: shard, shards: [shard, shard] })
    ).toThrow(/twice/u);
  });

  it("refuses a record outside the planned batch", async () => {
    const shard = await shardFixture(1, 2);
    const stray = structuredClone(shard);
    const [first] = stray.records;
    if (first) {
      first.trial.id = "candidate/nowhere/control/0";
    }
    expect(() =>
      assembleReport({ corpus, first: shard, shards: [stray] })
    ).toThrow(/candidate\/nowhere\/control\/0/u);
  });

  it("refuses records taken for another candidate than the one planned", async () => {
    const shard = await shardFixture(1, 1);
    expect(() =>
      assembleReport({
        corpus,
        first: shard,
        shards: [shard],
        candidateSha: BASELINE_SHA,
      })
    ).toThrow(`the records qualified ${CANDIDATE_SHA}, not ${BASELINE_SHA}`);
  });
});

/** Run the CLI, however it ends: a refusal is an exit status, not a crash. */
const runCli = async (args: readonly string[]) => {
  const argv = [path.join(import.meta.dirname, "qualify.mjs"), ...args];
  try {
    const ran = await execFileAsync(process.execPath, argv);
    return { code: 0, ...ran };
  } catch (error) {
    // SAFETY: `execFile` rejects only with its own failure, which carries the
    // exit status and both captured streams.
    const failed = error as { code: number; stdout: string; stderr: string };
    return failed;
  }
};

describe("score", () => {
  it("writes a durable INVALID report for a batch that lost a shard", async () => {
    const [records] = shardFiles([await shardFixture(1, 2)]);
    const root = mkdtempSync(path.join(tmpdir(), "gate-score-"));
    const out = path.join(root, "report.json");
    const scored = await runCli([
      "score",
      "--kind",
      "first-qualification",
      "--records",
      records ?? "",
      "--out",
      out,
      "--ledger",
      root,
    ]);
    expect(scored.code).toBe(1);
    expect(JSON.parse(scored.stdout)).toMatchObject({
      candidate: CANDIDATE_SHA,
      outcome: "INVALID",
      promotable: false,
      lostTrials: plan.trials.length / 2,
    });
    expect(JSON.parse(readFileSync(out, "utf-8")).outcome).toBe("INVALID");
  });

  it("refuses records that qualified another commit", async () => {
    const [records] = shardFiles([await shardFixture(1, 1)]);
    const refused = await runCli([
      "score",
      "--kind",
      "first-qualification",
      "--records",
      records ?? "",
      "--candidate-sha",
      BASELINE_SHA,
      "--ledger",
      mkdtempSync(path.join(tmpdir(), "gate-score-")),
    ]);
    expect(refused.stderr).toContain(
      `the records qualified ${CANDIDATE_SHA}, not ${BASELINE_SHA}`
    );
  });
});
