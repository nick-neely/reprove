/**
 * The Run's durable schedule - [ADR
 * 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)'s **lifecycle**,
 * which outlives any Worker.
 *
 * It schedules; it does not decide. Every fact about a Run's outcome is written
 * by the control plane, and this workflow reads what was written and acts on
 * the Run's **two** bounded windows. [ADR
 * 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
 * shapes it as a **state-driven loop** that re-reads authoritative Run state on
 * every wake rather than trusting the timestamp it slept toward:
 *
 * ```text
 * wake
 *   -> read authoritative Run state
 *      invisible, or another lifecycle recorded  -> return, having written nothing
 *      terminal                                  -> return
 *      queued              -> claim-window branch, on claimableUntil
 *      claimed | executing -> liveness branch, on the CURRENT executionExpiresAt
 *                             deadline ahead   -> sleep toward it, or until notified
 *                             deadline passed  -> attempt failed(worker_lost)
 * ```
 *
 * **The two branches are one shape.** Each window is a deadline the Run itself
 * carries, so below the branch the loop sleeps toward it or tries to close it,
 * and only the transition differs. The re-read is what makes a self-hosted
 * Lease renewal work later without a new mechanism: renewal advances a column,
 * and a wake that finds a later deadline sleeps again.
 *
 * **One durable run per Run.** A separate watchdog workflow was rejected: it
 * would add a third `start()` orphan window of exactly the kind that leaves a
 * Run at `claimed` with a live, unrecorded pass - the hole this loop's second
 * branch exists to close. The cost is one pending `sleep` per lost race, an
 * un-cancelled job that fires later as an early-return no-op.
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
 * **The terminal write is the correctness boundary; cancelling is
 * reclamation.** The liveness branch terminalizes first and would cancel the
 * still-running pass second, best-effort, and only if its transition won.
 * Phase 0 records no pass, so there is nothing to cancel and that is fine: a
 * pass that emerges afterwards cannot change a Run whose Acceptance has already
 * closed. The hosted placement
 * ([#57](https://github.com/nick-neely/reprove/issues/57)) is what puts a pass
 * id there to cancel.
 */
import type { ExecutionLossOutcome, LostFrom } from "@reprove/control-plane";
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

/**
 * The window this wake falls in, whichever of the two it is.
 *
 * The loop treats both the same way below the branch - sleep toward the
 * deadline, or try to close it - so the step resolves which one is active and
 * hands back **one** deadline rather than two the body would have to re-join.
 * That makes "two windows, one shape" structural instead of a pair of ternaries
 * that happen to agree.
 */
interface ActiveWindow {
  /** When it closes, as the body will sleep toward it. */
  readonly deadlineAt: string;
  /**
   * Whether it has already closed. Decided in the step, because a workflow body
   * may not read the clock: the loop needs to know about a deadline it did not
   * sleep toward, and a replayed body would carry the first attempt's answer.
   */
  readonly passed: boolean;
}

/** What the lifecycle wakes to, as a step returns it. */
interface WokenTo {
  readonly status: string;
  readonly workflowRunId: string | null;
  /**
   * The deadline that bounds this Run **now**: `claimableUntil` while it is
   * unclaimed, and the current `executionExpiresAt` once it is claimed.
   *
   * Re-resolved on every wake rather than remembered, which is what will make a
   * self-hosted Lease renewal a column write rather than a second mechanism: a
   * wake that finds a later deadline simply sleeps toward it.
   *
   * `null` only for a claimed or executing Run carrying no `executionExpiresAt`
   * - a shape a claim cannot produce, since it writes all six ownership columns
   * in one statement. A terminal Run has no window either, and the body returns
   * on its status before it looks here.
   */
  readonly window: ActiveWindow | null;
}

/** How one lifecycle ended, which is its return value. */
export type LifecycleOutcome =
  /** This lifecycle closed the unclaimed window. */
  | { readonly kind: "unscheduled" }
  /** This lifecycle closed the executing window: nobody came back for the Run. */
  | {
      readonly kind: "worker_lost";
      /**
       * Which side of Acceptance's window it was abandoned on, as the control
       * plane's own vocabulary rather than as a bare string. The type comes
       * from `@reprove/control-plane`'s published surface, which is a closed
       * set of strings and names no Drizzle type - so this package still
       * depends on none.
       */
      readonly lostFrom: LostFrom;
    }
  /** The Run was ended by the control plane: superseded, cancelled, or terminal. */
  | { readonly kind: "ended"; readonly status: string }
  /**
   * The Run is claimed or executing and carries no execution deadline, so
   * there is no second window to watch.
   *
   * A claim writes all six execution-ownership columns in one statement, so
   * this is a state the schema cannot reach. It is reported rather than thrown
   * on because a lifecycle's job is to schedule, not to assert: a Run in a
   * shape nothing can produce is something to look at, not something to end.
   */
  | { readonly kind: "claimed"; readonly status: string }
  /** Another lifecycle is the recorded one, or none was recorded in time. */
  | { readonly kind: "orphaned"; readonly recordedLifecycle: string | null }
  /** No such Run is visible to this Owner. */
  | { readonly kind: "unknown_run" };

const UNCLAIMED = "queued";
const LEFT_UNCLAIMED = new Set(["claimed", "executing"]);

/**
 * How long a lifecycle keeps looking for its own id on the Run once the
 * deadline has passed and nothing is recorded there.
 *
 * That state has two causes and they want opposite answers. Either the step
 * that started this lifecycle crashed before recording it, in which case this
 * run is an orphan and must end; or the record is simply still in flight,
 * because `dispatchLifecycle` starts before it records and this run's first
 * wake beat that write. Ending immediately is right for the first and wrong
 * for the second: the record then commits against a lifecycle that has already
 * returned, and nothing is left to close the unclaimed window, so the Run
 * stays `queued` past its deadline forever.
 *
 * The two are indistinguishable from inside the loop, so it waits. The wait is
 * bounded rather than open, because a genuine orphan must not linger: a
 * crashed dispatch is retried by the platform and records the lifecycle it
 * starts then, which this one would only collide with. Ten seconds is many
 * times one database round trip and a small fraction of the five-minute Phase 0
 * deadline, which is the whole span it has to cover.
 */
const RECORD_GRACE_MS = 2000;
const RECORD_GRACE_WAKES = 5;

/**
 * How long the loop waits before re-reading after a conditional write matched
 * nothing.
 *
 * It is not a backoff for a race the loop expects to lose repeatedly: every
 * cause of a lost write moves the Run out of the window it was writing over, so
 * the next read returns. It is there so that **a future conjunct cannot turn
 * that argument into a tight loop** - a predicate that can fail while the Run
 * stays put would otherwise spin against the database, once per step, at
 * whatever the platform charges for one. Short enough that a genuine race costs
 * a fraction of a second, which is the only case that reaches it today.
 */
const LOST_RACE_MS = 500;

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
  // Which window bounds the Run now. `queued` is bounded by the claim window
  // and everything past it by execution liveness; a terminal Run is bounded by
  // neither, and the body returns on its status before it reads this.
  const deadline =
    schedule.status === UNCLAIMED
      ? schedule.claimableUntil
      : schedule.executionExpiresAt;
  return {
    status: schedule.status,
    window:
      deadline === null
        ? null
        : {
            deadlineAt: deadline.toISOString(),
            passed: deadline.getTime() <= Date.now(),
          },
    workflowRunId: schedule.workflowRunId,
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
 * `claimed | executing` to `failed(worker_lost)`, conditional on the deadline
 * having passed and on the writer being the recorded lifecycle. The predicate
 * lives in the control plane; this is the call.
 *
 * `now` is read **here** rather than passed from the body, for the reason
 * `readRun` decides `deadlinePassed` here: a workflow body may not read the
 * clock, and a replayed body would carry the first attempt's timestamp.
 */
async function closeExecutionWindow(
  ownerId: number,
  runId: string,
  workflowRunId: string
): Promise<ExecutionLossOutcome> {
  "use step";
  const plane = await controlPlane();
  return await plane.lifecycle.terminateLostExecution({
    detector: "hosted_watchdog",
    evidence: { kind: "deadline", now: new Date(), workflowRunId },
    // The watchdog's own evidence, and the honest one: it did not see the pass
    // die, it saw nothing usable arrive in time. The observations that name
    // what a pass did belong to the placement that runs one (#57).
    observation: "deadline_elapsed",
    ownerId,
    runId,
  });
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
  /** Wakes spent waiting for this lifecycle's own id to appear on the Run. */
  let unrecordedWakes = 0;
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
      const unclaimed = woken.status === UNCLAIMED;
      if (!(unclaimed || LEFT_UNCLAIMED.has(woken.status))) {
        return { kind: "ended", status: woken.status };
      }
      if (woken.window === null) {
        // Claimed or executing with no execution deadline, which a claim cannot
        // produce. There is no window to watch and nothing this loop may write.
        return { kind: "claimed", status: woken.status };
      }
      // From here down the loop is one shape for either window: sleep toward
      // the deadline, or try to close it. Only the transition differs.
      const { window } = woken;

      if (!window.passed) {
        const deadline = (async (): Promise<Woke> => {
          await sleep(new Date(window.deadlineAt));
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
        // authoritative Run before anything is written. That re-read is also
        // what will absorb a Lease renewal - a deadline that moved is simply
        // the next one to sleep toward.
        continue;
      }

      if (woken.workflowRunId === null) {
        // The deadline has passed and nothing records a lifecycle for this Run.
        // Wait out the record, then give up: see `RECORD_GRACE_MS`.
        if (unrecordedWakes >= RECORD_GRACE_WAKES) {
          return { kind: "orphaned", recordedLifecycle: null };
        }
        unrecordedWakes += 1;
        await sleep(RECORD_GRACE_MS);
        continue;
      }

      if (unclaimed) {
        if (await closeUnclaimedWindow(ownerId, runId, mine)) {
          return { kind: "unscheduled" };
        }
      } else {
        const lost = await closeExecutionWindow(ownerId, runId, mine);
        if (lost.terminalized) {
          // Terminalized first. Cancelling the still-running pass is
          // reclamation and belongs **after** this, best-effort, and only
          // because this transition won - cancelling first would make a
          // resource operation load-bearing for correctness. Phase 0 records
          // no pass to cancel, so there is nothing here yet and a pass that
          // emerges later cannot change a Run whose Acceptance has closed;
          // the hosted placement (#57) is what fills this in.
          return { kind: "worker_lost", lostFrom: lost.lostFrom };
        }
      }

      // The conditional write matched nothing: the Run moved between the read
      // and the write, and the re-read says which way. Every cause of that
      // moves the Run out of this window - it was claimed, or it accepted a
      // Result, or another writer ended it - so the next pass through the loop
      // returns rather than arriving back here.
      //
      // The wait is what makes that argument safe to be wrong about. A
      // conjunct added later that can fail while the Run stays in the window
      // would otherwise turn this into a tight loop against the database,
      // billed per step and invisible in any test that does not watch step
      // counts. One short sleep costs a re-read nothing and bounds the damage
      // to one attempt per interval.
      await sleep(LOST_RACE_MS);
    }
  } finally {
    hook.dispose();
  }
}
