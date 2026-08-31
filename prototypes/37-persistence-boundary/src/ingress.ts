// THROWAWAY. ADR 0013's Run-creation path, reduced to the parts that touch the
// database. Everything about HMAC verification, HTTP status codes and the async
// kick is out of scope here; what this file exists to exercise is the claim that
//
//   "Processed deliveries are serialized per pull request, and every Run-creation
//    decision uses canonical GitHub state fetched inside that serialized
//    critical section."
//
// survives being run concurrently.

import type { PoolClient } from 'pg';
import type { RuntimeDb } from './runtime.js';

/** What `GET /repos/{owner}/{repo}/pulls/{number}` is read for. Injected, so the
 *  interleaving that ADR 0013 rejects a timestamp solution for is reproducible. */
export type CanonicalPull = {
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  draft: boolean;
  headRepoId: number | null;
  baseRepoId: number;
  authorAssociation: string;
  authorId: number;
} | null; // null = the grant is definitively gone

/** ADR 0013: everything in the immutable spec that ingress does not derive from
 *  GitHub comes from one explicitly named injected profile. */
export type Phase0RunProfile = {
  harness: string;
  model: string;
  strategy: string;
  autonomy: string;
  placement: string;
  configDigest: string;
  claimableForMs: number;
};

export type Delivery = {
  ownerId: number;
  installationId: number;
  repositoryId: number;
  pullRequestNumber: number;
  deliveryGuid: string;
  event: 'pull_request';
  action: string;
  trigger: 'automatic' | 'manual';
};

export type Outcome =
  | { kind: 'done'; runId: string; headSha: string; supersededRunId: string | null }
  | { kind: 'discarded'; disposition: 'ineligible' | 'duplicate_head' | 'grant_gone'; cancelledRunId?: string }
  | { kind: 'received'; retryClass: 'contended' | 'transient' | 'operator_attention' };

const ACTS_ON = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review', 'closed', 'converted_to_draft']);
const CANCELS = new Set(['closed', 'converted_to_draft']);
const LIVE = ['queued', 'claimed', 'executing'];

/** Step one, and the only one that must happen before GitHub is acknowledged.
 *  A bounded, normalized envelope - never the raw body. */
export async function commitEnvelope(rt: RuntimeDb, d: Delivery): Promise<string> {
  return rt.withOwner(d.ownerId, async (tx) => {
    const r = await tx.query(
      `insert into ingress_delivery
         (owner_id, delivery_guid, event, action, installation_id, repository_id, pull_request_number, state)
       values ($1,$2,$3,$4,$5,$6,$7,'received')
       returning id`,
      [d.ownerId, d.deliveryGuid, d.event, d.action, d.installationId, d.repositoryId, d.pullRequestNumber],
    );
    return r.rows[0].id as string;
  });
}

function provenanceOf(pull: NonNullable<CanonicalPull>) {
  const matchedSameRepository = pull.headRepoId !== null && pull.headRepoId === pull.baseRepoId;
  const matchedAssociation = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pull.authorAssociation);
  return {
    provenance: matchedSameRepository && matchedAssociation ? 'internal' : 'external',
    basis: {
      ruleVersion: 1,
      baseRepositoryId: pull.baseRepoId,
      headRepositoryId: pull.headRepoId,
      authorAssociation: pull.authorAssociation,
      authorId: pull.authorId,
      matchedSameRepository,
      matchedAssociation,
    },
  };
}

/**
 * Step two, asynchronous. One `withOwner` transaction holding:
 *   try-lock -> canonical fetch -> inspect -> no-op / cancel / supersede / create
 *
 * The fetch is INSIDE the lock on purpose. Fetching at the top of the job and
 * then locking leaves ADR 0013's T0-T3 interleaving, where an older delivery's
 * stale read overwrites a newer Run and nothing in the data marks it as stale.
 */
export async function processDelivery(
  rt: RuntimeDb,
  d: Delivery,
  envelopeId: string,
  fetchCanonical: () => Promise<CanonicalPull>,
  profile: Phase0RunProfile,
): Promise<Outcome> {
  if (!ACTS_ON.has(d.action)) {
    await settle(rt, d, envelopeId, { kind: 'discarded', disposition: 'ineligible' });
    return { kind: 'discarded', disposition: 'ineligible' };
  }

  const outcome = await rt.withOwner(d.ownerId, async (tx): Promise<Outcome> => {
    // The *try* variant. A serverless invocation must never queue behind a lock
    // whose holder it cannot observe, and abandoning costs nothing because the
    // envelope is already durable.
    const lock = await tx.query(
      `select pg_try_advisory_xact_lock(1000001, hashtext($1)) as got`,
      [`${d.repositoryId}:${d.pullRequestNumber}`],
    );
    if (!lock.rows[0].got) return { kind: 'received', retryClass: 'contended' };

    // Bounds the transaction that now holds a pooled connection across a network
    // call. statement_timeout is the wrong tool: the hazard is an OPEN
    // transaction with no query running.
    await tx.query(`set local idle_in_transaction_session_timeout = '10s'`);

    const pull = await fetchCanonical();

    if (pull === null) {
      const cancelled = await cancelLive(tx, d, 'installation_revoked');
      return { kind: 'discarded', disposition: 'grant_gone', cancelledRunId: cancelled };
    }

    const ineligible = pull.state === 'closed' || pull.draft;
    if (CANCELS.has(d.action) || ineligible) {
      const cancelled = await cancelLive(tx, d, pull.state === 'closed' ? 'pull_request_closed' : 'converted_to_draft');
      return { kind: 'discarded', disposition: 'ineligible', cancelledRunId: cancelled };
    }

    // Any status, no carve-outs. A status allowlist would put retry policy inside
    // ingress, where it cannot see budgets or repeated failure, and would turn
    // webhook redelivery into a retry mechanism.
    if (d.trigger === 'automatic') {
      const existing = await tx.query(
        `select id from run where repository_id = $1 and pull_request_number = $2 and head_sha = $3 limit 1`,
        [d.repositoryId, d.pullRequestNumber, pull.headSha],
      );
      if (existing.rowCount) return { kind: 'discarded', disposition: 'duplicate_head' };
    }

    const superseded = await tx.query(
      `update run set status = 'superseded'
        where repository_id = $1 and pull_request_number = $2 and status = any($3::text[])
        returning id`,
      [d.repositoryId, d.pullRequestNumber, LIVE],
    );

    const { provenance, basis } = provenanceOf(pull);
    const created = await tx.query(
      `insert into run
         (owner_id, repository_id, pull_request_number, base_sha, head_sha,
          provenance, provenance_basis, trigger,
          harness, model, strategy, autonomy, placement, config_digest,
          status, claimable_until)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued', now() + ($15 || ' milliseconds')::interval)
       returning id`,
      [
        d.ownerId, d.repositoryId, d.pullRequestNumber, pull.baseSha, pull.headSha,
        provenance, basis, d.trigger,
        profile.harness, profile.model, profile.strategy, profile.autonomy, profile.placement, profile.configDigest,
        String(profile.claimableForMs),
      ],
    );

    return {
      kind: 'done',
      runId: created.rows[0].id,
      headSha: pull.headSha,
      supersededRunId: superseded.rows[0]?.id ?? null,
    };
  });

  await settle(rt, d, envelopeId, outcome);
  return outcome;
}

async function cancelLive(tx: PoolClient, d: Delivery, reason: string): Promise<string | undefined> {
  const r = await tx.query(
    `update run set status = 'cancelled', cancellation_reason = $4
      where repository_id = $1 and pull_request_number = $2 and status = any($3::text[])
      returning id`,
    [d.repositoryId, d.pullRequestNumber, LIVE, reason],
  );
  return r.rows[0]?.id;
}

async function settle(rt: RuntimeDb, d: Delivery, envelopeId: string, outcome: Outcome) {
  await rt.withOwner(d.ownerId, async (tx) => {
    if (outcome.kind === 'received') {
      await tx.query(
        `update ingress_delivery
            set state='received', retry_class=$2, attempt_count = attempt_count + 1,
                last_attempt_at = now(), next_attempt_at = now() + interval '2 seconds'
          where id = $1`,
        [envelopeId, outcome.retryClass],
      );
    } else if (outcome.kind === 'discarded') {
      await tx.query(
        `update ingress_delivery set state='discarded', disposition=$2, retry_class=null,
            attempt_count = attempt_count + 1, last_attempt_at = now(), next_attempt_at = null
          where id = $1`,
        [envelopeId, outcome.disposition],
      );
    } else {
      await tx.query(
        `update ingress_delivery set state='done', retry_class=null,
            attempt_count = attempt_count + 1, last_attempt_at = now(), next_attempt_at = null
          where id = $1`,
        [envelopeId],
      );
    }
  });
}

/**
 * ADR 0013 makes this a Phase 0 EXIT CONDITION, not deferred work: without it,
 * "the H3 delivery arrives, finds contention, leaves received" loses a review
 * permanently, and durable receipt only a human can recover is not durability.
 */
export async function redriveOnce(
  rt: RuntimeDb,
  ownerId: number,
  resolve: (d: Delivery) => Promise<CanonicalPull>,
  profile: Phase0RunProfile,
): Promise<Outcome[]> {
  const due = await rt.withOwner(ownerId, async (tx) => {
    const r = await tx.query(
      `select id, owner_id, installation_id, repository_id, pull_request_number, delivery_guid, event, action
         from ingress_delivery
        where state = 'received' and retry_class in ('contended','transient')
          and (next_attempt_at is null or next_attempt_at <= now())
        order by received_at`,
    );
    return r.rows;
  });

  const outcomes: Outcome[] = [];
  for (const row of due) {
    const d: Delivery = {
      ownerId: row.owner_id,
      installationId: row.installation_id,
      repositoryId: row.repository_id,
      pullRequestNumber: row.pull_request_number,
      deliveryGuid: row.delivery_guid,
      event: 'pull_request',
      action: row.action,
      trigger: 'automatic',
    };
    outcomes.push(await processDelivery(rt, d, row.id, () => resolve(d), profile));
  }
  return outcomes;
}
