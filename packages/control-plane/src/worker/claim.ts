/**
 * The claim, which is one conditional UPDATE and then a name for why it matched
 * nothing.
 *
 * ```text
 * update run
 *   set status = 'claimed', claimed_at, execution_token, execution_expires_at,
 *       worker_id, worker_protocol_version, worker_build_version
 * where <the Run, or the oldest claimable one>
 *   and status = 'queued'
 *   and claimable_until > now
 *   and placement = <the claimant's own>
 *   and the Repository records an Installation
 * ```
 *
 * The eligibility window and the write are **the same statement**, which is what
 * makes "a Run cannot be actively held twice" a property of Postgres rather than
 * of a check somebody remembered to run first. Two concurrent claims of one Run
 * serialize on the row lock: one matches and commits, the other re-evaluates its
 * `WHERE` against the committed row and matches zero.
 *
 * Zero rows is therefore ambiguous by construction, and the re-probe that
 * follows exists **only to name it**. Its order is load-bearing in the same way
 * ADR 0016 found Acceptance's to be - both orders return a refusal and only the
 * name differs, so getting it wrong is invisible to anything but a test that
 * reads the name:
 *
 * ```text
 * not visible                        -> unknown_run
 * claimed | executing                -> already_claimed
 * terminal                           -> not_claimable
 * queued, and the window has closed  -> claim_window_closed
 * queued, for the other placement    -> placement_mismatch
 * queued, in window, no Installation -> installation_unavailable
 * ```
 *
 * **A claim only ever reaches its own placement.** A self-hosted Worker naming a
 * hosted Run's id would otherwise take it: the poll filters `placement` and a
 * targeted claim did not, so the guard was only ever on the path that does not
 * name a Run. The two placements are dispatched by different mechanisms - one
 * polls, one is handed its Run by hosted dispatch (#57) - so a Run taken by the
 * wrong one is a Run dispatched twice. `placement_mismatch` is a named refusal
 * rather than `unknown_run` because the Run *is* this Owner's and the caller can
 * see it; hiding it would say something false about visibility.
 *
 * `unknown_run` covers a Run belonging to another Owner, deliberately. The probe
 * runs inside `withOwner`, so such a Run is not merely ineligible but
 * **invisible**, and ADR 0016 makes that indistinguishability the decision
 * rather than a limitation: the response stops confirming that a Run exists
 * under an Owner the caller cannot see.
 *
 * **The Installation requirement is in the predicate rather than after the
 * write.** A Run whose Repository records no live grant cannot have a Workspace
 * materialized for it, and claiming it first and discovering that second would
 * burn the Run's one claim on an execution that cannot start. In the predicate
 * it is simply not claimable, a poll skips past it, and the re-probe names it.
 *
 * This module deliberately checks **nothing** about Exposure, Isolation or
 * Provenance. ADR 0006 makes that a two-phase decision whose second phase is the
 * claiming Worker's own fresh probe, answered with a Refusal; a Refusal is not
 * reachable in Phase 0 (ADR 0013), and pre-empting the gate here would put the
 * authoritative view on the wrong side of the seam.
 */
import { randomBytes } from "node:crypto";

import { protocolVersion } from "@reprove/protocol/v1";
import { and, eq, gt, sql } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type { RunPlacement } from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type {
  ClaimingWorker,
  ClaimOutcome,
  ClaimRefusal,
} from "./claim-outcome.js";
import { runSpecOf } from "./run-spec.js";

/** The bytes of entropy behind one execution token. */
const TOKEN_BYTES = 32;

/**
 * What a Run id looks like, checked before it reaches a `uuid` column.
 *
 * The protocol schema deliberately does **not** enforce this: `runId` is an
 * opaque string on the wire, and pinning the wire to Postgres's column type
 * would make a storage decision part of a contract a four-month-old Worker
 * depends on. So the shape is checked here, where the column is.
 *
 * Without it a Worker naming `not-a-uuid` reaches Postgres, which raises
 * `22P02 invalid input syntax for type uuid` from inside the UPDATE - and the
 * endpoint reports that rolled-back transaction as `503`, telling a Worker the
 * control plane is unavailable when what actually happened is that it asked for
 * a Run that cannot exist. It is `unknown_run`, which is the same answer this
 * Owner gets for any other id it does not hold.
 */
const RUN_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** What the claim is composed over. No value here is read from anywhere. */
export interface ClaimConfig {
  /**
   * ADR 0015's execution-liveness window, from the injected run profile.
   * `executionExpiresAt = claimedAt + livenessForMs`, and not from Run
   * creation, `claimableUntil`, or whenever execution happens to begin.
   */
  readonly livenessForMs: number;
  /** The clock the whole claim reads once. */
  readonly now: () => Date;
  /** Mints one execution token. Injected so a test can pin it. */
  readonly mintToken?: () => string;
}

/** Who is claiming: a self-hosted Worker, or the hosted placement, which is no one. */
export type ClaimingParty = ClaimingWorker | null;

/** One attempt to take execution ownership, inside the caller's transaction. */
export interface RunClaim {
  /**
   * The claimant's Owner, written into every predicate as well as into the
   * tenant context. ADR 0008 rule 1 is application scoping **plus** RLS, "not
   * either alone".
   */
  readonly ownerId: number;
  /** The Run to claim, or absent to poll for the oldest claimable one. */
  readonly runId?: string;
  /**
   * The self-hosted Worker taking ownership, or `null` for the hosted
   * placement, which holds no durable identity and advertises nothing.
   */
  readonly worker: ClaimingParty;
}

/**
 * The default token: 32 bytes from a CSPRNG, which is the same entropy a Worker
 * credential carries and for the same reason - it is a bearer capability, and
 * the only defence a bearer capability has is being unguessable.
 */
const mintExecutionToken = (): string =>
  randomBytes(TOKEN_BYTES).toString("base64url");

/**
 * The Repositories of this Owner that record a live grant, as a set the claim
 * predicate can test against.
 *
 * A subquery rather than a join, because the statement is an UPDATE whose row
 * set must stay exactly the `run` rows: a join would let the planner multiply
 * them.
 */
const withInstallation = (ownerId: number) =>
  sql`(select "repository"."id" from "repository" where "repository"."owner_id" = ${ownerId} and "repository"."installation_id" is not null)`;

/**
 * The oldest Run this Owner has that a self-hosted Worker could take.
 *
 * `for update skip locked` is what makes a poll safe under concurrency: a
 * second Worker arriving while the first holds its chosen row steps past it to
 * the next one rather than blocking on it, so two polls yield two Runs and
 * never one Run twice. `order by created_at` is fairness - the Run that has
 * waited longest goes first - and `limit 1` is what keeps the lock to a single
 * row.
 *
 * Only `self_hosted`. The hosted placement never polls; ADR 0006 says it does
 * not exercise the scheduling half of the protocol at all, so a hosted Run
 * appearing in a poll would be a Run dispatched twice by two different
 * mechanisms.
 */
const oldestClaimable = (ownerId: number, now: Date) => sql`(
  select "claimable"."id"
  from "run" as "claimable"
  where "claimable"."owner_id" = ${ownerId}
    and "claimable"."status" = 'queued'
    and "claimable"."claimable_until" > ${now}
    and "claimable"."placement" = 'self_hosted'
    and "claimable"."repository_id" in ${withInstallation(ownerId)}
  order by "claimable"."created_at" asc
  limit 1
  for update skip locked
)`;

/**
 * Reads the Run again, only to say what happened to it.
 *
 * Nothing is written here and nothing is decided: the conditional UPDATE above
 * already decided, and this turns its zero rows into a word.
 */
const nameRefusal = async (
  tx: TenantTransaction,
  claim: {
    readonly ownerId: number;
    readonly runId: string;
    readonly placement: RunPlacement;
  },
  now: Date
): Promise<ClaimRefusal> => {
  const [row] = await tx
    .select({
      status: schema.run.status,
      claimableUntil: schema.run.claimableUntil,
      placement: schema.run.placement,
      installationId: schema.repository.installationId,
    })
    .from(schema.run)
    .leftJoin(
      schema.repository,
      and(
        eq(schema.repository.ownerId, schema.run.ownerId),
        eq(schema.repository.id, schema.run.repositoryId)
      )
    )
    .where(
      and(eq(schema.run.ownerId, claim.ownerId), eq(schema.run.id, claim.runId))
    )
    .limit(1);

  if (!row) {
    return "unknown_run";
  }
  if (row.status === "claimed" || row.status === "executing") {
    return "already_claimed";
  }
  if (row.status !== "queued") {
    return "not_claimable";
  }
  if (row.claimableUntil.getTime() <= now.getTime()) {
    return "claim_window_closed";
  }
  if (row.placement !== claim.placement) {
    return "placement_mismatch";
  }
  if (row.installationId === null) {
    return "installation_unavailable";
  }
  // Queued, inside its window, with a live grant, and the UPDATE still matched
  // nothing. Postgres serializes concurrent writers on the row lock, so this is
  // not the interleaving `already_claimed` covers; it is a Run whose state
  // moved under a snapshot this transaction cannot see, and reporting it as
  // claimable would be the one answer that is certainly wrong.
  return "not_claimable";
};

/**
 * Claims a Run, or names why it could not be claimed.
 *
 * The transaction is the caller's, and that is what makes the claim atomic with
 * the spec it returns: `runSpecOf` may throw, and a throw rolls the claim back
 * rather than leaving a Run owned by an execution that was never handed a spec.
 *
 * @param tx A tenant transaction already scoped to the claimant's Owner.
 * @param config The liveness window, the clock and the token mint.
 * @param claim Which Run, and who is claiming it.
 * @returns The grant, the absence of work, or a named refusal.
 * @throws {Error} When the claimed Run cannot be rendered as a valid `RunSpec`.
 */
export const claimRun = async (
  tx: TenantTransaction,
  config: ClaimConfig,
  claim: RunClaim
): Promise<ClaimOutcome> => {
  const now = config.now();
  const executionToken = (config.mintToken ?? mintExecutionToken)();
  const executionExpiresAt = new Date(now.getTime() + config.livenessForMs);
  const { ownerId, worker } = claim;
  const placement: RunPlacement = worker ? "self_hosted" : "hosted";

  if (worker) {
    // ADR 0006: "any authenticated Worker contact refreshes Worker liveness.
    // Idle polling is the heartbeat when a Worker is idle", and there is no
    // separate heartbeat message - so this is written for every authenticated
    // claim, including the one that finds nothing. Below the refusal it would
    // make a Worker with nothing to do look offline, which is exactly the
    // reading ADR 0006 built the three signals to prevent. It is in transaction
    // **two**, never in the pre-authentication one, which ADR 0008 restricts to
    // verifying the credential and nothing else.
    await tx
      .update(schema.worker)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(schema.worker.ownerId, ownerId),
          eq(schema.worker.id, worker.workerId)
        )
      );
  }

  if (claim.runId !== undefined && !RUN_ID.test(claim.runId)) {
    // Before any SQL, because a `uuid` column rejects the string rather than
    // failing to match it, and a rolled-back transaction reads as `503`.
    return { kind: "refused", reason: "unknown_run" };
  }

  const [claimed] = await tx
    .update(schema.run)
    .set({
      status: "claimed",
      claimedAt: now,
      executionToken,
      executionExpiresAt,
      // Null for the hosted placement, in all three. ADR 0015 makes the token
      // and the deadline placement-neutral and stops there: a hosted Worker
      // holds no durable identity and advertises no version, so recording one
      // would be inventing a fact.
      workerId: worker?.workerId ?? null,
      workerProtocolVersion: worker?.protocolVersion ?? null,
      workerBuildVersion: worker?.workerBuildVersion ?? null,
    })
    .where(
      and(
        eq(schema.run.ownerId, ownerId),
        claim.runId
          ? eq(schema.run.id, claim.runId)
          : eq(schema.run.id, oldestClaimable(ownerId, now)),
        eq(schema.run.status, "queued"),
        gt(schema.run.claimableUntil, now),
        eq(schema.run.placement, placement),
        sql`${schema.run.repositoryId} in ${withInstallation(ownerId)}`
      )
    )
    .returning({
      id: schema.run.id,
      ownerId: schema.run.ownerId,
      repositoryId: schema.run.repositoryId,
      pullRequestNumber: schema.run.pullRequestNumber,
      baseSha: schema.run.baseSha,
      headSha: schema.run.headSha,
      provenance: schema.run.provenance,
      provenanceBasis: schema.run.provenanceBasis,
      trigger: schema.run.trigger,
      placement: schema.run.placement,
      allowHostedFallback: schema.run.allowHostedFallback,
      harness: schema.run.harness,
      model: schema.run.model,
      strategy: schema.run.strategy,
      autonomy: schema.run.autonomy,
      resolvedConfig: schema.run.resolvedConfig,
      configDigest: schema.run.configDigest,
      claimableUntil: schema.run.claimableUntil,
      createdAt: schema.run.createdAt,
    });

  if (!claimed) {
    // A poll that found nothing is not a refusal. Nothing was wrong, and ADR
    // 0006 makes idle polling the heartbeat, so the commonest answer in the
    // protocol must not read as an error.
    return claim.runId
      ? {
          kind: "refused",
          reason: await nameRefusal(
            tx,
            { ownerId, placement, runId: claim.runId },
            now
          ),
        }
      : { kind: "no_run_available" };
  }

  return {
    kind: "granted",
    grant: {
      runSpec: await runSpecOf(tx, claimed),
      executionToken,
      executionExpiresAt: executionExpiresAt.toISOString(),
      protocolVersion,
    },
  };
};
