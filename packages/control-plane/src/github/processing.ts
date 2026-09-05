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
import type { IngressEnvelope } from "./envelope.js";
import type { IngressOutcome } from "./ledger.js";
import { settleDelivery } from "./ledger.js";
import type { Phase0RunProfile } from "./profile.js";
import type { RunCreationConfig, RunDecision } from "./run-creation.js";
import { settlePullRequest } from "./run-creation.js";
import { intentOf } from "./trigger.js";

/** A committed ledger row and the envelope it holds. */
export interface DeliveryToProcess {
  /** The ledger row's id, as `recordDelivery()` returned it. */
  readonly deliveryId: string;
  readonly envelope: IngressEnvelope;
}

/** What one processing attempt concluded, and whether the ledger took it. */
export interface ProcessedDelivery {
  readonly outcome: IngressOutcome;
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

const outcomeFor = (decision: RunDecision): IngressOutcome => {
  switch (decision.kind) {
    case "created": {
      return { state: "done" };
    }
    case "ineligible": {
      return { state: "discarded", disposition: "ineligible" };
    }
    case "duplicate_head": {
      return { state: "discarded", disposition: "duplicate_head" };
    }
    case "no_action": {
      return { state: "discarded", disposition: "inert" };
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
 * The locator an acting delivery needs, or the outcome that stands in for it.
 *
 * An acting `pull_request` delivery that names no Installation is
 * `grant_gone` rather than an error: there is no authority to fetch canonical
 * state with, which is the same conclusion the fetch itself would reach and the
 * one ADR 0013 wants for a revoked grant. A delivery missing a repository or a
 * pull request number is `inert`, because there is nothing to act on and no
 * later attempt can supply it.
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

    const { decision, settled } = await config.withOwner(
      envelope.ownerId,
      async (tx) => {
        const made = await settlePullRequest(
          tx,
          runCreation,
          located.locator,
          intent
        );
        return {
          decision: made,
          // Same transaction as the decision, so the Run and the conclusion
          // about the delivery that created it commit together or not at all.
          settled: await settleDelivery(
            tx,
            delivery.deliveryId,
            outcomeFor(made)
          ),
        };
      }
    );

    return {
      outcome: outcomeFor(decision),
      settled,
      runId: decision.kind === "created" ? decision.runId : null,
    };
  };
};
