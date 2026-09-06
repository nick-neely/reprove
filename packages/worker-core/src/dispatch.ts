/**
 * Everything Worker core decides before a single byte of repository code runs.
 *
 * ADR 0004 gates dispatch on `Exposure` x `Isolation` x `Provenance`, ADR 0005
 * makes a resolved capability the only view safe to act on, ADR 0009 promotes
 * the instruction boundary from an advisory field to a hard gate, and ADR 0011
 * gives a Repository a maximum Exposure it will run under. They are one ordered
 * decision here rather than five scattered conditions,
 * because the guarantee is the conjunction: **nothing warns and runs.** A
 * missing hard requirement is a Refusal, never a narrowing and never a log
 * line, and a warning in a Worker log is silent to the person whose pull
 * request is being reviewed.
 *
 * Every function here is pure and can only refuse. That is the shape of "Worker
 * core alone authorizes execution": an Adapter's capability and a Sandbox's
 * Attestation are *inputs* to this decision, and neither is a decision.
 */
import type { Autonomy, Exposure, Provenance } from "@reprove/protocol/v1";

import type { ResolvedCapability } from "./adapter.js";

/**
 * `CONTEXT.md`'s Isolation ladder, whole.
 *
 * Wider than what `@reprove/sandbox-container` can produce, deliberately: the
 * matrix has `microvm` rows, and a table that omitted the rung nothing
 * implements yet would have to be rewritten rather than extended when one does.
 */
export type IsolationLevel = "microvm" | "container-rootless" | "container";

/**
 * How old a capability probe may be and still be acted on.
 *
 * Five minutes is a Phase 0 fixture and not a measured value. What is not a
 * fixture is that a bound exists at all: `@ai-sdk/harness` ships removals as
 * patches at roughly eleven releases a week, so a capability is a measurement
 * with a shelf life rather than a fact about a version string.
 */
export const PROBE_MAX_AGE_MS = 5 * 60 * 1000;

/** Why Worker core will not serve this Run. Closed, and each names a fact. */
export type RefusalReason =
  | "capability_unresolved"
  | "capability_probe_stale"
  | "instruction_boundary_unenforceable"
  | "autonomy_unsupported"
  | "exposure_above_maximum"
  | "isolation_insufficient"
  | "provenance_ineligible"
  | "narrative_title_missing"
  | "narrative_not_protected"
  | "sandbox_refused";

/**
 * A Refusal's substance, before it is addressed to a Run.
 *
 * A reason code and the relevant resolved facts, never a global verdict: a
 * Worker knows only "I cannot serve this Run, for reason X", and what that
 * means for the Run is the control plane's to decide from the candidate pool,
 * Repository policy and prior Refusals.
 */
export interface RefusalCause {
  readonly reason: RefusalReason;
  readonly required: string | null;
  readonly actual: string | null;
}

export interface DispatchInput {
  readonly autonomy: Autonomy;
  readonly provenance: Provenance;
  /** The one opt-in, read from the base ref so a pull request cannot grant it. */
  readonly allowExternalProvenance: boolean;
  /** Resolved from the credential at dispatch, never from registration. */
  readonly exposure: Exposure;
  /**
   * The Repository's `security.maxExposure`, already narrowed by whatever Owner
   * Ceiling applied. The Worker is the only place it can bind: ADR 0004 resolves
   * `Exposure` from the credential at dispatch, so the control plane that read
   * the key never saw the value it constrains.
   */
  readonly maximumExposure: Exposure;
  /** What the Sandbox provider's host capability actually established. */
  readonly isolation: IsolationLevel;
  readonly capability: ResolvedCapability;
  readonly now: number;
}

/**
 * The Exposure ladder in blast-radius order, so "no more than" is comparable.
 *
 * `none` yields no usable credential, `scoped` a model-only one revocable
 * without disturbing the user's own login, and `account` one that can act as
 * the user beyond this Run.
 */
const EXPOSURE_LADDER: readonly Exposure[] = ["none", "scoped", "account"];

/** Anything above a rootful container, which is the only weak rung. */
const isStrong = (isolation: IsolationLevel): boolean =>
  isolation !== "container";

/**
 * ADR 0004's dispatch table, as the set of Provenance values a cell permits.
 *
 * Stated as a function of the two axes rather than as a literal table so the
 * one opt-in is visible as the single branch it is. `internal` classifies risk
 * rather than conferring safety: it means an attacker would have to be a
 * collaborator, not that there is no attacker.
 *
 * @param exposure What a fully compromised Sandbox would yield.
 * @param isolation How strongly that Sandbox is separated from its host.
 * @param allowExternalProvenance The Repository's one opt-in, from the base ref.
 * @returns Every Provenance this cell permits, in ladder order.
 */
export const permittedProvenance = (
  exposure: Exposure,
  isolation: IsolationLevel,
  allowExternalProvenance: boolean
): readonly Provenance[] => {
  if (exposure === "account") {
    // A self-renewing account credential in a rootful container running
    // repository code is refused outright rather than offered behind a
    // checkbox. The remedy is rootless.
    return isStrong(isolation) ? ["internal"] : [];
  }
  if (exposure === "scoped") {
    return isStrong(isolation) && allowExternalProvenance
      ? ["internal", "external"]
      : ["internal"];
  }
  return isStrong(isolation) ? ["internal", "external"] : ["internal"];
};

/**
 * Which of the two axes to name, when a cell does not permit this Provenance.
 *
 * Isolation where a stronger rung would have permitted it, because that is the
 * fact an operator can act on. Provenance where no rung would, because saying
 * "get stronger isolation" about a combination isolation cannot rescue would
 * send someone to rebuild a host for nothing.
 */
const ineligible = (input: DispatchInput): RefusalCause => {
  const strongest = permittedProvenance(
    input.exposure,
    "microvm",
    input.allowExternalProvenance
  );
  if (strongest.includes(input.provenance)) {
    return {
      reason: "isolation_insufficient",
      required: "container-rootless",
      actual: input.isolation,
    };
  }
  return {
    reason: "provenance_ineligible",
    required: strongest.join(", ") || "no Provenance at this Exposure",
    actual: input.provenance,
  };
};

/**
 * Refuses a Run before execution is authorized, or returns `null`.
 *
 * Ordered, and the order is the point: the capability gates come first, because
 * a stale probe means every fact below it was measured against artifacts nobody
 * re-checked, and a Refusal that named the matrix instead would send an
 * operator to look at the wrong thing.
 *
 * @param input Every resolved fact the decision is made from.
 * @returns The cause that refused the Run, or `null` where none did.
 */
export const checkDispatch = (input: DispatchInput): RefusalCause | null => {
  const age = input.now - input.capability.probedAt;
  if (age > PROBE_MAX_AGE_MS) {
    return {
      reason: "capability_probe_stale",
      required: `probed within ${PROBE_MAX_AGE_MS}ms`,
      actual: `probed ${age}ms ago`,
    };
  }

  if (!input.capability.canEnforceRepoInstructionBoundary) {
    return {
      reason: "instruction_boundary_unenforceable",
      required: "an enforced repo-controlled instruction boundary",
      actual: "the resolved invocation cannot enforce one",
    };
  }

  if (!input.capability.supportedAutonomy.includes(input.autonomy)) {
    return {
      reason: "autonomy_unsupported",
      required: input.autonomy,
      actual: input.capability.supportedAutonomy.join(", ") || "no Autonomy",
    };
  }

  // Before the matrix, because a Repository that wrote `maxExposure: scoped`
  // has already answered this Run, and naming ADR 0004's table instead would
  // send an operator to rebuild a host over a credential their own
  // configuration had refused. A key that reads as configured and gates nothing
  // is the silent downgrade ADR 0004 puts in scope as a vulnerability.
  if (
    EXPOSURE_LADDER.indexOf(input.exposure) >
    EXPOSURE_LADDER.indexOf(input.maximumExposure)
  ) {
    return {
      reason: "exposure_above_maximum",
      required: `no more than ${input.maximumExposure}`,
      actual: input.exposure,
    };
  }

  const permitted = permittedProvenance(
    input.exposure,
    input.isolation,
    input.allowExternalProvenance
  );
  return permitted.includes(input.provenance) ? null : ineligible(input);
};
