/**
 * Transaction one: verify the credential, and do nothing else.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)
 * makes this restriction part of the decision rather than an implementation
 * note:
 *
 * > A forged locator is safe by construction: it only changes which tenant's
 * > credential lookup returns nothing. **That safety argument holds only if the
 * > pre-authentication transaction does exactly one thing** - verify the
 * > credential - and nothing else runs until it succeeds.
 *
 * So the transaction this module opens issues one `select` and returns. The
 * claim runs in a second transaction, which opens only after this one answered
 * with a Worker; a request that fails here never reaches it.
 *
 * {@link PreAuthTransaction} is what makes that structural rather than careful.
 * It is a `TenantTransaction` narrowed to `select`, so the verification
 * predicate has no `update`, `insert`, `delete` or `execute` to reach for: a
 * later edit that tried to refresh liveness here would not type-check, and
 * `authenticate.test.ts` measures the same claim from outside with a double
 * that records every call.
 *
 * The predicate is ADR 0008's own, and it is one predicate rather than a branch
 * for rotation and a branch outside it: same Owner, hash matches, not revoked,
 * not expired. A rotation grace window is then an ordinary row lifetime - the
 * predecessor carries `expiresAt = graceEnd` and both rows satisfy the same
 * `select` until it passes.
 *
 * Nothing here distinguishes an unknown Owner, an unknown secret, a revoked
 * credential and an expired one. All four return `null`, and the endpoint turns
 * every one of them into the same `401`, so the response cannot be used to
 * enumerate which Owners exist or which credentials once did.
 */
import { and, eq, gt, isNull, or } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import * as schema from "../db/schema.js";
import { hashWorkerSecret, parseWorkerCredential } from "./credential.js";

/**
 * A tenant transaction narrowed to the one capability the pre-authentication
 * transaction is allowed to have.
 */
export type PreAuthTransaction = Pick<TenantTransaction, "select">;

/** The Worker a verified credential names, and the tenant it belongs to. */
export interface WorkerIdentity {
  readonly ownerId: number;
  readonly workerId: string;
}

/** What the authenticator is composed over. */
export interface WorkerAuthenticatorConfig {
  /** The one entry point to a tenant transaction. */
  readonly withOwner: <T>(
    ownerId: number,
    fn: (tx: TenantTransaction) => Promise<T>
  ) => Promise<T>;
  /** The clock the expiry half of the predicate is read against. */
  readonly now?: () => Date;
}

/**
 * The one statement transaction one is permitted to issue.
 *
 * @param tx A tenant transaction already scoped to the locator's Owner.
 * @param ownerId The locator's Owner, written into the predicate as well as
 *   into the tenant context. ADR 0008 rule 1 is application scoping **plus**
 *   RLS, "not either alone", and this is the scoping half; the policy is what
 *   makes a forgotten one return zero rows rather than another tenant's row.
 * @param secretHash The stored form of the presented secret.
 * @param now The instant expiry is measured against.
 * @returns The Worker the credential names, or `null` for every way it does not.
 */
export const verifyWorkerCredential = async (
  tx: PreAuthTransaction,
  ownerId: number,
  secretHash: string,
  now: Date
): Promise<{ workerId: string } | null> => {
  const [row] = await tx
    .select({ workerId: schema.workerCredential.workerId })
    .from(schema.workerCredential)
    .where(
      and(
        eq(schema.workerCredential.ownerId, ownerId),
        eq(schema.workerCredential.secretHash, secretHash),
        isNull(schema.workerCredential.revokedAt),
        or(
          isNull(schema.workerCredential.expiresAt),
          gt(schema.workerCredential.expiresAt, now)
        )
      )
    )
    .limit(1);
  return row ?? null;
};

/**
 * Builds the authenticator.
 *
 * @param config The tenant transaction factory and the clock.
 * @returns A function from an `Authorization` header to a Worker, or `null`.
 */
export const createWorkerAuthenticator = (
  config: WorkerAuthenticatorConfig
): ((
  authorization: string | null | undefined
) => Promise<WorkerIdentity | null>) => {
  const clock = config.now ?? (() => new Date());

  const authenticate = async (
    authorization: string | null | undefined
  ): Promise<WorkerIdentity | null> => {
    // Parsing is pure and happens before any transaction, which is what makes a
    // forged locator a refusal rather than a `TypeError` thrown from inside
    // `withOwner` on an Owner id it cannot bind.
    const presented = parseWorkerCredential(authorization);
    if (!presented) {
      return null;
    }

    const secretHash = hashWorkerSecret(presented.secret);
    const now = clock();
    const verified = await config.withOwner(presented.ownerId, (tx) =>
      verifyWorkerCredential(tx, presented.ownerId, secretHash, now)
    );
    return verified
      ? { ownerId: presented.ownerId, workerId: verified.workerId }
      : null;
  };

  return authenticate;
};
