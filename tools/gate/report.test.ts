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
  protocolVersion: 1,
  reasoningEffort: "medium",
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

/** The same report, rerun whole: started then, finished six hours later. */
const ran = (report: Report, when: number): Report => ({
  ...report,
  startedAt: new Date(when).toISOString(),
  completedAt: new Date(when + 6 * 60 * 60 * 1000).toISOString(),
});

/** The decision the ledger records on a comparison that promoted outright. */
const PROMOTED = {
  promotable: true,
  reason: "every test passed",
  exception: null,
};

/** The same report, carrying the decision the ledger made on it. */
const decided = (report: Report, decision: Report["decision"]): Report => ({
  ...report,
  decision,
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
  revokedAt: null,
  triggerFiredAt: null,
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

  it("runs the 30-day clock from the last PASS, not from an inconclusive result", async () => {
    // An inconclusive requalification decided nothing, so it neither
    // refreshes nor breaks currency: the clock still runs from the PASS.
    const pass = await evaluate("first-qualification", () => 1);
    const reports = [
      pass,
      at(pass, T0 + 20 * DAY, "INCONCLUSIVE"),
      at(pass, T0 + 40 * DAY, "INCONCLUSIVE"),
    ];
    const state = lineageStatus(reports, T0 + 41 * DAY);
    expect(state.status).toBe("stale");
    expect(state.lastPass?.completedAt).toBe(pass.completedAt);
  }, 30_000);

  it("does not take a candidate comparison as evidence about the baseline", async () => {
    // The review's scenario: the standing baseline failed its scheduled
    // requalification, then a candidate compared cleanly against it. The
    // comparison says nothing about the baseline being qualified, so the
    // lineage stays failed.
    const requalification = at(
      await evaluate("requalification", () => 1),
      T0 + 2 * DAY,
      "FAIL"
    );
    const comparison = ran(await evaluate("promotion", () => 1), T0 + 3 * DAY);
    expect(comparison.outcome).toBe("PASS");
    expect(
      lineageStatus([requalification, comparison], T0 + 4 * DAY)
    ).toMatchObject({ status: "failed" });
  }, 60_000);

  it("takes a promotion as evidence only when it could actually promote", async () => {
    const first = await evaluate("first-qualification", () => 1);
    // A clean promotion off a current lineage made its candidate the
    // baseline, having passed every floor, so it refreshes the lineage.
    const promoted = decided(
      ran(await evaluate("promotion", () => 1), T0 + 10 * DAY),
      PROMOTED
    );
    expect(lineageStatus([first, promoted], T0 + 35 * DAY).status).toBe(
      "current"
    );
    // The same comparison run against a lineage that had already gone stale
    // could not have promoted anything, so it does not refresh it either.
    // Each of the remaining reports carries a promoting decision, so only the
    // clause under test can reject it.
    const tooLate = decided(
      ran(await evaluate("promotion", () => 1), T0 + 40 * DAY),
      PROMOTED
    );
    expect(lineageStatus([first, tooLate], T0 + 41 * DAY).status).toBe("stale");
    // Nor does a comparison that did not itself pass every test.
    const regressed = decided(
      ran(
        await evaluate("promotion", (arm, axis) =>
          arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
        ),
        T0 + 10 * DAY
      ),
      PROMOTED
    );
    expect(regressed.outcome).toBe("FAIL");
    expect(regressed.absoluteOutcome).toBe("PASS");
    expect(lineageStatus([first, regressed], T0 + 35 * DAY).status).toBe(
      "stale"
    );
  }, 90_000);

  it("takes a promotion as evidence only when the ledger promoted it", async () => {
    const first = await evaluate("first-qualification", () => 1);
    const comparison = ran(await evaluate("promotion", () => 1), T0 + 10 * DAY);
    expect(comparison.outcome).toBe("PASS");
    // A comparison the ledger refused - here against a baseline that had
    // already been superseded - is written to the ledger all the same, and it
    // moved nothing, so it is not evidence about the standing revision.
    const refused = decided(comparison, {
      promotable: false,
      reason: "report compared against a superseded baseline",
      exception: null,
    });
    expect(lineageStatus([first, refused], T0 + 35 * DAY).status).toBe("stale");
    // The same comparison, promoted, made its candidate the baseline.
    expect(
      lineageStatus([first, decided(comparison, PROMOTED)], T0 + 35 * DAY)
        .status
    ).toBe("current");
    // A promotion through an exception leaves the pointer where it was, so
    // the standing revision is no fresher than it was before.
    const excepted = decided(comparison, {
      promotable: true,
      reason: "non-inferiority accepted by exception",
      exception: "exc-1",
    });
    expect(lineageStatus([first, excepted], T0 + 35 * DAY).status).toBe(
      "stale"
    );
    // A report written before the decision was recorded says nothing either.
    expect(lineageStatus([first, comparison], T0 + 35 * DAY).status).toBe(
      "stale"
    );
  }, 60_000);
});

/** A lineage state to decide against, as `lineageStatus` reports one. */
const lineage = (status: ReturnType<typeof lineageStatus>["status"]) => ({
  status,
  latest: null,
  lastPass: null,
});

describe("promotion", () => {
  it("promotes a first qualification into the baseline", async () => {
    const report = await evaluate("first-qualification", () => 1);
    const decision = promotionDecision({
      report,
      baseline: null,
      exceptions: [],
      lineage: lineage("unqualified"),
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
      lineage: lineage("current"),
      now: T0 + DAY,
    });
    expect(decision.promotable).toBeFalsy();
  }, 30_000);

  it("lets a requalification re-judge only the standing baseline", async () => {
    const standing = {
      revisionId: "rev-c",
      gitSha: "c".repeat(40),
      corpusVersion: "old",
      scoringVersion,
      reportId: "r0",
      setAt: "t0",
      reason: "first-qualification" as const,
      chainBroken: false,
    };
    const ofBaseline = await evaluate("requalification", () => 1);
    const accepted = promotionDecision({
      report: ofBaseline,
      baseline: standing,
      exceptions: [],
      lineage: lineage("stale"),
      now: T0 + DAY,
    });
    expect(accepted).toMatchObject({ promotable: true });
    expect(
      nextBaseline({
        current: standing,
        report: ofBaseline,
        decision: accepted,
        action: "promote",
        now: "t1",
      })
    ).toMatchObject({
      revisionId: "rev-c",
      reason: "requalification",
      chainBroken: false,
      corpusVersion: corpus.version,
    });
    const ofStranger = await evaluate(
      "requalification",
      () => 1,
      revision("d")
    );
    expect(
      promotionDecision({
        report: ofStranger,
        baseline: standing,
        exceptions: [],
        lineage: lineage("current"),
        now: T0 + DAY,
      })
    ).toMatchObject({
      promotable: false,
      reason: "requalification must evaluate the standing baseline",
    });
    expect(
      promotionDecision({
        report: ofStranger,
        baseline: null,
        exceptions: [],
        lineage: lineage("current"),
        now: T0 + DAY,
      })
    ).toMatchObject({ promotable: false, reason: "baseline missing" });
  }, 60_000);

  it("refuses a promotion while the lineage is not current", async () => {
    // #34: "a non-current state blocks promotion". A clean comparison against
    // a baseline that is failed, stale, invalid or never qualified proves
    // nothing about the baseline it was compared against.
    const clean = ran(await evaluate("promotion", () => 1), T0 + 3 * DAY);
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
    const requalification = at(
      await evaluate("requalification", () => 1),
      T0 + 2 * DAY,
      "FAIL"
    );
    const decide = (state: ReturnType<typeof lineageStatus>) =>
      promotionDecision({
        report: clean,
        baseline: standing,
        exceptions: [],
        lineage: state,
        now: T0 + 4 * DAY,
      });
    expect(
      decide(lineageStatus([requalification], T0 + 4 * DAY))
    ).toMatchObject({
      promotable: false,
      reason: "lineage not current: failed",
    });
    for (const status of ["stale", "invalid", "unqualified"] as const) {
      expect(decide(lineage(status))).toMatchObject({
        promotable: false,
        reason: `lineage not current: ${status}`,
      });
    }
    expect(decide(lineage("current"))).toMatchObject({ promotable: true });
  }, 60_000);

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
      lineage: lineage("current"),
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
      lineage: lineage("current"),
      now: T0 + DAY,
    });
    expect(refused).toMatchObject({
      promotable: false,
      reason: "non-inferiority not established",
    });
    expect(refused.nonInferiority).toStrictEqual([
      { axis: "intent-use", outcome: "FAIL" },
    ]);
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
      lineage: lineage("current"),
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

  it("stops applying an exception once its review trigger fired", async () => {
    // #34 expires an exception at the earliest of time, a revision or version
    // change, or its explicit review trigger. The trigger is prose, so a
    // maintainer records the instant it fired, and it bites from that instant.
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    const fired = exception(regressed, {
      triggerFiredAt: new Date(T0 + 2 * DAY).toISOString(),
    });
    expect(exceptionApplies(fired, regressed, T0 + DAY)).toBeTruthy();
    expect(exceptionApplies(fired, regressed, T0 + 2 * DAY)).toBeFalsy();
    expect(exceptionApplies(fired, regressed, T0 + 3 * DAY)).toBeFalsy();
  }, 30_000);

  it("stops applying a revoked exception, and still honours a file without either field", async () => {
    const regressed = await evaluate("promotion", (arm, axis) =>
      arm === "candidate" && axis === "intent-use" ? 5 / 6 : 1
    );
    const revoked = exception(regressed, {
      revokedAt: new Date(T0 + 2 * DAY).toISOString(),
    });
    expect(exceptionApplies(revoked, regressed, T0 + DAY)).toBeTruthy();
    expect(exceptionApplies(revoked, regressed, T0 + 2 * DAY)).toBeFalsy();
    // An exception file written before either field existed omits both, and
    // still binds: a missing ending is no ending.
    const { revokedAt, triggerFiredAt, ...older } = exception(regressed);
    expect([revokedAt, triggerFiredAt]).toStrictEqual([null, null]);
    expect(exceptionApplies(older, regressed, T0 + DAY)).toBeTruthy();
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
        lineage: lineage("current"),
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
        lineage: lineage("current"),
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
        lineage: lineage("current"),
        now: T0 + DAY,
      })
    ).toMatchObject({ promotable: false, reason: "evaluation INVALID" });
    const clean = await evaluate("promotion", () => 1);
    expect(
      promotionDecision({
        report: clean,
        baseline: null,
        exceptions: [],
        lineage: lineage("current"),
        now: T0 + DAY,
      })
    ).toMatchObject({ promotable: false, reason: "baseline missing" });
    expect(
      promotionDecision({
        report: clean,
        baseline: { ...standing, revisionId: "rev-other" },
        exceptions: [],
        lineage: lineage("current"),
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
        lineage: lineage("current"),
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
        lineage: lineage("current"),
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
    // A rebase bypasses only non-inferiority. #34's fixed budget, valid
    // evidence and absolute floors are not waivable by any action.
    const rebasing = (report: Report) => () =>
      nextBaseline({
        current: null,
        report,
        decision,
        action: "rebase",
        now: "t",
      });
    expect(rebasing({ ...regressed, absoluteOutcome: "FAIL" })).toThrow(
      "a rebase requires a promotable evaluation: absolute floor FAIL"
    );
    expect(rebasing({ ...regressed, repetitions: 1 })).toThrow(
      "a rebase requires a promotable evaluation: budget was 1 repetitions, the policy fixes 6"
    );
    expect(
      rebasing({
        ...regressed,
        outcome: "INVALID",
        validity: { status: "INVALID", trials: ["x"] },
      })
    ).toThrow("a rebase requires a promotable evaluation: evaluation INVALID");
    expect(rebasing({ ...regressed, scores: null })).toThrow(
      "a rebase requires a promotable evaluation: unscored"
    );
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
      lineage: lineage("unqualified"),
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
