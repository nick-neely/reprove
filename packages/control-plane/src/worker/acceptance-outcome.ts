/**
 * What Acceptance can answer, as types a consumer may hold.
 *
 * These live apart from `acceptance.ts` for the reason `claim-outcome.ts`
 * gives:
 * [ADR 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids `apps/control-plane` from depending on Drizzle, and
 * `tools/verify-packages.mjs` measures that by type-checking the packed
 * declarations. A type that merely lives in a module importing Drizzle drags
 * its declaration graph into that check, so everything the published surface
 * names is declared here over the protocol's own types and nothing else.
 *
 * The rejections are **named**, which is ADR 0014's rule - "'rejected' alone
 * cannot distinguish a superseded Run from a forged tenant, and the distinction
 * is what makes the boundary auditable" - as
 * [ADR 0016](../../../../docs/adr/0016-phase-0-acceptance-scenario.md) amended
 * it. A Worker told only "409" cannot tell an operator whether its Run ended
 * while it was executing or whether it is holding a token that was rotated out
 * from under it, and those are different things to go and look at.
 */
import type { Result } from "@reprove/protocol/v1";

/**
 * The HTTP statuses the result endpoint answers with, one per outcome.
 *
 * `unauthenticated` never distinguishes an unknown Owner from an unknown
 * secret, a revoked credential or an expired one. All four are one answer, so
 * the response cannot be used to enumerate which Owners exist or which
 * credentials once did.
 *
 * `unavailable` is deliberately not a rejection. A transaction that rolled back
 * left the Run exactly as it was, so the Result was neither accepted nor
 * refused; answering `409` would tell a Worker its Run had ended, and a Worker
 * that believed it would discard a Result it could still resubmit.
 */
export const WORKER_RESULT_STATUS = {
  /** The Result was accepted and its Run is terminal. */
  accepted: 200,
  /** No usable credential. One answer for every way that can be true. */
  unauthenticated: 401,
  /** This Owner has no such Run - and another Owner's Run is the same answer. */
  unknownRun: 404,
  /** The Run exists and could not accept this Result. The reason names why. */
  rejected: 409,
  /** Over the cap, and refused before being parsed. ADR 0006 rejects rather than truncates. */
  oversized: 413,
  /** Authentic, and not a Result this control plane can read. */
  malformed: 422,
  /** A protocol version outside the served window (ADR 0006). */
  incompatible: 426,
  /** Acceptance could not be attempted. Nothing was decided. */
  unavailable: 503,
} as const;

/**
 * Why a Result was rejected, once the statement has run and matched nothing.
 *
 * These three are what the **database** names. `oversized`, `upgrade_required`
 * and `malformed` are answered by the endpoint before any transaction opens, so
 * they are statuses rather than members of this union - the same division
 * `ClaimRefusal` makes.
 *
 * ```text
 * unknown_run         this Owner has no such Run - and, deliberately, a Run
 *                     belonging to another Owner is indistinguishable, because
 *                     the re-probe runs inside withOwner (ADR 0016)
 * not_eligible        the Run is terminal, or has already accepted a Result
 * execution_mismatch  the Run is still active and the presented token is not
 *                     its current one
 * ```
 *
 * `wrong_tenant` is **not** here. ADR 0016 removed it from the set: the
 * re-probe runs inside `withOwner`, so another Owner's Run is invisible rather
 * than merely ineligible, and the only answer available from inside the
 * boundary is `unknown_run`. A cross-tenant submission and a nonsense Run id
 * are indistinguishable on purpose, which is also the safer disclosure - the
 * response stops confirming that a Run exists under an Owner the caller cannot
 * see.
 *
 * `execution_mismatch` is ADR 0015's rename of `stale_lease`, because the
 * rejected condition is a submitted token that is not the Run's current one
 * rather than an expired Lease, which a hosted Worker never holds.
 */
export type ResultRejection =
  | "unknown_run"
  | "not_eligible"
  | "execution_mismatch";

/** The two terminal statuses Acceptance can write (ADR 0007). */
export type AcceptedRunStatus = "completed" | "incomplete";

/** What one attempt to accept a Result decided. */
export type AcceptanceOutcome =
  /** Absorbed into the Run, which is now terminal. */
  | { readonly kind: "accepted"; readonly runStatus: AcceptedRunStatus }
  /**
   * The payload is not one this Run can accept, measured against its immutable
   * spec rather than against its schema. ADR 0007's "a `Patch` is rejected at
   * acceptance under any Autonomy but `fix`" is the only member in Phase 0.
   * It carries a reason rather than a name because it is a `422` beside the
   * schema failures, not a seventh entry in ADR 0016's rejection set.
   */
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: ResultRejection };

/**
 * One submission, as the acceptance transaction is told about it.
 *
 * There is no hosted variant, and that is a difference from the claim rather
 * than an omission. A claim has two shapes because a self-hosted Worker holds a
 * durable identity and advertises versions while the hosted placement holds
 * neither. A submission has one, because ADR 0015 makes `executionToken` the
 * placement-neutral name for "the execution authorized to submit against this
 * Run" and both placements are handed one by the same claim.
 */
export interface SubmittedResult {
  readonly ownerId: number;
  readonly runId: string;
  /**
   * The token the claim handed back, as the Worker presented it. It is hashed
   * and compared as a digest; the plaintext is never stored and never logged.
   */
  readonly executionToken: string;
  /** The Result, already parsed through `@reprove/protocol`'s own schema. */
  readonly result: Result;
}

/**
 * What the endpoint calls once, after authentication, the compatibility check
 * and schema validation have all passed. It is a port so that a test can prove
 * the endpoint never reaches it for a request that failed any of them.
 */
export type WorkerResultPort = (
  submission: SubmittedResult
) => Promise<AcceptanceOutcome>;
