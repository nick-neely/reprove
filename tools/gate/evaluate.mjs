/**
 * One trial's judgement, from what Worker core returned.
 *
 * #34 keeps four outcomes distinct and this module is where they are told
 * apart:
 *
 * ```text
 * INVALID            infrastructure prevented scored Reviewer behavior
 * contract failure   a deterministic invariant broke (the Model pin)
 * behavioral miss    behavior began and timed out, failed or missed
 * behavioral success scored normally
 * ```
 *
 * A miss and a success are both *scored*: they enter the denominator. An
 * invalid trial does not, and the closed fault codes below are the only ones
 * that may be retried, once, because a Model timeout, a Harness failure, a
 * malformed Result and a missing Finding are all things a Reviewer did, not
 * things that stopped it from being observed.
 */
import { SCORING_POLICY } from "./scoring.mjs";

/** The closed set #34 allows one retry for. */
export const RETRYABLE_FAULTS = [
  "ephemeral_runner_lost",
  "provider_transport_unavailable",
  "sandbox_provisioning_transient",
];

/**
 * The gate's way of saying the trial never observed Reviewer behavior.
 * Anything else it throws is an invalid trial with a non-retryable fault.
 */
export class TrialFaultError extends Error {
  /**
   * @param {string} fault The closed fault code the trial is invalid under.
   * @param {string} detail What the gate saw, for the record.
   */
  constructor(fault, detail) {
    super(detail);
    this.name = "TrialFaultError";
    this.fault = fault;
  }
}

/** @typedef {import("./corpus.mjs").Location} Location */
/** @typedef {import("./corpus.mjs").Outcome} Outcome */
/** @typedef {import("./corpus.mjs").Expectation} Expectation */

/**
 * As much of a Finding as scoring reads.
 *
 * @typedef {object} FindingLike
 * @property {string} severity How serious the Reviewer called it.
 * @property {{ path: string, startLine: number, endLine: number }} location Where it points.
 */

/**
 * Which Findings named which known locations.
 *
 * @typedef {object} Match
 * @property {Record<string, number[]>} byLocation Location id to finding indexes.
 * @property {number[]} unmatched Finding indexes at no known location.
 */

/**
 * What one trial amounted to, in the four outcomes #34 keeps distinct.
 *
 * @typedef {{ status: "scored", passed: true, satisfiedBy: number, match: Match }
 *   | { status: "scored", passed: false, reason: string, match: Match | null }
 *   | { status: "invalid", fault: string, retryable: boolean, detail: string }
 *   | { status: "contract_failed", reason: string, detail: string }} Judgement
 */

/**
 * Lines by which a reported range misses a known one; 0 when they overlap.
 *
 * @param {{ startLine: number, endLine: number }} reported The reported range.
 * @param {{ startLine: number, endLine: number }} known The known range.
 * @returns {number} The gap in lines, or 0 when the ranges overlap.
 */
const distance = (reported, known) =>
  Math.max(
    0,
    known.startLine - reported.endLine,
    reported.startLine - known.endLine
  );

/**
 * Whether a reported location names a known one, within the policy tolerance.
 *
 * @param {{ path: string, startLine: number, endLine: number }} reported Where a Finding points.
 * @param {Location} known The declared defect or decoy.
 * @returns {boolean} True when the Finding names that location.
 */
export const locationMatches = (reported, known) =>
  reported.path === known.path &&
  distance(reported, known) <= SCORING_POLICY.locationToleranceLines;

/**
 * Finding identity is defect id plus known location, never wording.
 *
 * A Finding names the locations it overlaps. Only when it overlaps none does
 * the tolerance apply, and then it names the nearest, so a precise Finding at
 * a defect never also "reports" a decoy declared two lines away.
 *
 * @param {readonly FindingLike[]} findings What the Reviewer reported.
 * @param {readonly Location[]} locations The family's declared locations.
 * @returns {Match} Which Findings landed on which locations.
 */
export const matchFindings = (findings, locations) => {
  /** @type {Record<string, number[]>} */
  const byLocation = Object.fromEntries(
    locations.map((location) => [location.id, []])
  );
  /** @type {number[]} */
  const unmatched = [];
  for (const [index, finding] of findings.entries()) {
    const near = locations
      .filter((location) => locationMatches(finding.location, location))
      .map((location) => ({
        location,
        distance: distance(finding.location, location),
      }));
    const nearest = Math.min(...near.map((entry) => entry.distance));
    const named = near.filter((entry) => entry.distance === nearest);
    if (named.length === 0) {
      unmatched.push(index);
    }
    for (const entry of named) {
      byLocation[entry.location.id]?.push(index);
    }
  }
  return { byLocation, unmatched };
};

/**
 * Whether one declared outcome is satisfied by what was matched.
 *
 * @param {Outcome} outcome The declared outcome to test.
 * @param {Match} match What the Findings matched.
 * @param {readonly FindingLike[]} findings What the Reviewer reported.
 * @returns {boolean} True when the outcome holds.
 */
export const outcomeSatisfied = (outcome, match, findings) => {
  for (const required of outcome.requiredFindings) {
    if ((match.byLocation[required] ?? []).length === 0) {
      return false;
    }
  }
  for (const forbidden of outcome.forbiddenFindings) {
    if ((match.byLocation[forbidden] ?? []).length > 0) {
      return false;
    }
  }
  if (outcome.otherFindings === "forbidden") {
    const spurious = match.unmatched.filter(
      (index) =>
        !SCORING_POLICY.ignoredOtherSeverities.includes(
          findings[index]?.severity ?? ""
        )
    );
    if (spurious.length > 0) {
      return false;
    }
  }
  return true;
};

/**
 * Score a complete Result against a condition's expectation.
 *
 * The primary outcome is tried first, then each declared alternative in
 * order; `satisfiedBy` records which one held, with 0 for the primary, so a
 * report can show how often a family passed only through its ambiguity.
 *
 * @param {readonly FindingLike[]} findings What the Reviewer reported.
 * @param {readonly Location[]} locations The family's declared locations.
 * @param {Expectation} expectation What a correct review must and must not say.
 * @returns {Judgement} A scored pass or miss.
 */
export const scoreFindings = (findings, locations, expectation) => {
  const match = matchFindings(findings, locations);
  const outcomes = [expectation, ...expectation.allowedAmbiguity];
  const satisfiedBy = outcomes.findIndex((outcome) =>
    outcomeSatisfied(outcome, match, findings)
  );
  if (satisfiedBy === -1) {
    return {
      status: "scored",
      passed: false,
      reason: "expectation_missed",
      match,
    };
  }
  return { status: "scored", passed: true, satisfiedBy, match };
};

/** Refusals that mean the Sandbox never came up, which is transient by #34's list. */
const PROVISIONING_REFUSALS = new Set(["sandbox_refused"]);

/**
 * Error codes and messages by which Node reports that the Provider could not
 * be reached at all: no request was made, so no Reviewer behavior was lost.
 */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Whether a thrown error is the transport failing before any Provider turn.
 * Node attaches `code` to system errors and wraps them as `cause` on a fetch
 * failure; both are read as plain properties.
 *
 * @param {Error & { code?: unknown, cause?: { code?: unknown } }} error What was thrown.
 * @returns {boolean} True for a connection-level failure.
 */
const isTransportFailure = (error) => {
  const code = error.cause?.code ?? error.code;
  return (
    TRANSPORT_CODES.has(String(code)) || /fetch failed/iu.test(error.message)
  );
};

/**
 * Classify what Worker core returned, or what the gate threw.
 *
 * @param {object} input What the trial produced.
 * @param {{ kind: "result", result: { completeness: string, findings: readonly FindingLike[] } }
 *   | { kind: "refusal", refusal: { reason: string, actual: string | null } }
 *   | { kind: "failure", failure: { reason: string, detail: string } }
 *   | null} input.outcome What Worker core returned, or null if nothing did.
 * @param {Error | null} input.thrown What the gate threw, if it threw.
 * @param {readonly Location[]} input.locations The family's declared locations.
 * @param {Expectation} input.expectation What a correct review must and must not say.
 * @returns {Judgement} The trial's judgement.
 */
export const classifyTrial = ({ outcome, thrown, locations, expectation }) => {
  if (thrown !== null) {
    if (thrown instanceof TrialFaultError) {
      return {
        status: "invalid",
        fault: thrown.fault,
        retryable: RETRYABLE_FAULTS.includes(thrown.fault),
        detail: thrown.message,
      };
    }
    if (isTransportFailure(thrown)) {
      return {
        status: "invalid",
        fault: "provider_transport_unavailable",
        retryable: true,
        detail: thrown.message,
      };
    }
    return {
      status: "invalid",
      fault: "gate_fault",
      retryable: false,
      detail: String(thrown),
    };
  }
  if (outcome === null) {
    return {
      status: "invalid",
      fault: "gate_fault",
      retryable: false,
      detail: "the gate returned nothing",
    };
  }
  if (outcome.kind === "refusal") {
    const transient = PROVISIONING_REFUSALS.has(outcome.refusal.reason);
    return {
      status: "invalid",
      fault: transient
        ? "sandbox_provisioning_transient"
        : "precondition_refused",
      retryable: transient,
      detail: `${outcome.refusal.reason}: ${outcome.refusal.actual ?? ""}`,
    };
  }
  if (outcome.kind === "failure") {
    const { reason, detail } = outcome.failure;
    if (reason === "model_substituted") {
      return { status: "contract_failed", reason, detail };
    }
    if (reason === "sandbox_teardown_incomplete") {
      // Behavior was observed and then its Sandbox could not be accounted
      // for. Not retryable: #34 forbids re-running once behavior was seen.
      return { status: "invalid", fault: reason, retryable: false, detail };
    }
    return {
      status: "scored",
      passed: false,
      reason: `${reason}: ${detail}`,
      match: null,
    };
  }
  if (outcome.result.completeness !== "complete") {
    return {
      status: "scored",
      passed: false,
      reason: "partial_result",
      match: null,
    };
  }
  return scoreFindings(outcome.result.findings, locations, expectation);
};
