/**
 * The three outcomes protocol v1 admits, and no fourth.
 *
 * ```text
 * Result    a normalized payload, complete or partial, schema-validated here
 * Refusal   a decision not to execute, made before execution began
 * Failure   execution began and produced no acceptable Result
 * ```
 *
 * The split between the last two is where the defect was found, not how bad it
 * was. `CONTEXT.md` reserves **Refusal** for a decision made before execution
 * begins and **Failure** for a Pass that began executing and could not produce
 * an acceptable Result, so a hard-boundary defect found before the Adapter is
 * invoked crosses the boundary as a Refusal, and a repair or teardown defect
 * found afterwards does not cross at all.
 *
 * **A Failure carries no protocol payload, deliberately.** Protocol v1 has a
 * `Refusal` schema and a `Result` schema and nothing else, and inventing a
 * third wire shape here would put a message on the boundary that no control
 * plane parses and no ADR settled. The caller - a Worker lifecycle - sees this
 * type and reports the Failure through the mechanism its placement already has:
 * `reportHostedFailure` for a hosted Worker, and the self-hosted Failure path
 * for the other. What must never happen is a Failure serialized as a Refusal,
 * because that would claim nothing executed when something did.
 */
import type { Refusal, Result } from "@reprove/protocol/v1";

/**
 * Why an execution that began produced no acceptable Result.
 *
 * Every member is post-execution by construction. `sandbox_teardown_incomplete`
 * is the one ADR 0015 names explicitly, recorded there as a specific reason
 * that must never be collapsed into `worker_lost`.
 */
export type FailureReason =
  | "pass_failed"
  | "result_invalid"
  | "evidence_unsupported"
  | "model_substituted"
  | "sandbox_teardown_incomplete";

/**
 * Where in the post-execution sequence the defect was found.
 *
 * `conformance` rather than acceptance: `CONTEXT.md` reserves Acceptance for
 * the control plane's decision to absorb a Result into its Run and says
 * outright that it happens only there, distinguishing it by name from the
 * validation a Worker performs on its own output.
 */
export type FailurePhase = "execution" | "conformance" | "teardown";

/**
 * A Failure, internal to Worker core.
 *
 * Structured rather than an `Error` because the lifecycle above has to report
 * the reason without parsing a message, and because a caught exception with a
 * stack is exactly the unbounded Worker-originated data ADR 0006 keeps off the
 * wire.
 */
export interface InternalFailure {
  readonly reason: FailureReason;
  readonly phase: FailurePhase;
  readonly detail: string;
}

export type WorkerOutcome =
  | { readonly kind: "result"; readonly result: Result }
  | { readonly kind: "refusal"; readonly refusal: Refusal }
  | { readonly kind: "failure"; readonly failure: InternalFailure };

/**
 * The whole set, as values.
 *
 * Exported so "and no fourth" is assertable rather than merely intended. The
 * `satisfies` closes one direction - a member listed here that the union does
 * not admit is a compile error - and `run.test.ts` closes the other against a
 * `Record` keyed by the union, because a union that grew a member is invisible
 * to a list that did not.
 */
export const WORKER_OUTCOME_KINDS = [
  "result",
  "refusal",
  "failure",
] as const satisfies readonly WorkerOutcome["kind"][];

export type WorkerOutcomeKind = (typeof WORKER_OUTCOME_KINDS)[number];
