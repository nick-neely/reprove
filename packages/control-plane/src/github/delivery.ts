/**
 * What one delivery is, and what processing it concluded - as types a consumer
 * may hold.
 *
 * These three live apart from the modules that use them for a boundary reason
 * rather than a tidiness one. [ADR
 * 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids `apps/control-plane` from depending on `drizzle-orm` or a Postgres
 * driver, and `tools/verify-packages.mjs` measures that by type-checking the
 * packed declarations in a consumer with `skipLibCheck: false`. A published type
 * that merely *lives in* a module importing Drizzle drags Drizzle's whole
 * declaration graph into that check, whether or not any signature names one.
 *
 * `ledger.ts` and `processing.ts` both name a Drizzle transaction, so neither
 * can be the home of a type `createControlPlane()` returns. Declaring them here
 * - over `IngressEnvelope` and the closed value sets, and nothing else - is what
 * makes the boundary hold by construction instead of by review.
 */
import type {
  IngressDisposition,
  IngressRetryClass,
} from "../db/schema-values.js";
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

/** A committed ledger row and the envelope it holds. */
export interface DeliveryToProcess {
  /** The ledger row's id, as `recordDelivery()` returned it. */
  readonly deliveryId: string;
  readonly envelope: IngressEnvelope;
}

/** What one processing attempt concluded, and whether the ledger took it. */
export interface ProcessedDelivery {
  /**
   * What this attempt concluded, or `null` where it concluded nothing because
   * the delivery was already terminal when the lock was taken.
   *
   * Nullable rather than folded into a disposition, because a disposition is a
   * statement about work that was done. Every value of it would misreport this:
   * the attempt read the ledger, found the question already answered, and left
   * without fetching, writing or settling anything.
   */
  readonly outcome: IngressOutcome | null;
  /**
   * `false` when the row was already terminal, or belongs to another Owner.
   * ADR 0013's stateful GUID rule is what makes that expected rather than
   * exceptional: the contended attempt that settles after the one that won the
   * lock must not reopen a delivery whose work is finished.
   */
  readonly settled: boolean;
  /** The Run this delivery produced, where it produced one. */
  readonly runId: string | null;
}
