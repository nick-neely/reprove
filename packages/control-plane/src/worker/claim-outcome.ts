/**
 * What a claim can answer, as types a consumer may hold.
 *
 * These live apart from `claim.ts` for the reason `run/schedule.ts` gives:
 * [ADR 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids `apps/control-plane` from depending on Drizzle, and
 * `tools/verify-packages.mjs` measures that by type-checking the packed
 * declarations. A type that merely lives in a module importing Drizzle drags
 * its declaration graph into that check, so everything the published surface
 * names is declared here over the protocol's own types and nothing else.
 *
 * The refusals are **named**, which is ADR 0014's rule applied one seam earlier:
 * "'rejected' alone cannot distinguish a superseded Run from a forged tenant,
 * and the distinction is what makes the boundary auditable." A Worker that is
 * told only "409" cannot tell an operator whether to look at a second daemon,
 * at the clock, or at nothing at all.
 */
import type { ClaimGrant } from "@reprove/protocol/v1";

/**
 * The HTTP statuses the claim endpoint answers with, one per outcome.
 *
 * `noRunAvailable` is `204` rather than a `404` or an empty `200`, because an
 * idle poll is the ordinary case: ADR 0006 makes idle polling the heartbeat, so
 * the answer a Worker sees most often should carry no body and mean nothing is
 * wrong.
 *
 * `unauthenticated` never distinguishes an unknown Owner from an unknown
 * secret, a revoked credential or an expired one. All four are one answer, so
 * the response cannot be used to enumerate which Owners exist or which
 * credentials once did.
 */
export const WORKER_CLAIM_STATUS = {
  /** A Run was claimed. The body is a claim grant. */
  granted: 200,
  /** Nothing is claimable for this Owner right now. No body. */
  noRunAvailable: 204,
  /** No usable credential. One answer for every way that can be true. */
  unauthenticated: 401,
  /** A Run was named and this Owner has no such Run. */
  unknownRun: 404,
  /** The Run exists and could not be claimed. The reason names why. */
  refused: 409,
  /** Over the cap, and refused before being parsed. */
  oversized: 413,
  /** Authentic, and not a claim request. */
  malformed: 422,
  /** A protocol version outside the served window (ADR 0006). */
  incompatible: 426,
  /** The claim could not be attempted. Nothing was decided. */
  unavailable: 503,
} as const;

/**
 * Why a claim was refused, once the Run itself has been reached.
 *
 * Each one is a different fact about the Run and a different thing for an
 * operator to do, which is why there is no single `refused`:
 *
 * ```text
 * unknown_run              this Owner has no such Run - and, deliberately, a
 *                          Run belonging to another Owner is indistinguishable,
 *                          because the probe runs inside withOwner (ADR 0016)
 * already_claimed          another execution owns it; a Run is never actively
 *                          held twice
 * claim_window_closed      claimableUntil has passed and nothing has moved the
 *                          Run off `queued` yet
 * not_claimable            the Run is terminal, or otherwise past claiming
 * placement_mismatch       the Run is claimable and belongs to the other
 *                          placement, which is dispatched by another mechanism;
 *                          taking it would be dispatching one Run twice
 * installation_unavailable the Run is claimable and its Repository records no
 *                          live grant, so no Workspace could be materialized
 * ```
 */
export type ClaimRefusal =
  | "unknown_run"
  | "already_claimed"
  | "claim_window_closed"
  | "not_claimable"
  | "placement_mismatch"
  | "installation_unavailable";

/** What one attempt to claim decided. */
export type ClaimOutcome =
  /** The Run is claimed, and this is the execution ownership it created. */
  | { readonly kind: "granted"; readonly grant: ClaimGrant }
  /** A poll that found nothing. Not a refusal: nothing was wrong. */
  | { readonly kind: "no_run_available" }
  | { readonly kind: "refused"; readonly reason: ClaimRefusal };

/** Which Worker is claiming, and what it advertised about itself. */
export interface ClaimingWorker {
  /** The durable Worker identity Enrollment established. */
  readonly workerId: string;
  /** ADR 0006's two versions, both recorded on the Run. */
  readonly protocolVersion: number;
  readonly workerBuildVersion: string;
}

/** One authenticated Worker's request to take execution ownership. */
export interface WorkerClaimRequest {
  readonly ownerId: number;
  readonly worker: ClaimingWorker;
  /**
   * The Run to claim, or absent to poll for the oldest claimable one. A poll
   * only ever reaches a `self_hosted` Run.
   */
  readonly runId?: string;
}

/**
 * What the endpoint calls once, after authentication and the compatibility
 * check have both passed. It is a port so that a test can prove the endpoint
 * never reaches it for an unauthenticated or incompatible request.
 */
export type WorkerClaimPort = (
  request: WorkerClaimRequest
) => Promise<ClaimOutcome>;

/**
 * A hosted claim, which is the same execution ownership with no Worker behind
 * it.
 *
 * ADR 0006: a hosted Worker "does not enroll, register, advertise capabilities,
 * hold a durable identity, poll, claim, hold a lease, or heartbeat", so there
 * is no `workerId` and no advertised version to record. ADR 0015 is what makes
 * the shape shared anyway: `executionToken` and `executionExpiresAt` are
 * written at claim for **both** placements, so the hosted placement (#57) is a
 * caller of the same conditional UPDATE rather than a second one beside it.
 *
 * It always names its Run: hosted dispatch already knows which Run it is
 * dispatching, and polling is the half of the protocol hosted never exercises.
 */
export interface HostedClaimRequest {
  readonly ownerId: number;
  readonly runId: string;
}
