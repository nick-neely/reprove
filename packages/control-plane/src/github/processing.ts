/**
 * What happens after the `200`, and the one transaction it happens in.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * ends the webhook handler at "return 200 -> kick asynchronous processing", and
 * this is what the kick reaches. It maps the critical section's decision onto
 * the ledger's own vocabulary, which is deliberately neither Refusal nor Failure
 * vocabulary - "nothing was refused and nothing executed":
 *
 * ```text
 * Run created                                  -> done
 * canonical state ineligible - closed, draft   -> discarded: ineligible
 * a Run already exists at the canonical head   -> discarded: duplicate_head
 * grant definitively gone                      -> discarded: grant_gone
 * not a delivery that acts                     -> discarded: inert
 * lock contention                              -> received, contended
 * network failure, 5xx, 429, rate limiting     -> received, transient
 * auth or App configuration                    -> received, operator_attention
 * ```
 *
 * **The settlement is in the same transaction as the decision**, which is the
 * one structural choice here. Settling afterwards would leave a window in which
 * a Run exists and the delivery that created it still reads `received`, and a
 * re-drive reaching that window would take the lock, observe its own Run at the
 * canonical head, and conclude `duplicate_head` for the delivery that is
 * actually `done`. One transaction makes the Run and the conclusion about it a
 * single fact.
 *
 * The rejected alternative for the whole module is a sweeper that discovers
 * `received` rows on a timer. ADR 0013 requires an automatic re-drive path for
 * `contended` and `transient` as a Phase 0 exit condition and hands the
 * *mechanism* to [#38](https://github.com/nick-neely/reprove/issues/38), which
 * chose the platform's own step retry. Building a second one here would be a
 * recovery system nobody asked for, competing with the durable one - so
 * `processDelivery` is exposed as a function instead, and the kick that calls it
 * is fire-and-forget precisely because it is not the thing that recovers.
 */
import type { RuntimeDb } from "../db/runtime.js";
import type {
  DeliveryToProcess,
  IngressOutcome,
  ProcessedDelivery,
} from "./delivery.js";
import type { IngressEnvelope } from "./envelope.js";
import { settleDelivery } from "./ledger.js";
import type { Phase0RunProfile } from "./profile.js";
import type { RunCreationConfig, RunDecision } from "./run-creation.js";
import { settlePullRequest } from "./run-creation.js";
import { intentOf } from "./trigger.js";

/** What the processor is composed over. */
export interface DeliveryProcessorConfig {
  readonly withOwner: RuntimeDb["withOwner"];
  readonly canonicalPullRequest: RunCreationConfig["canonicalPullRequest"];
  readonly profile: Phase0RunProfile;
  /** Defaults to the system clock. */
  readonly now?: () => Date;
}

/**
 * ADR 0013 fixes the retry metadata - `retryClass`, `attemptCount`,
 * `lastAttemptAt`, `nextAttemptAt` - and leaves the schedule to #38. A
 * nonterminal outcome therefore carries **no** `nextAttemptAt`: writing one here
 * would be this module quietly choosing the backoff policy that ADR 0013 sends
 * elsewhere, and a wrong deadline is harder to notice than an absent one.
 */
const NO_SCHEDULE = null;

/**
 * SQLSTATE classes a failed transaction can be retried out of.
 *
 * `23505` is a concurrent writer and the next attempt re-reads state; class
 * `08` is a connection that went away, `40` a serialization failure or a
 * deadlock, `53` an exhausted resource, `57` an operator cancelling a statement,
 * and `25P03` is ADR 0013's own `idle_in_transaction_session_timeout` backstop
 * firing. Every one of them describes the attempt rather than the delivery.
 *
 * Everything else is `operator_attention`, deliberately. A constraint the code
 * did not expect, or a column it wrote wrongly, reaches the same failure on
 * every attempt, and ADR 0013 is explicit that classifying by cause rather than
 * by convenience is what stops a retry loop nobody can see.
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["23505", "25P03"]);
const TRANSIENT_SQLSTATE_CLASSES: ReadonlySet<string> = new Set([
  "08",
  "40",
  "53",
  "57",
]);

/**
 * The SQLSTATE a rejection carries, dug out of Drizzle's wrapper. Drizzle
 * re-throws a `Failed query:` error and hangs the driver's own error off
 * `cause`, so the code is never on the error the caller catches.
 */
const sqlStateOf = (error: Error): string | undefined => {
  const raised = error.cause instanceof Error ? error.cause : error;
  // SAFETY: `code` is node-postgres's own field on a driver error. A rejection
  // from anywhere else simply has none, and is classified as needing a person.
  return (raised as { code?: string }).code;
};

const outcomeForFailure = (error: Error): IngressOutcome => {
  const state = sqlStateOf(error) ?? "";
  const transient =
    TRANSIENT_SQLSTATES.has(state) ||
    TRANSIENT_SQLSTATE_CLASSES.has(state.slice(0, 2));
  return {
    state: "received",
    retryClass: transient ? "transient" : "operator_attention",
    nextAttemptAt: NO_SCHEDULE,
  };
};

const outcomeFor = (decision: RunDecision): IngressOutcome | null => {
  switch (decision.kind) {
    case "created": {
      return { state: "done" };
    }
    case "already_concluded": {
      // Nothing to record. The row that concluded it already says what
      // happened, and `settleDelivery()` would decline this anyway - it is
      // returned so the caller can skip the settle rather than depend on it
      // declining.
      return null;
    }
    case "ineligible": {
      return { state: "discarded", disposition: "ineligible" };
    }
    case "duplicate_head": {
      return { state: "discarded", disposition: "duplicate_head" };
    }
    case "unchanged": {
      return { state: "discarded", disposition: "unchanged" };
    }
    case "grant_gone": {
      return { state: "discarded", disposition: "grant_gone" };
    }
    case "contended": {
      return {
        state: "received",
        retryClass: "contended",
        nextAttemptAt: NO_SCHEDULE,
      };
    }
    case "transient": {
      return {
        state: "received",
        retryClass: "transient",
        nextAttemptAt: NO_SCHEDULE,
      };
    }
    default: {
      return {
        state: "received",
        retryClass: "operator_attention",
        nextAttemptAt: NO_SCHEDULE,
      };
    }
  }
};

/**
 * The locator an acting delivery needs, or the disposition that stands in for
 * it. Both answers are reached from the envelope alone, which is what makes
 * them honest: no lock is taken and GitHub is not asked.
 *
 * An acting `pull_request` delivery that names no Installation is `grant_gone`
 * rather than an error: there is no authority to fetch canonical state with,
 * which is the same conclusion the fetch itself would reach and the one ADR
 * 0013 wants for a revoked grant. A delivery naming no repository or no pull
 * request number is `inert` under that word's own definition - concluded from
 * the delivery alone - because there is nothing to act on and no later attempt
 * can supply it.
 */
const locate = (envelope: IngressEnvelope) => {
  if (
    envelope.repositoryId === null ||
    envelope.repositoryNameWithOwner === null ||
    envelope.pullRequestNumber === null
  ) {
    return { kind: "inert" } as const;
  }
  if (envelope.installationId === null) {
    return { kind: "grant_gone" } as const;
  }
  return {
    kind: "locator",
    locator: {
      ownerId: envelope.ownerId,
      installationId: envelope.installationId,
      repositoryId: envelope.repositoryId,
      repositoryNameWithOwner: envelope.repositoryNameWithOwner,
      pullRequestNumber: envelope.pullRequestNumber,
    },
  } as const;
};

/**
 * Composes the processor over a runtime client, the canonical fetch and the
 * injected profile.
 *
 * @param config The tenant transaction factory, the fetch and the profile.
 * @returns A function from a committed delivery to what it concluded.
 */
export const createDeliveryProcessor = (
  config: DeliveryProcessorConfig
): ((delivery: DeliveryToProcess) => Promise<ProcessedDelivery>) => {
  const runCreation: RunCreationConfig = {
    canonicalPullRequest: config.canonicalPullRequest,
    profile: config.profile,
    now: config.now ?? (() => new Date()),
  };

  const settle = async (
    delivery: DeliveryToProcess,
    outcome: IngressOutcome,
    runId: string | null
  ): Promise<ProcessedDelivery> => ({
    outcome,
    runId,
    settled: await config.withOwner(delivery.envelope.ownerId, (tx) =>
      settleDelivery(tx, delivery.deliveryId, outcome)
    ),
  });

  return async (delivery: DeliveryToProcess): Promise<ProcessedDelivery> => {
    const { envelope } = delivery;
    const intent = intentOf(envelope.event, envelope.action);
    if (intent === "inert") {
      // No lock and no canonical fetch: an `edited` delivery, or one of the
      // three events GitHub sends every App unconditionally, is concluded the
      // moment its event and action are read.
      return await settle(
        delivery,
        { state: "discarded", disposition: "inert" },
        null
      );
    }

    const located = locate(envelope);
    if (located.kind !== "locator") {
      return await settle(
        delivery,
        { state: "discarded", disposition: located.kind },
        null
      );
    }

    try {
      const { outcome, runId, settled } = await config.withOwner(
        envelope.ownerId,
        async (tx) => {
          const decision = await settlePullRequest(tx, runCreation, {
            deliveryId: delivery.deliveryId,
            locator: located.locator,
            intent,
          });
          const made = outcomeFor(decision);
          return {
            outcome: made,
            runId: decision.kind === "created" ? decision.runId : null,
            // Same transaction as the decision, so the Run and the conclusion
            // about the delivery that created it commit together or not at all.
            settled:
              made !== null &&
              (await settleDelivery(tx, delivery.deliveryId, made)),
          };
        }
      );
      return { outcome, settled, runId };
    } catch (error) {
      // The transaction rolled back, so there is no Run and the ledger row is
      // exactly as it was - `received`, with no attempt counted and no class
      // saying why. Left there it is a delivery nothing will ever pick up,
      // because ADR 0013's re-drive reads the retry class; the whole point of
      // committing the envelope before acknowledging is that this case is
      // recoverable, and it is only recoverable if it is recorded.
      //
      // A fresh transaction, necessarily: the one that failed cannot write.
      return await settle(
        delivery,
        outcomeForFailure(
          error instanceof Error ? error : new Error(String(error))
        ),
        null
      );
    }
  };
};
