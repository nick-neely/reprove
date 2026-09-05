/**
 * The serialized critical section, which is the whole of [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s
 * answer to delivery ordering:
 *
 * ```text
 * begin withOwner transaction
 *   -> pg_try_advisory_xact_lock(repositoryId, pullRequestNumber)
 *   -> fetch canonical pull request state while holding the lock
 *   -> inspect existing Runs
 *   -> no-op / cancel / supersede / create
 * commit
 * ```
 *
 * **Fetching canonical state at the top of the asynchronous job is not
 * sufficient**, and the residual interleaving is the reason the network call
 * sits inside a transaction at all:
 *
 * ```text
 * T0  delivery A (H2) resolves canonical -> sees H2
 * T1  a push lands; the head becomes H3
 * T2  delivery B (H3) resolves canonical -> sees H3, creates Run(H3)
 * T3  delivery A commits -> supersedes H3 and creates Run(H2)
 * ```
 *
 * "One live Run" holds at every step and the wrong head wins, and SHAs carry no
 * ordering, so nothing in the data marks A as stale. Inside the lock, whichever
 * processor acquires it second re-reads current state and observes the newer
 * head. The rejected alternative was stamping each Run with a resolution
 * instant, which "trades a small race for a silent, asymmetric failure mode"
 * because it depends on clock agreement across serverless instances.
 *
 * Two hazards follow from holding a network call inside a transaction, and they
 * need different mechanisms. Contention takes the **try** variant, so a
 * serverless invocation never queues behind a lock whose holder it cannot
 * observe; a hung fetch is bounded by the client's own timeout, backstopped by
 * a transaction-local `idle_in_transaction_session_timeout` set higher.
 * `statement_timeout` is the wrong tool and ADR 0013 names it so it is not
 * reached for: it bounds a running query, and the hazard is an open transaction
 * with no query running. Both exits cost nothing, because the envelope is
 * already durable.
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type { RunCancellationReason } from "../db/schema-values.js";
import { LIVE_RUN_STATUSES } from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type { CanonicalPullRequest } from "./canonical.js";
import type { CanonicalOutcome, CanonicalRequest } from "./client.js";
import type { Phase0RunProfile } from "./profile.js";
import { configDigest } from "./profile.js";
import { provenanceOf } from "./provenance.js";
import type { DeliveryIntent } from "./trigger.js";

/**
 * The backstop ADR 0013 puts behind the client timeout, and it is set **higher**
 * on purpose: "with the client timeout set lower so application code normally
 * aborts cleanly before Postgres kills the session". Two GitHub requests at the
 * client's own budget still fit inside this.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

/** Which pull request, in which tenant, reached through which grant. */
export interface PullRequestLocator extends CanonicalRequest {
  readonly ownerId: number;
  readonly repositoryId: number;
}

/** What the critical section is composed over. */
export interface RunCreationConfig {
  readonly canonicalPullRequest: (
    request: CanonicalRequest
  ) => Promise<CanonicalOutcome>;
  readonly profile: Phase0RunProfile;
  readonly now: () => Date;
}

/**
 * What the critical section decided, in enough detail that the ledger outcome
 * and a test can both be written from it. Every shape names what happened to
 * existing Runs as well as to any new one, because "supersede the old Run and
 * insert its replacement happen in the same `withOwner` transaction" is the
 * claim, and a decision that reported only the insert could not state it.
 */
export type RunDecision =
  /** A Run exists at the canonical head, and it is this one. */
  | {
      readonly kind: "created";
      readonly runId: string;
      /** The live Run at an older head that this one replaced, if any. */
      readonly supersededRunId: string | null;
    }
  /** Canonical state is closed or draft. Any live Run was ended. */
  | {
      readonly kind: "ineligible";
      readonly reason: RunCancellationReason;
      readonly cancelledRunId: string | null;
    }
  /** A Run already exists at the canonical head, in some status. */
  | {
      readonly kind: "duplicate_head";
      readonly supersededRunId: string | null;
    }
  /** A cancelling delivery whose pull request is, canonically, still open. */
  | { readonly kind: "no_action" }
  /** Another processor holds this pull request. Nothing was read or written. */
  | { readonly kind: "contended" }
  | { readonly kind: "grant_gone"; readonly reason: string }
  | { readonly kind: "transient"; readonly reason: string }
  | { readonly kind: "operator_attention"; readonly reason: string };

/**
 * The advisory lock key.
 *
 * One `bigint` hashed from both parts rather than the two-`int4` overload,
 * because a GitHub repository id is already within sight of `int4`'s ceiling
 * and truncating it would silently serialize two unrelated pull requests
 * together - or, worse, fail to serialize two of the same one.
 *
 * Advisory locks are cluster-global and see no tenant policy, which is correct
 * here: a repository id is unique across the whole of GitHub, so the key names
 * one pull request whoever asks. A hash collision costs two unrelated
 * deliveries a `contended` retry and nothing else.
 */
const lockKey = (locator: PullRequestLocator) =>
  sql`hashtextextended(${`reprove:pull-request:${locator.repositoryId}:${locator.pullRequestNumber}`}, 0)`;

/**
 * Takes the per-pull-request lock, or reports that someone else holds it.
 *
 * @param tx The tenant transaction the lock is scoped to.
 * @param locator The pull request to serialize on.
 * @returns Whether this transaction now holds it.
 */
const acquire = async (
  tx: TenantTransaction,
  locator: PullRequestLocator
): Promise<boolean> => {
  await tx.execute(
    sql.raw(
      `set local idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`
    )
  );
  const held = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(${lockKey(locator)}) as locked`
  );
  return held.rows[0]?.locked === true;
};

/**
 * Records what the canonical fetch established about scope.
 *
 * ADR 0013: "**Repository scope state is an operational cache. Current GitHub
 * authorization is authoritative whenever scope would permit or terminate
 * execution.**" So this is written after the fetch has already decided, never
 * read before one, and no branch above consults it. Nothing here grants or
 * withholds authority; it exists so an operator can see what the last canonical
 * answer was without replaying a delivery.
 */
const cacheScope = async (
  tx: TenantTransaction,
  locator: PullRequestLocator,
  inScope: boolean
): Promise<void> => {
  await tx
    .update(schema.repository)
    .set({ inScope })
    .where(
      and(
        eq(schema.repository.id, locator.repositoryId),
        eq(schema.repository.ownerId, locator.ownerId)
      )
    );
};

/**
 * Ends the live Run, if there is one.
 *
 * @returns The Run that was ended, or `null` where there was none.
 */
const endLiveRun = async (
  tx: TenantTransaction,
  locator: PullRequestLocator,
  ending:
    | { readonly status: "superseded"; readonly notAt: string }
    | { readonly status: "cancelled"; readonly reason: RunCancellationReason }
): Promise<string | null> => {
  const ended = await tx
    .update(schema.run)
    .set(
      ending.status === "superseded"
        ? { status: "superseded" }
        : { status: "cancelled", cancellationReason: ending.reason }
    )
    .where(
      and(
        eq(schema.run.repositoryId, locator.repositoryId),
        eq(schema.run.pullRequestNumber, locator.pullRequestNumber),
        inArray(schema.run.status, [...LIVE_RUN_STATUSES]),
        // A live Run already at the canonical head is not superseded by a
        // delivery that observed the same head: it *is* the Run for that head,
        // and ending it would be this delivery replacing its own answer.
        ...(ending.status === "superseded"
          ? [ne(schema.run.headSha, ending.notAt)]
          : [])
      )
    )
    .returning({ id: schema.run.id });
  return ended[0]?.id ?? null;
};

/** Whether any Run at all exists for this pull request at this head. */
const runAtHead = async (
  tx: TenantTransaction,
  locator: PullRequestLocator,
  headSha: string
): Promise<boolean> => {
  const found = await tx
    .select({ id: schema.run.id })
    .from(schema.run)
    .where(
      and(
        eq(schema.run.repositoryId, locator.repositoryId),
        eq(schema.run.pullRequestNumber, locator.pullRequestNumber),
        eq(schema.run.headSha, headSha)
      )
    )
    .limit(1);
  return found.length > 0;
};

/**
 * Writes the Run, complete.
 *
 * ADR 0013: "no field is left null or filled in later", so every column of the
 * immutable spec is supplied here from canonical state, the injected profile
 * and the creation timestamp, and nothing is patched afterwards.
 */
const insertRun = async (
  tx: TenantTransaction,
  config: RunCreationConfig,
  locator: PullRequestLocator,
  pullRequest: CanonicalPullRequest
): Promise<string> => {
  const { basis, provenance } = provenanceOf(pullRequest);
  const { profile } = config;

  const [row] = await tx
    .insert(schema.run)
    .values({
      ownerId: locator.ownerId,
      repositoryId: locator.repositoryId,
      pullRequestNumber: locator.pullRequestNumber,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      provenance,
      provenanceBasis: basis,
      // ADR 0013 keeps this field "deliberately that narrow - no event names,
      // no delivery ids - so ADR 0007's boundary is preserved". Ingress creates
      // only automatic Runs; a retry at the same head is an explicit manual act.
      trigger: "automatic",
      harness: profile.harness,
      model: profile.model,
      strategy: profile.strategy,
      autonomy: profile.autonomy,
      placement: profile.placement,
      allowHostedFallback: profile.allowHostedFallback,
      resolvedConfig: profile.resolvedConfig,
      configDigest: configDigest(profile.resolvedConfig),
      status: "queued",
      claimableUntil: new Date(config.now().getTime() + profile.claimableForMs),
    })
    .returning({ id: schema.run.id });

  if (!row) {
    throw new Error(
      `no Run was created for ${locator.repositoryNameWithOwner}#${locator.pullRequestNumber}`
    );
  }
  return row.id;
};

/**
 * Decides what a still-eligible pull request needs, and does it.
 *
 * The order is load-bearing. A live Run at a head that is no longer the
 * canonical one is superseded **before** the duplicate-head check, because it
 * reviews a head this pull request no longer has; leaving it live so that a
 * terminal Run at the canonical head could short-circuit the decision would
 * strand it as the one live Run at a stale head.
 */
const decideEligible = async (
  tx: TenantTransaction,
  config: RunCreationConfig,
  locator: PullRequestLocator,
  pullRequest: CanonicalPullRequest
): Promise<RunDecision> => {
  const supersededRunId = await endLiveRun(tx, locator, {
    status: "superseded",
    notAt: pullRequest.headSha,
  });

  // ADR 0013's application-level rule, and it has no status allowlist: "an
  // automatic trigger whose canonical head already has *any* Run for that pull
  // request is a no-op. Any status, with no carve-outs." An allowlist would put
  // retry policy inside ingress, where it cannot see budgets, quotas or
  // repeated failure, and would quietly turn webhook redelivery into a retry
  // mechanism. Two consequences are documented rather than hidden: a `failed`
  // Run at a head is not automatically retried, and a pull request reviewed at
  // H3, then closed and reopened at the same H3, does not get a second Run.
  if (await runAtHead(tx, locator, pullRequest.headSha)) {
    return { kind: "duplicate_head", supersededRunId };
  }

  return {
    kind: "created",
    runId: await insertRun(tx, config, locator, pullRequest),
    supersededRunId,
  };
};

/**
 * Resolves canonical state and settles one pull request, inside the caller's
 * tenant transaction.
 *
 * The transaction is the caller's for the same reason the ledger's is: the lock
 * is transaction-scoped, so a function that opened one of its own would release
 * it before the caller recorded what it decided.
 *
 * @param tx A tenant transaction already scoped to the delivery's Owner.
 * @param config The canonical fetch, the injected profile and the clock.
 * @param locator Which pull request, reached through which grant.
 * @param intent What the delivery is asking for.
 * @returns What was decided, and what it did to existing Runs.
 */
export const settlePullRequest = async (
  tx: TenantTransaction,
  config: RunCreationConfig,
  locator: PullRequestLocator,
  intent: Exclude<DeliveryIntent, "inert">
): Promise<RunDecision> => {
  if (!(await acquire(tx, locator))) {
    // Nothing is read and nothing is written. The envelope is already durable,
    // so abandoning the attempt costs only the re-drive #38 owns.
    return { kind: "contended" };
  }

  const outcome = await config.canonicalPullRequest(locator);
  if (outcome.kind !== "canonical") {
    if (outcome.kind === "grant_gone") {
      await cacheScope(tx, locator, false);
    }
    return outcome;
  }
  await cacheScope(tx, locator, true);

  const { pullRequest } = outcome;
  if (!pullRequest.open || pullRequest.draft) {
    // Decided from canonical state rather than from the action, which is what
    // makes a stale `closed` for a pull request that has since reopened cancel
    // nothing, and what makes a `synchronize` for one that has since closed
    // cancel rather than create.
    const reason: RunCancellationReason = pullRequest.open
      ? "pull_request_drafted"
      : "pull_request_closed";
    return {
      kind: "ineligible",
      reason,
      cancelledRunId: await endLiveRun(tx, locator, {
        status: "cancelled",
        reason,
      }),
    };
  }

  if (intent === "cancel") {
    // A `closed` or `converted_to_draft` delivery whose pull request is, right
    // now, open and ready. ADR 0013 gives these actions no power to create.
    return { kind: "no_action" };
  }

  return await decideEligible(tx, config, locator, pullRequest);
};
