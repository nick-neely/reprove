import { describe, expect, it } from "vitest";

import type { Expectation, Location } from "./corpus.mjs";
import {
  classifyTrial,
  locationMatches,
  matchFindings,
  RETRYABLE_FAULTS,
  scoreFindings,
  TrialFaultError,
} from "./evaluate.mjs";

const LOCATIONS: Location[] = [
  {
    id: "defect",
    kind: "defect",
    path: "src/a.js",
    startLine: 10,
    endLine: 12,
    anchor: "",
  },
  {
    id: "decoy",
    kind: "decoy",
    path: "src/a.js",
    startLine: 30,
    endLine: 30,
    anchor: "",
  },
];

const finding = (
  path: string,
  startLine: number,
  endLine = startLine,
  severity = "high"
) => ({
  severity,
  location: { path, startLine, endLine },
});

const expectation = (partial: Partial<Expectation>): Expectation => ({
  requiredFindings: [],
  forbiddenFindings: [],
  otherFindings: "allowed",
  allowedAmbiguity: [],
  ...partial,
});

describe("Finding identity", () => {
  it("matches by path and overlapping lines within the tolerance", () => {
    // SAFETY: LOCATIONS is a non-empty literal declared in this file, so
    // index 0 is always present.
    const known = LOCATIONS[0] as Location;
    expect(
      locationMatches({ path: "src/a.js", startLine: 11, endLine: 11 }, known)
    ).toBeTruthy();
    expect(
      locationMatches({ path: "src/a.js", startLine: 14, endLine: 14 }, known)
    ).toBeTruthy();
    expect(
      locationMatches({ path: "src/a.js", startLine: 15, endLine: 16 }, known)
    ).toBeFalsy();
    expect(
      locationMatches({ path: "src/b.js", startLine: 11, endLine: 11 }, known)
    ).toBeFalsy();
  });

  it("buckets findings by location and keeps the unmatched", () => {
    const match = matchFindings(
      [
        finding("src/a.js", 11),
        finding("src/a.js", 30),
        finding("README.md", 1),
      ],
      LOCATIONS
    );
    expect(match.byLocation).toStrictEqual({ defect: [0], decoy: [1] });
    expect(match.unmatched).toStrictEqual([2]);
  });
});

describe(scoreFindings, () => {
  it("passes when every required location is reported and no forbidden one is", () => {
    const judgement = scoreFindings(
      [finding("src/a.js", 10)],
      LOCATIONS,
      expectation({
        requiredFindings: ["defect"],
        forbiddenFindings: ["decoy"],
      })
    );
    expect(judgement).toMatchObject({
      status: "scored",
      passed: true,
      satisfiedBy: 0,
    });
  });

  it("misses a required Finding", () => {
    expect(
      scoreFindings(
        [],
        LOCATIONS,
        expectation({ requiredFindings: ["defect"] })
      )
    ).toMatchObject({
      status: "scored",
      passed: false,
      reason: "expectation_missed",
    });
  });

  it("fails on a forbidden Finding", () => {
    expect(
      scoreFindings(
        [finding("src/a.js", 10), finding("src/a.js", 30)],
        LOCATIONS,
        expectation({
          requiredFindings: ["defect"],
          forbiddenFindings: ["decoy"],
        })
      )
    ).toMatchObject({ passed: false });
  });

  it("forbids a Finding at no known location at every severity when asked", () => {
    // #34 declares machine-checkable expectations and a finite declared
    // ambiguity. `forbidden` means forbidden: no severity is exempt.
    const strict = expectation({ otherFindings: "forbidden" });
    for (const severity of ["high", "medium", "low", "info"]) {
      expect(
        scoreFindings([finding("README.md", 1, 1, severity)], LOCATIONS, strict)
      ).toMatchObject({ passed: false });
    }
  });

  it("accepts a declared alternative and records which one held", () => {
    const judgement = scoreFindings(
      [finding("src/a.js", 30)],
      LOCATIONS,
      expectation({
        requiredFindings: ["defect"],
        allowedAmbiguity: [
          {
            requiredFindings: ["decoy"],
            forbiddenFindings: [],
            otherFindings: "allowed",
          },
        ],
      })
    );
    expect(judgement).toMatchObject({ passed: true, satisfiedBy: 1 });
  });
});

describe(classifyTrial, () => {
  const base = {
    locations: LOCATIONS,
    expectation: expectation({ requiredFindings: ["defect"] }),
  };

  it("scores a complete Result", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "result",
          result: {
            completeness: "complete",
            findings: [finding("src/a.js", 11)],
          },
        },
      })
    ).toMatchObject({ status: "scored", passed: true });
  });

  it("counts a partial Result as a behavioral miss", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "result",
          result: { completeness: "partial", findings: [] },
        },
      })
    ).toMatchObject({
      status: "scored",
      passed: false,
      reason: "partial_result",
    });
  });

  it("counts a Harness failure and a malformed Result as misses, never retries", () => {
    for (const reason of [
      "pass_failed",
      "result_invalid",
      "evidence_unsupported",
    ]) {
      expect(
        classifyTrial({
          ...base,
          thrown: null,
          outcome: { kind: "failure", failure: { reason, detail: "x" } },
        })
      ).toMatchObject({ status: "scored", passed: false });
    }
  });

  it("treats a substituted Model as a contract failure with no score", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "failure",
          failure: {
            reason: "model_substituted",
            detail: "pinned x, resolved y",
          },
        },
      })
    ).toMatchObject({ status: "contract_failed", reason: "model_substituted" });
  });

  it("treats a provisioning Refusal as a retryable invalid trial", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "refusal",
          refusal: { reason: "sandbox_refused", actual: "seccomp missing" },
        },
      })
    ).toMatchObject({
      status: "invalid",
      fault: "sandbox_provisioning_transient",
      retryable: true,
    });
  });

  it("treats an unprotected narrative as a boundary defect, not a transient fault", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "refusal",
          refusal: {
            reason: "narrative_not_protected",
            actual: "chmod failed",
          },
        },
      })
    ).toMatchObject({
      status: "invalid",
      fault: "precondition_refused",
      retryable: false,
    });
  });

  it("maps a connection-level failure to the retryable transport fault", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const wrapped = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
    });
    for (const thrown of [refused, wrapped, new Error("fetch failed")]) {
      expect(classifyTrial({ ...base, outcome: null, thrown })).toMatchObject({
        status: "invalid",
        fault: "provider_transport_unavailable",
        retryable: true,
      });
    }
  });

  it("treats any other Refusal as invalid and not retryable", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "refusal",
          refusal: { reason: "capability_unresolved", actual: null },
        },
      })
    ).toMatchObject({
      status: "invalid",
      fault: "precondition_refused",
      retryable: false,
    });
  });

  it("never retries once behavior was observed, even when teardown failed", () => {
    expect(
      classifyTrial({
        ...base,
        thrown: null,
        outcome: {
          kind: "failure",
          failure: { reason: "sandbox_teardown_incomplete", detail: "residue" },
        },
      })
    ).toMatchObject({ status: "invalid", retryable: false });
  });

  it("classifies executor faults by their closed code", () => {
    for (const fault of RETRYABLE_FAULTS) {
      expect(
        classifyTrial({
          ...base,
          outcome: null,
          thrown: new TrialFaultError(fault, "gone"),
        })
      ).toMatchObject({ status: "invalid", fault, retryable: true });
    }
    expect(
      classifyTrial({
        ...base,
        outcome: null,
        thrown: new TrialFaultError("something_else", "?"),
      })
    ).toMatchObject({ status: "invalid", retryable: false });
    expect(
      classifyTrial({ ...base, outcome: null, thrown: new Error("boom") })
    ).toMatchObject({
      status: "invalid",
      fault: "gate_fault",
      retryable: false,
    });
  });
});
