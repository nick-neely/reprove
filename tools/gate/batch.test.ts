import { describe, expect, it } from "vitest";

import { batchValidity, planBatch, runBatch, scoredTrials } from "./batch.mjs";
import type { PlannedTrial } from "./batch.mjs";
import { loadCorpus } from "./corpus.mjs";
import { TrialFaultError } from "./evaluate.mjs";

const corpus = loadCorpus();

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

describe(planBatch, () => {
  it("spends exactly the fixed budget from #34", () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate", "baseline"],
      seed: "id",
    });
    expect(plan.trials).toHaveLength(576);
    expect(
      plan.trials.filter((trial) => trial.arm === "candidate")
    ).toHaveLength(288);
    expect(new Set(plan.trials.map((trial) => trial.id)).size).toBe(576);
  });

  it("interleaves the arms in a seeded, reproducible order", () => {
    const first = planBatch({
      corpus,
      arms: ["candidate", "baseline"],
      seed: "id",
    });
    const again = planBatch({
      corpus,
      arms: ["candidate", "baseline"],
      seed: "id",
    });
    const other = planBatch({
      corpus,
      arms: ["candidate", "baseline"],
      seed: "other",
    });
    expect(again.trials.map((trial) => trial.id)).toStrictEqual(
      first.trials.map((trial) => trial.id)
    );
    expect(other.trials.map((trial) => trial.id)).not.toStrictEqual(
      first.trials.map((trial) => trial.id)
    );
    // Not two blocks: the first hundred trials hold both arms.
    const arms = new Set(first.trials.slice(0, 100).map((trial) => trial.arm));
    expect(arms.size).toBe(2);
  });

  it("plans a single arm for a first qualification", () => {
    expect(
      planBatch({ corpus, arms: ["candidate"], seed: "id" }).trials
    ).toHaveLength(288);
  });

  it("rejects a budget that is not a positive integer", () => {
    expect(() =>
      planBatch({ corpus, arms: ["candidate"], seed: "id", repetitions: 0 })
    ).toThrow(RangeError);
  });
});

describe(runBatch, () => {
  it("scores every trial of a perfect Reviewer", async () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate"],
      seed: "id",
      repetitions: 1,
    });
    const records = await runBatch({ plan, corpus, runTrial: perfectReviewer });
    expect(records).toHaveLength(48);
    expect(batchValidity(records)).toStrictEqual({ status: "valid" });
    const scored = scoredTrials(records);
    expect(scored.every((trial) => trial.passed)).toBeTruthy();
  });

  it("retries a retryable fault exactly once and keeps both attempts", async () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate"],
      seed: "id",
      repetitions: 1,
    });
    const seen = new Map<string, number>();
    const records = await runBatch({
      plan,
      corpus,
      runTrial: (trial) => {
        const count = (seen.get(trial.id) ?? 0) + 1;
        seen.set(trial.id, count);
        if (count === 1) {
          throw new TrialFaultError(
            "provider_transport_unavailable",
            "connection reset"
          );
        }
        return perfectReviewer(trial);
      },
    });
    expect(
      records.every((record) => record.attempts.length === 2)
    ).toBeTruthy();
    expect(records[0]?.attempts[0]?.verdict).toMatchObject({
      status: "invalid",
    });
    expect(records[0]?.verdict).toMatchObject({
      status: "scored",
      passed: true,
    });
    expect(batchValidity(records)).toStrictEqual({ status: "valid" });
  });

  it("gives up after the one retry and reports the evaluation INVALID", async () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate"],
      seed: "id",
      repetitions: 1,
    });
    const records = await runBatch({
      plan,
      corpus,
      runTrial: (trial) =>
        trial.familyId === "retry-helper"
          ? Promise.reject(
              new TrialFaultError(
                "sandbox_provisioning_transient",
                "no runtime"
              )
            )
          : perfectReviewer(trial),
    });
    const failed = records.filter(
      (record) => record.verdict.status === "invalid"
    );
    expect(failed).toHaveLength(4);
    expect(failed.every((record) => record.attempts.length === 2)).toBeTruthy();
    expect(batchValidity(records)).toMatchObject({ status: "INVALID" });
  });

  it("does not retry a behavioral miss", async () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate"],
      seed: "id",
      repetitions: 1,
    });
    const records = await runBatch({
      plan,
      corpus,
      runTrial: () =>
        Promise.resolve({
          outcome: {
            kind: "failure" as const,
            failure: {
              reason: "pass_failed",
              detail: "codex_execution_failed",
            },
          },
          resolvedModel: null,
        }),
    });
    expect(
      records.every((record) => record.attempts.length === 1)
    ).toBeTruthy();
    expect(scoredTrials(records).every((trial) => !trial.passed)).toBeTruthy();
  });

  it("reports a Model-pin contract failure with no behavioral score", async () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate"],
      seed: "id",
      repetitions: 1,
    });
    const records = await runBatch({
      plan,
      corpus,
      runTrial: (trial) =>
        trial.id.endsWith("/0") && trial.familyId === "float-currency"
          ? Promise.resolve({
              outcome: {
                kind: "failure" as const,
                failure: {
                  reason: "model_substituted",
                  detail: "resolved gpt-other",
                },
              },
              resolvedModel: "gpt-other",
            })
          : perfectReviewer(trial),
    });
    expect(batchValidity(records)).toMatchObject({ status: "CONTRACT_FAIL" });
  });

  it("stops when its signal aborts", async () => {
    const plan = planBatch({
      corpus,
      arms: ["candidate"],
      seed: "id",
      repetitions: 1,
    });
    const controller = new AbortController();
    let ran = 0;
    await expect(
      runBatch({
        plan,
        corpus,
        signal: controller.signal,
        runTrial: (trial) => {
          ran += 1;
          if (ran === 3) {
            controller.abort();
          }
          return perfectReviewer(trial);
        },
      })
    ).rejects.toThrow(/aborted/u);
    expect(ran).toBe(3);
  });
});
