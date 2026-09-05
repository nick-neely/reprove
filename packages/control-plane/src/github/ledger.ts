/**
 * The durable half of ingress: the envelope, its processing state, and the
 * identity rows that have to exist for either to be storable.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * makes the ordering the whole decision - "**Durability comes before the
 * acknowledgement**", because a `200` returned before anything is persisted is
 * the one genuinely unrecoverable outcome in the system - so everything here is
 * written to be the thing a handler awaits before it answers.
 *
 * Nothing in this module is exported from `src/index.ts`. Every signature names
 * a Drizzle transaction, and ADR 0010 forbids the only consumer from depending
 * on Drizzle; the app reaches this through `createControlPlane()` instead.
 */
import { and, eq, sql } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import * as schema from "../db/schema.js";
import type { IngressOutcome } from "./delivery.js";
import type { IngressEnvelope } from "./envelope.js";

/**
 * The Repository identity row, written as an Owner-scoped update and only then
 * an insert, rather than as one `on conflict (id) do update`.
 *
 * A repository id is unique across the whole of GitHub and a repository can be
 * **transferred between accounts** while keeping it, so the id a delivery
 * carries may already name a row belonging to another Owner. A single upsert
 * conflicting on the primary key would then try to update a row this tenant
 * cannot see, and the tenant policy raises `42501 new row violates row-level
 * security policy` from inside the statement - failing the transaction, so the
 * envelope is never committed and the handler answers non-2xx. GitHub does not
 * auto-redeliver, which makes that a delivery lost for good, every time, for as
 * long as the stale row stands.
 *
 * The update matches nothing across the boundary, and the insert behind it
 * conflicts into `do nothing` rather than into an update, so a foreign row is
 * left exactly as it was instead of being written or raised over. That is what
 * ADR 0013's "**may** upsert identity facts" allows: identity is an operational
 * cache, the ledger row is the durable record, and `ingress_delivery`
 * references `owner` alone - so nothing about the envelope's durability depends
 * on this row existing. Reconciling a transfer needs authority over both
 * Owners, which no tenant transaction has and the canonical fetch does.
 */
const upsertRepository = async (
  tx: TenantTransaction,
  envelope: IngressEnvelope,
  repositoryId: number
): Promise<void> => {
  const nameWithOwner =
    envelope.repositoryNameWithOwner ?? String(repositoryId);
  // The current name, because a rename moves it and the ledger row keeps the
  // locator the delivery carried. `inScope` is untouched: it is an operational
  // cache the canonical fetch owns. The Installation is written only where the
  // delivery named one, because a delivery that named none is not evidence that
  // there is none - and clearing the column would drop the grant this
  // repository is reached through.
  const identity =
    envelope.installationId === null
      ? { nameWithOwner }
      : { nameWithOwner, installationId: envelope.installationId };

  const updated = await tx
    .update(schema.repository)
    .set(identity)
    .where(
      and(
        eq(schema.repository.id, repositoryId),
        eq(schema.repository.ownerId, envelope.ownerId)
      )
    )
    .returning({ id: schema.repository.id });
  if (updated.length > 0) {
    return;
  }

  await tx
    .insert(schema.repository)
    .values({
      id: repositoryId,
      ownerId: envelope.ownerId,
      installationId: envelope.installationId,
      nameWithOwner,
    })
    .onConflictDoNothing({ target: schema.repository.id });
};

/**
 * The identity facts a verified payload is allowed to establish.
 *
 * ADR 0013 separates identity from scope: a verified payload "may upsert Owner
 * / Installation / Repository identity facts", while whether the repository is
 * *in scope* is established by the canonical fetch under installation authority
 * and by nothing here. So these rows are written and `in_scope` is left at
 * whatever it already held.
 *
 * It is also not optional. `ingress_delivery` references `owner`, every
 * reference between two Owner-scoped tables is composite, and a first-ever
 * delivery from an Owner Reprove has never seen would otherwise be a
 * foreign-key violation - which under ADR 0013 means a non-2xx for a delivery
 * that was perfectly good. No path may require that `installation.created`
 * arrived first, because GitHub never auto-redelivers and one dropped delivery
 * would then orphan an Owner permanently.
 */
const upsertIdentity = async (
  tx: TenantTransaction,
  envelope: IngressEnvelope
): Promise<void> => {
  await tx
    .insert(schema.owner)
    .values({
      id: envelope.ownerId,
      login: envelope.ownerLogin,
      type: envelope.ownerType,
    })
    .onConflictDoUpdate({
      target: schema.owner.id,
      set: { login: envelope.ownerLogin, type: envelope.ownerType },
    });

  if (envelope.installationId !== null) {
    // `revokedAt` is deliberately not cleared. A delivery proves the App was
    // installed when GitHub emitted it, which is not the same as proving the
    // grant is live now; ADR 0013 leaves that to the canonical fetch.
    await tx
      .insert(schema.installation)
      .values({ id: envelope.installationId, ownerId: envelope.ownerId })
      .onConflictDoNothing({ target: schema.installation.id });
  }

  if (envelope.repositoryId !== null) {
    await upsertRepository(tx, envelope, envelope.repositoryId);
  }
};

/**
 * Commits one envelope, with the identity rows it depends on, inside the
 * caller's tenant transaction.
 *
 * The transaction is the caller's on purpose: "committed before the
 * acknowledgement" is a property of the call the handler awaits, and a function
 * that opened a transaction of its own would let a caller acknowledge while the
 * commit was still in flight.
 *
 * @param tx A tenant transaction already scoped to the envelope's Owner.
 * @param envelope The bounded normalized envelope.
 * @returns The ledger row's id, which is what later processing resumes from.
 */
export const recordDelivery = async (
  tx: TenantTransaction,
  envelope: IngressEnvelope
): Promise<string> => {
  await upsertIdentity(tx, envelope);

  const [row] = await tx
    .insert(schema.ingressDelivery)
    .values({
      ownerId: envelope.ownerId,
      deliveryGuid: envelope.deliveryGuid,
      event: envelope.event,
      action: envelope.action,
      installationId: envelope.installationId,
      repositoryId: envelope.repositoryId,
      repositoryNameWithOwner: envelope.repositoryNameWithOwner,
      pullRequestNumber: envelope.pullRequestNumber,
      state: "received",
    })
    .returning({ id: schema.ingressDelivery.id });

  if (!row) {
    // Unreachable through the tenant policy, which is checked against the same
    // `owner_id` the insert wrote - but an insert that returned nothing must
    // never read as a commit, because the caller is about to acknowledge.
    throw new Error(
      `the ingress ledger accepted no row for delivery ${envelope.deliveryGuid}`
    );
  }
  return row.id;
};

/** The columns an outcome sets, so that no stale one survives a transition. */
const columnsFor = (outcome: IngressOutcome) => {
  if (outcome.state === "discarded") {
    return {
      state: outcome.state,
      disposition: outcome.disposition,
      retryClass: null,
      nextAttemptAt: null,
    };
  }
  if (outcome.state === "received") {
    return {
      state: outcome.state,
      disposition: null,
      retryClass: outcome.retryClass,
      nextAttemptAt: outcome.nextAttemptAt,
    };
  }
  return {
    state: outcome.state,
    disposition: null,
    retryClass: null,
    nextAttemptAt: null,
  };
};

/**
 * Records how one processing attempt ended, and counts it.
 *
 * The attempt bookkeeping is incremented in SQL rather than read and written
 * back, so two processors that reached the same delivery cannot both write the
 * count they each read.
 *
 * Only a `received` row is settled. `done` and `discarded` are terminal in ADR
 * 0013, and the state is what the stateful GUID rule reads - same GUID plus a
 * terminal state is a duplicate - so a late attempt that reopened one would put
 * a retry class and a next attempt back on a delivery whose work is finished,
 * and hand a re-drive something that must never be redone. That is reachable
 * without any second processor writing at the same instant: the contended
 * attempt that lost the advisory lock settles after the attempt that won it.
 * Repeating a still-`received` row is the one repeat that does land, because
 * that is exactly what a re-drive is.
 *
 * Settling nothing is silent, for both reasons it can happen. Across the tenant
 * boundary the update matches nothing, and raising there would tell the wrong
 * Owner the row exists; on a terminal row the settlement is simply stale, and
 * the caller has nothing left to do about a delivery that is already concluded.
 * The return value is what distinguishes either from a settlement that landed.
 *
 * @param tx A tenant transaction already scoped to the delivery's Owner.
 * @param deliveryId The ledger row returned by {@link recordDelivery}.
 * @param outcome How the attempt ended.
 * @returns Whether this attempt was recorded - `false` when the row is already
 *   terminal, or belongs to another Owner.
 */
export const settleDelivery = async (
  tx: TenantTransaction,
  deliveryId: string,
  outcome: IngressOutcome
): Promise<boolean> => {
  const settled = await tx
    .update(schema.ingressDelivery)
    .set({
      ...columnsFor(outcome),
      attemptCount: sql`${schema.ingressDelivery.attemptCount} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(
      and(
        eq(schema.ingressDelivery.id, deliveryId),
        eq(schema.ingressDelivery.state, "received")
      )
    )
    .returning({ id: schema.ingressDelivery.id });
  return settled.length > 0;
};
