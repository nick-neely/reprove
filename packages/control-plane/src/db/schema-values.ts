/**
 * The closed value sets the schema's `text` columns hold, as types.
 *
 * `src/db/schema.ts` documents each of these in a comment beside its column and
 * cannot express them: a Postgres `ENUM` is a type whose values are altered by
 * migration rather than by a diff, and ADR 0008 keeps the state machines in the
 * application. This module is what stops the comment being the only statement -
 * it names no Drizzle type, so it is reachable from anywhere in the package and
 * from its published surface alike.
 */

/** `owner.type`. */
export type OwnerType = "user" | "organization";

/**
 * `ingress_delivery.state`. ADR 0013: none of these is Refusal or Failure
 * vocabulary, because nothing was refused and nothing executed. They are
 * ingress machinery before execution.
 */
export const INGRESS_STATES = ["received", "done", "discarded"] as const;
export type IngressState = (typeof INGRESS_STATES)[number];

/**
 * `ingress_delivery.disposition`, on `discarded`. Each one is terminal, and
 * each is a conclusion about the delivery rather than about a Run:
 *
 * ```text
 * canonical state ineligible - closed, draft   -> ineligible
 * a Run already exists at the canonical head   -> duplicate_head
 * grant definitively gone                      -> grant_gone
 * the delivery is not one that acts            -> inert
 * ```
 *
 * `inert` is ADR 0013's own word for the last row of its trigger table -
 * "everything else | inert" - promoted to a disposition because the ledger has
 * to say something about a delivery it concluded on, and every alternative
 * misreports it. `done` claims a Run was created, `ineligible` claims canonical
 * state was read and refused the pull request, and leaving the row `received`
 * hands a re-drive work that will reach the same answer forever. An `edited`
 * delivery, or one of the three events GitHub delivers to every App
 * unconditionally, is concluded the moment its event and action are read: no
 * lock is taken and no canonical fetch is made.
 *
 * It needs no migration. `disposition` is a `text` column and ADR 0008 keeps
 * the state machines in the application rather than in a Postgres `ENUM`, which
 * is exactly the case this is.
 */
export const INGRESS_DISPOSITIONS = [
  "ineligible",
  "duplicate_head",
  "grant_gone",
  "inert",
] as const;
export type IngressDisposition = (typeof INGRESS_DISPOSITIONS)[number];

/**
 * `ingress_delivery.retry_class`, on a nonterminal `received`.
 *
 * ADR 0013 classifies retryability **by typed cause, never by HTTP status**,
 * because `403 Resource not accessible by integration`, a missing permission, a
 * revoked grant and a misconfigured App are all permanent and "all 401/403
 * retry with backoff" produces an invisible loop:
 *
 * ```text
 * network failure, 5xx, 429, secondary rate limiting  -> transient
 * auth or App configuration cannot establish access   -> operator_attention
 * advisory lock contention                            -> contended
 * ```
 *
 * `transient` and `contended` are the two ADR 0013 makes a Phase 0 exit
 * condition: every nonterminal `received` caused by either must have an
 * automatic re-drive path, which #38 chooses the mechanism for.
 */
export const INGRESS_RETRY_CLASSES = [
  "transient",
  "operator_attention",
  "contended",
] as const;
export type IngressRetryClass = (typeof INGRESS_RETRY_CLASSES)[number];
