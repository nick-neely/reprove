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
import { eq, sql } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type {
  IngressDisposition,
  IngressRetryClass,
} from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type { IngressEnvelope } from "./envelope.js";

/**
 * How a processing attempt ended, as the ledger holds it.
 *
 * A union rather than three nullable columns a caller fills in, because the
 * combinations the columns permit are mostly nonsense: a `done` row carrying a
 * retry class, or a `discarded` row with a next attempt, is a delivery a
 * re-drive sweeper would pick up and redo. Here the state names its own
 * evidence and there is no fourth shape.
 */
export type IngressOutcome =
  /** A Run was created. Terminal. */
  | { readonly state: "done" }
  /** Terminal, and the disposition says which conclusion was reached. */
  | {
      readonly state: "discarded";
      readonly disposition: IngressDisposition;
    }
  /**
   * Nonterminal: the delivery stays `received` and the retry class says what
   * kind of recovery it needs. ADR 0013 makes an automatic re-drive path for
   * `transient` and `contended` a Phase 0 exit condition rather than deferred
   * work, and #38 chooses the mechanism.
   */
  | {
      readonly state: "received";
      readonly retryClass: IngressRetryClass;
      readonly nextAttemptAt: Date | null;
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
    const nameWithOwner =
      envelope.repositoryNameWithOwner ?? String(envelope.repositoryId);
    await tx
      .insert(schema.repository)
      .values({
        id: envelope.repositoryId,
        ownerId: envelope.ownerId,
        installationId: envelope.installationId,
        nameWithOwner,
      })
      .onConflictDoUpdate({
        target: schema.repository.id,
        // The current name, because a rename moves it and the ledger row keeps
        // the locator the delivery carried. `inScope` is untouched: it is an
        // operational cache the canonical fetch owns.
        set: { nameWithOwner, installationId: envelope.installationId },
      });
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
 * @param tx A tenant transaction already scoped to the delivery's Owner.
 * @param deliveryId The ledger row returned by {@link recordDelivery}.
 * @param outcome How the attempt ended.
 */
export const settleDelivery = async (
  tx: TenantTransaction,
  deliveryId: string,
  outcome: IngressOutcome
): Promise<void> => {
  await tx
    .update(schema.ingressDelivery)
    .set({
      ...columnsFor(outcome),
      attemptCount: sql`${schema.ingressDelivery.attemptCount} + 1`,
      lastAttemptAt: new Date(),
    })
    .where(eq(schema.ingressDelivery.id, deliveryId));
};
