/**
 * The Run's durable schedule - [ADR
 * 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)'s **lifecycle**,
 * which outlives any Worker.
 *
 * It schedules; it does not decide. Every fact about a Run's outcome is written
 * by the control plane, and this workflow reads what was written and acts on
 * exactly one deadline: the unclaimed window. [ADR
 * 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
 * shapes it as a **state-driven loop** that re-reads authoritative Run state on
 * every wake rather than trusting the timestamp it slept toward:
 *
 * ```text
 * wake
 *   -> read authoritative Run state
 *      invisible, or another lifecycle recorded  -> return, having written nothing
 *      terminal                                  -> return
 *      queued, deadline ahead                    -> sleep toward it, or until notified
 *      queued, deadline passed                   -> attempt `unscheduled`
 *      claimed | executing                       -> return (see below)
 * ```
 *
 * **Everything this workflow body reaches is inlined into the workflow bundle,
 * and that bundle runs in a VM with no `require`.** So the body calls the
 * runtime's own primitives and the steps below, and nothing else; the control
 * plane is reached only from inside a step, where a Node module graph is
 * permitted. A helper hoisted to module scope and called from the body would
 * drag its whole transitive graph into the bundle and break every workflow in
 * the application, with an error naming an innocent one, while the build
 * stayed green. The real-builder gate exists because that rule cannot be left
 * to memory.
 *
 * **The `claimed | executing` branch returns rather than watching.** ADR 0015
 * gives execution liveness to this same loop, with `executionExpiresAt` as its
 * second window; that column is written at claim, which is
 * [#54](https://github.com/nick-neely/reprove/issues/54)'s, and the liveness
 * branch is [#56](https://github.com/nick-neely/reprove/issues/56)'s. Until
 * then a Run that left the unclaimed window is reported as having done so, and
 * `claimableUntil` is not stretched to cover what it was never allowed to
 * govern.
 */
import { createHook, getWorkflowMetadata, sleep } from "workflow";

import { controlPlane } from "./composition.js";

/*
 * Two lint rules yield to the Workflow SDK here. `'use workflow'` and
 * `'use step'` are directives the SDK's compiler reads off **function
 * declarations**, and its own documentation writes every step that way, so
 * `func-style` does not apply to these. And the workflow body is ADR 0015's
 * state-driven loop: each wake awaits a step, then decides, then sleeps or
 * writes - awaiting inside the loop is the design, not an accident
 * `Promise.all` would fix.
 */
/* oxlint-disable func-style, no-await-in-loop */

/**
 * The hook token, scoped to the **lifecycle** and never to the Run alone.
 *
 * Hook tokens are globally unique, and `start()` takes no idempotency key, so
 * two lifecycles can exist for one Run. A token derived from the Run id would
 * then collide - and collide the wrong way round: the orphan starts first,
 * holds the token, and the lifecycle actually recorded on the Run is the one
 * that dies. Carrying the lifecycle's own id makes the two disjoint; the cost
 * is that a notifier must read the recorded lifecycle from the database before
 * it can resume anything, which is the right dependency direction anyway.
 *
 * @param runId The Run.
 * @param workflowRunId The lifecycle scheduling it.
 * @returns The token its hook is created and resumed under.
 */
export const lifecycleToken = (runId: string, workflowRunId: string): string =>
  `run:${runId}:lifecycle:${workflowRunId}`;

/**
 * What a notification carries. It is a wake-up and nothing more: the lifecycle
 * re-reads the Run rather than trusting the payload, so the database decides
 * and the notification follows, never the reverse (ADR 0014).
 */
export interface LifecycleSignal {
  /** Why the notifier thinks the lifecycle should look. */
  readonly reason: "superseded" | "cancelled";
}

/** What the lifecycle wakes to, as a step returns it. */
interface WokenTo {
  readonly status: string;
  readonly claimableUntil: string;
  readonly workflowRunId: string | null;
  /**
   * Decided in the step, because a workflow body may not read the clock: the
   * loop needs to know whether a deadline it did not sleep toward has already
   * passed, and the answer has to come from outside the replayed body.
   */
  readonly deadlinePassed: boolean;
}

/** How one lifecycle ended, which is its return value. */
export type LifecycleOutcome =
  /** This lifecycle closed the unclaimed window. */
  | { readonly kind: "unscheduled" }
  /** The Run was ended by the control plane: superseded, cancelled, or terminal. */
  | { readonly kind: "ended"; readonly status: string }
  /**
   * The Run left the unclaimed window. What bounds it now is execution
   * liveness, which this loop does not yet own.
   */
  | { readonly kind: "claimed"; readonly status: string }
  /** Another lifecycle is the recorded one, or none was recorded in time. */
  | { readonly kind: "orphaned"; readonly recordedLifecycle: string | null }
  /** No such Run is visible to this Owner. */
  | { readonly kind: "unknown_run" };

const UNCLAIMED = "queued";
const LEFT_UNCLAIMED = new Set(["claimed", "executing"]);

/** What `Promise.race` below resolves to, so the branch is on a name. */
type Woke = "notified" | "deadline";

/**
 * The authoritative state a lifecycle wakes to, or `null` where this Owner has
 * no such Run.
 */
async function readRun(
  ownerId: number,
  runId: string
): Promise<WokenTo | null> {
  "use step";
  const plane = await controlPlane();
  const schedule = await plane.lifecycle.schedule(ownerId, runId);
  if (schedule === null) {
    return null;
  }
  return {
    status: schedule.status,
    claimableUntil: schedule.claimableUntil.toISOString(),
    workflowRunId: schedule.workflowRunId,
    deadlinePassed: schedule.claimableUntil.getTime() <= Date.now(),
  };
}

/**
 * `queued` to `unscheduled`, conditional on the writer being the recorded
 * lifecycle. The predicate lives in the control plane; this is the call.
 */
async function closeUnclaimedWindow(
  ownerId: number,
  runId: string,
  workflowRunId: string
): Promise<boolean> {
  "use step";
  const plane = await controlPlane();
  return await plane.lifecycle.expireUnclaimed(ownerId, runId, workflowRunId);
}

/**
 * Schedules one Run.
 *
 * @param runId The Run.
 * @param ownerId The Owner the Run belongs to, which every step scopes to.
 * @returns How this lifecycle ended.
 */
export async function runLifecycle(
  runId: string,
  ownerId: number
): Promise<LifecycleOutcome> {
  "use workflow";
  const mine = getWorkflowMetadata().workflowRunId;

  // Before the first read, so a notification that arrives while the Run is
  // being read is held rather than lost. A hook resolves once, so after it has
  // fired the loop waits on the deadline alone; a second notification finds no
  // open hook and the deadline still bounds the Run, which is the point of
  // treating notification as a wake-up rather than a mechanism.
  const hook = createHook<LifecycleSignal>({
    token: lifecycleToken(runId, mine),
  });
  let notified: Promise<Woke> | null = (async (): Promise<Woke> => {
    await hook;
    return "notified";
  })();

  try {
    for (;;) {
      const woken = await readRun(ownerId, runId);
      if (woken === null) {
        return { kind: "unknown_run" };
      }
      if (woken.workflowRunId !== null && woken.workflowRunId !== mine) {
        return { kind: "orphaned", recordedLifecycle: woken.workflowRunId };
      }
      if (LEFT_UNCLAIMED.has(woken.status)) {
        return { kind: "claimed", status: woken.status };
      }
      if (woken.status !== UNCLAIMED) {
        return { kind: "ended", status: woken.status };
      }

      if (!woken.deadlinePassed) {
        const deadline = (async (): Promise<Woke> => {
          await sleep(new Date(woken.claimableUntil));
          return "deadline";
        })();
        const woke = await Promise.race(
          notified === null ? [deadline] : [notified, deadline]
        );
        if (woke === "notified") {
          notified = null;
        }
        // Either way the next thing to do is read the Run again: a
        // notification says only that something may have changed, and a
        // deadline the loop slept toward still has to be checked against the
        // recorded lifecycle before anything is written.
        continue;
      }

      if (woken.workflowRunId === null) {
        // The deadline has passed and nothing recorded a lifecycle for this
        // Run. That is the `start()` window left open by a crash between
        // starting and recording; the step that dispatched this lifecycle is
        // retried by the platform and records the lifecycle it starts then.
        // This one was never recorded and may write nothing.
        return { kind: "orphaned", recordedLifecycle: null };
      }
      if (await closeUnclaimedWindow(ownerId, runId, mine)) {
        return { kind: "unscheduled" };
      }
      // The conditional write matched nothing: the Run was claimed or ended
      // between the read and the write. The re-read says which.
    }
  } finally {
    hook.dispose();
  }
}
