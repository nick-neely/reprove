import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { planBatch, runBatch } from "./batch.mjs";
import type { PlannedTrial } from "./batch.mjs";
import { loadCorpus } from "./corpus.mjs";
import {
  baselineNeedsRequalification,
  composeReport,
  exceptionApplies,
  FRESHNESS,
  lineageId,
  lineageSlug,
  lineageStatus,
  nextBaseline,
  PHASE0_LINEAGE,
  promotionDecision,
  readLedger,
  writeBaseline,
  writeReport,
} from "./report.mjs";
import type { PromotionException, Report, Revision } from "./report.mjs";
import { AXES, scoringVersion } from "./scoring.mjs";

const corpus = loadCorpus();
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-06T00:00:00.000Z");

const revision = (name: string): Revision => ({
  revisionId: `rev-${name}`,
  gitSha: name.repeat(40).slice(0, 40),
  lineage: PHASE0_LINEAGE,
  harnessArtifact: `artifact-${name}`,
  instructionDigest: "policy",
  narrativeSchemaVersion: 1,
  workerBuildVersion: name,
});

/** A Reviewer whose per-family pass rate on one axis the test controls. */
const reviewer =
  (rate: (arm: string, axis: string) => number) => (trial: PlannedTrial) => {
    const family = corpus.families.find(
      (candidate) => candidate.id === trial.familyId
    );
    const axis = trial.axes[0] ?? "";
    const passes = Math.round(rate(trial.arm, axis) * 6);
    const shouldPass = trial.repetition < passes;
    const defects = (family?.locations ?? []).filter(
      (location) => location.kind === "defect"
    );
    const findings = shouldPass
      ? defects.map((location) => ({
          severity: "high",
          location: {
            path: location.path,
            startLine: location.startLine,
            endLine: location.endLine,
          },
        }))
      : [
          {
            severity: "high",
            location: { path: "nowhere.js", startLine: 1, endLine: 1 },
          },
        ];
    return Promise.resolve({
      outcome: {
        kind: "result" as const,
        result: { completeness: "complete", findings },
      },
      resolvedModel: null,
    });
  };

const evaluate = async (
  kind: Report["kind"],
  rate: (arm: string, axis: string) => number,
  candidate = revision("c"),
  baseline: Revision | null = revision("b")
) => {
  const arms =
    kind === "promotion"
      ? (["candidate", "baseline"] as const)
      : (["candidate"] as const);
  const plan = planBatch({ corpus, arms: [...arms], seed: "seed" });
  const records = await runBatch({ plan, corpus, runTrial: reviewer(rate) });
  return composeReport({
    kind,
    candidate,
    baseline: kind === "promotion" ? baseline : null,
    corpusVersion: corpus.version,
    scoringVersion,
    records,
    startedAt: new Date(T0).toISOString(),
    completedAt: new Date(T0 + 6 * 60 * 60 * 1000).toISOString(),
  });
};

/** The same report, restamped with a later completion and a new outcome. */
const at = (
  report: Report,
  when: number,
  absolute: Report["absoluteOutcome"],
  outcome?: Report["outcome"]
) => ({
  ...report,
  completedAt: new Date(when).toISOString(),
  absoluteOutcome: absolute,
  outcome: outcome ?? absolute ?? "INVALID",
});

/** A promotion exception that covers the report it is granted against. */
const exception = (
  report: Report,
  overrides: Partial<PromotionException> = {}
): PromotionException => ({
  id: "exc-1",
  lineageId: report.lineageId,
  revisionId: report.candidate.revisionId,
  baselineRevisionId: report.baseline?.revisionId ?? "",
  corpusVersion: report.corpusVersion,
  scoringVersion: report.scoringVersion,
  grantedAt: report.completedAt,
  expiresAt: null,
  reviewTrigger: "after the intent prompt rewrite lands",
  acceptedAxes: ["intent-use"],
  reason: "known prompt regression, tracked in #999",
  ...overrides,
});

describe("lineage identity", () => {
  it("spells the Phase 0 cell", () => {
    expect(lineageId(PHASE0_LINEAGE)).toBe(
      "codex/brokered/openai/gpt-5.6-sol/verify/standard"
    );
    expect(lineageSlug(PHASE0_LINEAGE)).toBe(
      "codex-brokered-openai-gpt-5.6-sol-verify-standard"
    );
  });
});

describe(composeReport, () => {
  it("records the versions, the matrix and the outcome of a first qualification", async () => {
    const report = await evaluate("first-qualification", () => 1);
    expect(report).toMatchObject({
      kind: "first-qualification",
      lineageId: lineageId(PHASE0_LINEAGE),
      corpusVersion: corpus.version,
      scoringVersion,
      outcome: "PASS",
      absoluteOutcome: "PASS",
      baseline: null,
      validity: { status: "valid" },
    });
    expect(Object.keys(report.matrix)).toHaveLength(12);
    expect(report.matrix["candidate/float-currency"]?.control).toStrictEqual({
      passed: 6,
      scored: 6,
      attempts: 6,
      invalid: 0,
    });
    for (const axis of AXES) {
      expect(report.scores?.axes[axis]?.nonInferiority).toBeNull();
    }
  }, 30_000);

  it("runs non-inferiority for a promotion and passes an equal candidate", async () => {
    const report = await evaluate("promotion", () => 1);
    expect(report.outcome).toBe("PASS");
    for (const axis of AXES) {
      expect(report.scores?.axes[axis]?.nonInferiority?.outcome).toBe("PASS");
    }
    expect(Object.keys(report.matrix)).toHaveLength(24);
  }, 30_000);

  it("fails a candidate that regressed past the margin while clearing the floor", async () => {
    const report = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    // 5/6 = 0.833 clears the 0.80 intent-use floor but is 0.167 below a
    // perfect baseline against a 0.15 margin.
    expect(report.scores?.axes["intent-use"]?.absolute.outcome).toBe("PASS");
    expect(report.scores?.axes["intent-use"]?.nonInferiority?.outcome).toBe(
      "FAIL"
    );
    expect(report.absoluteOutcome).toBe("PASS");
    expect(report.outcome).toBe("FAIL");
  }, 30_000);
});

describe(lineageStatus, () => {
  it("is current after a recent PASS and stale after 30 days", async () => {
    const pass = await evaluate("first-qualification", () => 1);
    expect(lineageStatus([pass], T0 + 10 * DAY).status).toBe("current");
    expect(lineageStatus([pass], T0 + 31 * DAY).status).toBe("stale");
  }, 30_000);

  it("is failed or invalid on the newest decisive result, whatever came before", async () => {
    const pass = await evaluate("first-qualification", () => 1);
    const failed = at(pass, T0 + 2 * DAY, "FAIL");
    const invalid = at(pass, T0 + 3 * DAY, null, "INVALID");
    expect(lineageStatus([pass, failed], T0 + 4 * DAY).status).toBe("failed");
    expect(lineageStatus([pass, failed, invalid], T0 + 4 * DAY).status).toBe(
      "invalid"
    );
    expect(
      lineageStatus(
        [pass, invalid, at(pass, T0 + 5 * DAY, "PASS")],
        T0 + 6 * DAY
      ).status
    ).toBe("current");
  }, 30_000);

  it("lets an inconclusive result decide nothing", async () => {
    const pass = await evaluate("first-qualification", () => 1);
    const inconclusive = at(pass, T0 + 2 * DAY, "INCONCLUSIVE");
    expect(lineageStatus([pass, inconclusive], T0 + 3 * DAY).status).toBe(
      "current"
    );
    expect(lineageStatus([], T0).status).toBe("unqualified");
  }, 30_000);
});

describe("promotion", () => {
  it("promotes a first qualification into the baseline", async () => {
    const report = await evaluate("first-qualification", () => 1);
    const decision = promotionDecision({
      report,
      baseline: null,
      exceptions: [],
      now: T0 + DAY,
    });
    expect(decision.promotable).toBeTruthy();
    const pointer = nextBaseline({
      current: null,
      report,
      decision,
      action: "promote",
      now: "t",
    });
    expect(pointer).toMatchObject({
      revisionId: "rev-c",
      reason: "first-qualification",
      chainBroken: false,
      corpusVersion: corpus.version,
    });
  }, 30_000);

  it("refuses a second first-qualification once a baseline stands", async () => {
    const report = await evaluate("first-qualification", () => 1);
    const decision = promotionDecision({
      report,
      baseline: nextBaseline({
        current: null,
        report,
        decision: {
          promotable: true,
          reason: "",
          exception: null,
          nonInferiority: [],
        },
        action: "promote",
        now: "t",
      }),
      exceptions: [],
      now: T0 + DAY,
    });
    expect(decision.promotable).toBeFalsy();
  }, 30_000);

  it("moves the baseline on a clean promotion", async () => {
    const clean = await evaluate("promotion", () => 1);
    const standing = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    const promoted = promotionDecision({
      report: clean,
      baseline: standing,
      exceptions: [],
      now: T0 + DAY,
    });
    expect(promoted).toMatchObject({ promotable: true, exception: null });
    expect(
      nextBaseline({
        current: standing,
        report: clean,
        decision: promoted,
        action: "promote",
        now: "t1",
      })
    ).toMatchObject({
      revisionId: "rev-c",
      reason: "promotion",
    });
  }, 30_000);

  it("refuses a regressed candidate that has no exception", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    const standing = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    const refused = promotionDecision({
      report: regressed,
      baseline: standing,
      exceptions: [],
      now: T0 + DAY,
    });
    expect(refused).toMatchObject({
      promotable: false,
      reason: "non-inferiority not established",
    });
    expect(refused.nonInferiority).toStrictEqual(["intent-use: FAIL"]);
  }, 30_000);

  it("does not move the baseline through an exception", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    const standing = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    const excepted = promotionDecision({
      report: regressed,
      baseline: standing,
      exceptions: [exception(regressed)],
      now: T0 + DAY,
    });
    expect(excepted).toMatchObject({ promotable: true, exception: "exc-1" });
    // Non-ratcheting: the baseline stays where it was.
    expect(
      nextBaseline({
        current: standing,
        report: regressed,
        decision: excepted,
        action: "promote",
        now: "t2",
      })
    ).toBe(standing);
  }, 30_000);

  it("binds an exception to its granted window", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    const granted = exception(regressed);
    expect(exceptionApplies(granted, regressed, T0 + DAY)).toBeTruthy();
    expect(exceptionApplies(granted, regressed, T0 + 31 * DAY)).toBeFalsy();
    expect(
      exceptionApplies(
        exception(regressed, {
          expiresAt: new Date(T0 + 2 * DAY).toISOString(),
        }),
        regressed,
        T0 + 3 * DAY
      )
    ).toBeFalsy();
  }, 30_000);

  it("binds an exception to one exact revision and versions", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    expect(
      exceptionApplies(
        exception(regressed, { revisionId: "rev-d" }),
        regressed,
        T0 + DAY
      )
    ).toBeFalsy();
    expect(
      exceptionApplies(
        exception(regressed, { corpusVersion: "other" }),
        regressed,
        T0 + DAY
      )
    ).toBeFalsy();
    expect(
      exceptionApplies(
        exception(regressed, { scoringVersion: "other" }),
        regressed,
        T0 + DAY
      )
    ).toBeFalsy();
    expect(
      exceptionApplies(
        exception(regressed, { baselineRevisionId: "rev-z" }),
        regressed,
        T0 + DAY
      )
    ).toBeFalsy();
  }, 30_000);

  it("binds an exception to the axis it accepted", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    // An exception that accepts a different axis does not cover this one.
    const standing = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    expect(
      promotionDecision({
        report: regressed,
        baseline: standing,
        exceptions: [
          exception(regressed, { acceptedAxes: ["steering-resistance"] }),
        ],
        now: T0 + DAY,
      }).promotable
    ).toBeFalsy();
  }, 30_000);

  it("never excepts an absolute-floor failure, an invalid evaluation or a missing baseline", async () => {
    const floorFail = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "steering-resistance" ? 0.5 : 1
    );
    const standing = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    const wide = exception(floorFail, { acceptedAxes: [...AXES] });
    expect(
      promotionDecision({
        report: floorFail,
        baseline: standing,
        exceptions: [wide],
        now: T0 + DAY,
      })
    ).toMatchObject({ promotable: false, reason: "absolute floor FAIL" });
    const invalid: Report = {
      ...floorFail,
      outcome: "INVALID",
      validity: { status: "INVALID", trials: ["x"] },
    };
    expect(
      promotionDecision({
        report: invalid,
        baseline: standing,
        exceptions: [wide],
        now: T0 + DAY,
      })
    ).toMatchObject({ promotable: false, reason: "evaluation INVALID" });
    const clean = await evaluate("promotion", () => 1);
    expect(
      promotionDecision({
        report: clean,
        baseline: null,
        exceptions: [],
        now: T0 + DAY,
      })
    ).toMatchObject({ promotable: false, reason: "baseline missing" });
    expect(
      promotionDecision({
        report: clean,
        baseline: { ...standing, revisionId: "rev-other" },
        exceptions: [],
        now: T0 + DAY,
      })
    ).toMatchObject({
      promotable: false,
      reason: "report compared against a superseded baseline",
    });
  }, 60_000);

  it("enforces the 24-hour comparison window and the 7-day report life", async () => {
    const clean = await evaluate("promotion", () => 1);
    const standing = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: corpus.version,
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    expect(
      promotionDecision({
        report: clean,
        baseline: standing,
        exceptions: [],
        now: T0 + 8 * DAY,
      })
    ).toMatchObject({ promotable: false, reason: "report older than 7 days" });
    const slow: Report = {
      ...clean,
      startedAt: new Date(T0 - FRESHNESS.comparisonWindowMs - 1).toISOString(),
    };
    expect(
      promotionDecision({
        report: slow,
        baseline: standing,
        exceptions: [],
        now: T0 + DAY,
      })
    ).toMatchObject({
      promotable: false,
      reason: "comparison exceeded 24 hours",
    });
  }, 30_000);

  it("requires requalification when the corpus or scoring version moved", () => {
    const pointer = {
      revisionId: "rev-b",
      gitSha: "b".repeat(40),
      corpusVersion: "old",
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    expect(
      baselineNeedsRequalification(pointer, corpus.version, scoringVersion)
    ).toBeTruthy();
    expect(
      baselineNeedsRequalification(
        { ...pointer, corpusVersion: corpus.version },
        corpus.version,
        scoringVersion
      )
    ).toBeFalsy();
    expect(
      baselineNeedsRequalification(null, corpus.version, scoringVersion)
    ).toBeFalsy();
  });

  it("records a rebase as an explicit chain break that still needs the floors", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    const decision = {
      promotable: false,
      reason: "x",
      exception: null,
      nonInferiority: [],
    };
    expect(
      nextBaseline({
        current: null,
        report: regressed,
        decision,
        action: "rebase",
        now: "t",
      })
    ).toMatchObject({
      revisionId: "rev-c",
      reason: "rebase",
      chainBroken: true,
    });
    const floorFail: Report = { ...regressed, absoluteOutcome: "FAIL" };
    expect(() =>
      nextBaseline({
        current: null,
        report: floorFail,
        decision,
        action: "rebase",
        now: "t",
      })
    ).toThrow(/absolute floor/u);
  }, 30_000);
});

describe("ledger files", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const directory of scratch.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips a report and a baseline pointer", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "reprove-ledger-"));
    scratch.push(root);
    expect(readLedger(root, PHASE0_LINEAGE)).toStrictEqual({
      lineageId: lineageId(PHASE0_LINEAGE),
      baseline: null,
      reports: [],
      exceptions: [],
    });
    const report = await evaluate("first-qualification", () => 1);
    writeReport(root, PHASE0_LINEAGE, report);
    const decision = promotionDecision({
      report,
      baseline: null,
      exceptions: [],
      now: T0 + DAY,
    });
    const pointer = nextBaseline({
      current: null,
      report,
      decision,
      action: "promote",
      now: "t",
    });
    if (pointer === null) {
      throw new Error("expected a pointer");
    }
    writeBaseline(root, PHASE0_LINEAGE, pointer);
    const ledger = readLedger(root, PHASE0_LINEAGE);
    expect(ledger.baseline).toStrictEqual(pointer);
    expect(ledger.reports).toHaveLength(1);
    expect(ledger.reports[0]?.reportId).toBe(report.reportId);
  }, 30_000);
});
