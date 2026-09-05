/**
 * What a committed delivery is handed to, and the re-drive [ADR
 * 0013](../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * made a Phase 0 exit condition.
 *
 * ```text
 * webhook commits the envelope, answers 200
 *   -> startDelivery()                 start(ingressDelivery, [delivery])
 *        step processDelivery          the advisory lock, the canonical fetch,
 *                                      the Run; RetryableError on contended and
 *                                      transient IS the re-drive
 *        step dispatchLifecycle        start(runLifecycle); the Run row arbitrates
 *        step notifyEnded              wake the lifecycles of Runs this delivery ended
 * ```
 *
 * [ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md): "the
 * ingress step throws `RetryableError` on `contended` and `transient`, and
 * Workflow's own step retry is the re-drive." No Reprove-owned sweeper, backoff
 * table or second job system appears beside the orchestrator, which is what
 * makes ADR 0006's "ingress must not write a parallel queue" true by
 * construction rather than by discipline.
 *
 * Every step here calls `controlPlane()` first, for the reason `composition.ts`
 * gives: whether a step shares a module instance with the route that composed
 * the deployment is builder-dependent, so a step resolves its own.
 */
import type {
  DeliveryToProcess,
  EndedRun,
  IngressRetryClass,
  ProcessedDelivery,
} from "@reprove/control-plane";
import { FatalError, RetryableError } from "workflow";
import { start } from "workflow/api";

import { controlPlane } from "./composition.js";
import { runLifecycle } from "./lifecycle.js";
import type { Notified } from "./notify.js";
import { notifyLifecycle } from "./notify.js";

/*
 * `'use step'` is a directive the Workflow SDK's compiler reads off a
 * **function declaration**, and `maxRetries` is a property its documentation
 * sets on one, so `func-style` yields to the SDK in this module.
 */
/* oxlint-disable func-style */

/**
 * The re-drive schedule, as Phase 0 fixture values. ADR 0013 fixed the retry
 * metadata and sent the schedule here; nothing in Phase 0 measures either
 * number, so both are chosen to be observable during development rather than
 * to be right.
 *
 * `contended` is another processor holding the same pull request's lock, which
 * it releases within one transaction's `idle_in_transaction_session_timeout`
 * at most, so the wait is short. `transient` is GitHub answering with a `5xx`,
 * a `429` or a rate limit, which clears on its own but not in a second.
 */
export const RE_DRIVE = {
  contendedAfterMs: 2000,
  transientAfterMs: 30_000,
  /**
   * Retries **after** the first attempt, so a delivery is attempted at most one
   * more time than this before the workflow run fails and the ledger row is
   * left `received` for an operator, with its retry class saying why.
   */
  maxRetries: 5,
} as const;

/** How the lifecycle dispatch concluded. */
export interface DispatchedLifecycle {
  /** The lifecycle this Run now records, or `null` where another already did. */
  readonly workflowRunId: string | null;
  /**
   * A lifecycle this step started and then cancelled, because the Run already
   * recorded another by the time this one was written. That is ADR 0014's
   * orphan being made inert on the spot rather than at its deadline.
   */
  readonly cancelledLifecycle: string | null;
}

/** What one ingress workflow run concluded, for whoever reads its return. */
export interface IngressConclusion {
  readonly processed: ProcessedDelivery;
  readonly dispatched: DispatchedLifecycle | null;
  readonly notified: readonly Notified[];
}

const redrive = (retryClass: IngressRetryClass): never => {
  switch (retryClass) {
    case "contended": {
      throw new RetryableError("re-drive: the pull request was contended", {
        retryAfter: RE_DRIVE.contendedAfterMs,
      });
    }
    case "transient": {
      throw new RetryableError("re-drive: the canonical fetch was transient", {
        retryAfter: RE_DRIVE.transientAfterMs,
      });
    }
    default: {
      // `operator_attention`. Retrying reaches the same answer on every
      // attempt, and ADR 0013 is explicit that a retry loop nobody can see is
      // the failure classifying by cause exists to prevent.
      throw new FatalError(
        "the delivery needs an operator: the ledger row says why"
      );
    }
  }
};

/**
 * The critical section, and the re-drive. The control plane does the work and
 * settles the ledger; this step turns a nonterminal settlement into the retry
 * the platform owns.
 */
async function processDelivery(
  delivery: DeliveryToProcess
): Promise<ProcessedDelivery> {
  "use step";
  const plane = await controlPlane();
  const processed = await plane.processDelivery(delivery);
  if (processed.outcome?.state === "received") {
    redrive(processed.outcome.retryClass);
  }
  return processed;
}
processDelivery.maxRetries = RE_DRIVE.maxRetries;

/**
 * Starts the Run's lifecycle and records it, in that order, because `start()`
 * cannot be made idempotent: the window between the two cannot be closed, and
 * a crash inside it orphans a durable run that no conditional update can find.
 * The Run row arbitrates instead - first writer of the lifecycle id wins - and
 * the loser cancels its own run.
 */
async function dispatchLifecycle(
  ownerId: number,
  runId: string
): Promise<DispatchedLifecycle> {
  "use step";
  const plane = await controlPlane();
  const lifecycle = await start(runLifecycle, [runId, ownerId]);
  const recorded = await plane.lifecycle.record(
    ownerId,
    runId,
    lifecycle.runId
  );
  if (!recorded) {
    await lifecycle.cancel();
    return { workflowRunId: null, cancelledLifecycle: lifecycle.runId };
  }
  return { workflowRunId: lifecycle.runId, cancelledLifecycle: null };
}

/**
 * Wakes the lifecycle of every live Run this delivery ended, so each
 * terminates reportably now rather than at its deadline. The statuses are
 * already committed; nothing here decides anything.
 */
async function notifyEnded(
  ownerId: number,
  endedRuns: readonly EndedRun[]
): Promise<Notified[]> {
  "use step";
  return await Promise.all(
    endedRuns.map((ended) =>
      notifyLifecycle(ownerId, ended.runId, ended.status)
    )
  );
}

/**
 * Moves one committed delivery onto the durable spine.
 *
 * @param delivery The committed ledger row and its envelope.
 * @returns What the delivery concluded, once the durable run has.
 */
export async function ingressDelivery(
  delivery: DeliveryToProcess
): Promise<IngressConclusion> {
  "use workflow";
  const processed = await processDelivery(delivery);
  const dispatched =
    processed.runId === null
      ? null
      : await dispatchLifecycle(delivery.envelope.ownerId, processed.runId);
  const notified =
    processed.endedRuns.length === 0
      ? []
      : await notifyEnded(delivery.envelope.ownerId, processed.endedRuns);
  return { processed, dispatched, notified };
}

/**
 * Starts the durable run for one committed delivery. This is the `kick` the
 * control plane is composed with, and like every kick it is synchronous and
 * returns nothing: the acknowledgement must not wait on it, and a rejection
 * here leaves the ledger row `received` for a manual redelivery, which is the
 * only recovery a delivery that never reached the spine has.
 *
 * @param delivery The committed ledger row and its envelope.
 */
export const startDelivery = (delivery: DeliveryToProcess): void => {
  void (async () => {
    try {
      await start(ingressDelivery, [delivery]);
    } catch {
      // Deliberately swallowed. The envelope is durable, this package holds no
      // logger, and an unhandled rejection would take the process down for a
      // delivery that is already recoverable by hand.
    }
  })();
};
