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
   * A lifecycle this step started and then cancelled, because the Run named
   * another one by the time this one was written. That is ADR 0014's orphan
   * being made inert on the spot rather than at its deadline.
   *
   * The Run naming *this* one is not that: a lifecycle records itself once its
   * deadline and the record grace have both passed with the column empty
   * ([#85](https://github.com/nick-neely/reprove/issues/85)), and cancelling it
   * would kill the lifecycle the Run records.
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
 * What a dispatch does about the run it started, once its own `record` has
 * matched nothing.
 *
 * **The Run row arbitrates, so the loser is whoever the row does not name.**
 * A failed `record` used to be read as "somebody else won", which was true
 * while `dispatchLifecycle` was the only writer of that column. It is not: a
 * lifecycle whose deadline and record grace have both passed with the column
 * empty records itself, because nothing else could ever close its windows
 * ([#85](https://github.com/nick-neely/reprove/issues/85)). Cancelling on the
 * failed write alone would then cancel the lifecycle the Run records, leaving
 * the Run pointing at a cancelled durable run with both windows still open and
 * every platform retry repeating the cancellation - worse than the state the
 * self-record fixed.
 *
 * So the row is read and compared, and the three answers are the three this
 * takes. An id that is not this one is ADR 0014's orphan, made inert on the
 * spot rather than at its deadline; no id at all is a Run this Owner cannot
 * see, where a durable run nobody will ever record must not be left sleeping.
 *
 * **Exported for `ingress.test.ts` beside it, and for nothing else** - the
 * package's entry point does not re-export it. It is separated from the step
 * because the step's own path cannot be reached from a test: `record` runs one
 * round trip after `start()`, and the only other writer has by then been past
 * its deadline for the whole grace, so producing that interleaving would take
 * a test-only branch inside shipped orchestration.
 *
 * @param mine The lifecycle this dispatch started.
 * @param recorded The lifecycle the Run names now, read as
 *   `schedule?.workflowRunId ?? null`. After a failed `record`, `null` there is
 *   a Run this Owner cannot see and never a visible row whose column is still
 *   empty: `recordLifecycle` and `readSchedule` run under the one `run_tenant`
 *   policy - `FOR ALL`, with `USING` and `WITH CHECK` both on `owner_id` - and
 *   the record never touches `owner_id`, so every row the read can see is a row
 *   the write could have matched.
 * @returns What the dispatch concluded, and what it must cancel to be true.
 */
export const concludeDispatch = (
  mine: string,
  recorded: string | null
): DispatchedLifecycle =>
  recorded === mine
    ? { workflowRunId: mine, cancelledLifecycle: null }
    : { workflowRunId: null, cancelledLifecycle: mine };

/**
 * Starts the Run's lifecycle and records it, in that order, because `start()`
 * cannot be made idempotent: the window between the two cannot be closed, and
 * a crash inside it orphans a durable run that no conditional update can find.
 * The Run row arbitrates instead - first writer of the lifecycle id wins - and
 * the loser cancels its own run.
 *
 * Which the loser is takes a read rather than the failed write, for the reason
 * `concludeDispatch` gives. That read is on the exceptional path only, so the
 * ordinary dispatch is the same two round trips it always was, and it is
 * race-free however long it trails the write it follows: `workflow_run_id` has
 * exactly one writer statement and nothing ever clears it, so a `record` that
 * matched nothing is a permanent fact about who won rather than a snapshot that
 * could go stale between the two.
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
  if (recorded) {
    return { workflowRunId: lifecycle.runId, cancelledLifecycle: null };
  }
  const schedule = await plane.lifecycle.schedule(ownerId, runId);
  const dispatched = concludeDispatch(
    lifecycle.runId,
    schedule?.workflowRunId ?? null
  );
  if (dispatched.cancelledLifecycle !== null) {
    await lifecycle.cancel();
  }
  return dispatched;
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
 * A failure here is **reported and not rethrown**. Swallowing it silently was
 * the worse half of the same decision: a deployment whose World is misconfigured
 * would then acknowledge every delivery, commit every envelope, run nothing, and
 * say nothing anywhere, so the manual recovery this comment relies on is one
 * nobody knows to perform. Standard error is the only sink a server process has,
 * and it is the one `environment.ts` already reports a broken connection to.
 *
 * @param delivery The committed ledger row and its envelope.
 */
export const startDelivery = (delivery: DeliveryToProcess): void => {
  void (async () => {
    try {
      await start(ingressDelivery, [delivery]);
    } catch (error) {
      // Not rethrown: an unhandled rejection would take the process down for a
      // delivery whose envelope is durable and recoverable by hand.
      process.stderr.write(
        `reprove: delivery ${delivery.deliveryId} did not reach the durable spine: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  })();
};
