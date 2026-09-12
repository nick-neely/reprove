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
 * **A lifecycle the Run names nobody for records itself.** Both transitions
 * carry the recorded lifecycle in their predicate, so a Run that reaches a
 * deadline with that column empty has no writer either window will accept, and
 * no deadline can end it - only the prompt detector's token or a supersession
 * can, and neither is guaranteed to arrive
 * ([#85](https://github.com/nick-neely/reprove/issues/85)).
 * After a bounded grace for a record still in flight, the loop writes its own
 * id through the control plane's first-writer-wins statement and re-reads. The
 * row still arbitrates - a lifecycle that loses that write reads somebody
 * else's id on the next wake and ends as the orphan it turned out to be - so
 * this adds no transition and no predicate.
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
 * reclamation.** The liveness branch terminalizes first and cancels the
 * still-running pass second, best-effort, and only if its transition won.
 * Where the Run records no pass there is nothing to cancel and that is fine: a
 * pass that emerges afterwards cannot change a Run whose Acceptance has already
 * closed.
 *
 * **The watchdog reads the pass before it writes, and only then.** Once the
 * deadline has passed and a pass id is recorded, its durable state is what
 * turns `deadline_elapsed` into the observation that names what the pass
 * actually did (ADR 0015's set). Before the deadline there is nothing to ask
 * about - a running pass inside its window is the ordinary case - and with no
 * pass id there is nothing to ask.
 */
import type {
  ExecutionLossOutcome,
  ExecutionLostObservation,
  LostFrom,
} from "@reprove/control-plane";
import { createHook, getWorkflowMetadata, sleep } from "workflow";
import { getRun } from "workflow/api";

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
  /**
   * The **pass** the Run records, or `null` where it records none.
   *
   * Two different states share that `null`, and the loop does not need to tell
   * them apart: no pass was ever started, or one was started and the process
   * died before `markExecuting` recorded it (ADR 0016). Either way there is no
   * id to read a disposition from and none to cancel.
   */
  readonly hostedWorkflowRunId: string | null;
}

/**
 * What the pass's own durable run says about itself, as a step can carry it
 * back into a workflow body.
 *
 * `null` is "its state could not be read", which is a different fact from any
 * status and is why this is not simply a string: a World that answered nothing
 * has told the watchdog nothing about the pass, and the observation set has a
 * member for exactly that.
 *
 * Unexported, like the step that produces it: it crosses no package boundary,
 * and `observationFor` below - the only other thing that names it - is not on
 * the entry point either.
 */
interface PassDisposition {
  readonly status: string | null;
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
      /** What the watchdog could say for itself about the pass, if anything. */
      readonly observation: ExecutionLostObservation;
      /**
       * The pass this lifecycle cancelled **after** its transition won, or
       * `null` where the Run recorded none. Reclamation, never correctness: the
       * database write is the boundary and this follows it.
       */
      readonly cancelledPass: string | null;
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
   *
   * It is returned **above** the self-record branch, so a Run in that shape
   * with no recorded lifecycle either is reported rather than recorded. That
   * ordering is deliberate: with no deadline there is no window to close, and
   * an id written to close nothing would buy the Run nothing.
   */
  | { readonly kind: "claimed"; readonly status: string }
  /**
   * Another lifecycle is the one the Run records, so this one wrote nothing.
   *
   * Always an id, never an absence: a lifecycle that finds the column empty
   * past its deadline records itself rather than reporting orphanhood, so the
   * only way to arrive here is to read somebody else's id
   * ([#85](https://github.com/nick-neely/reprove/issues/85)).
   */
  | { readonly kind: "orphaned"; readonly recordedLifecycle: string }
  /** No such Run is visible to this Owner. */
  | { readonly kind: "unknown_run" };

const UNCLAIMED = "queued";
const LEFT_UNCLAIMED = new Set(["claimed", "executing"]);

/**
 * How long a lifecycle leaves the Run's lifecycle column to a record that may
 * still be in flight, once the deadline has passed with nothing written there.
 *
 * That state has two causes and the loop cannot tell them apart from inside:
 * either the step that started this lifecycle crashed before recording it, or
 * the record is simply still on its way, because `dispatchLifecycle` starts
 * before it records and this run's wake beat that write. The grace separates
 * them without asking - a write that is coming lands inside it, and one that
 * never comes has been given every chance to.
 *
 * **Then the lifecycle records itself, whichever it was**, because nothing
 * else can. Both transitions carry `workflow_run_id = <the writer>`, so a Run
 * past a deadline that names no lifecycle has no writer either window will
 * accept: it stays `queued` past `claimableUntil`, or `claimed` and
 * Result-eligible, until something that is not a deadline ends it - the prompt
 * detector's token, or a supersession - and neither is guaranteed to arrive
 * ([#85](https://github.com/nick-neely/reprove/issues/85)). Returning without
 * writing left exactly that, because the predicate a return was supposed to
 * spare would have matched nothing anyway.
 *
 * Waiting first is what keeps the ordinary case ordinary: a dispatcher whose
 * `record` loses to the lifecycle it just started has to read the Run back to
 * learn that it lost nothing. Ten seconds is many times one database round
 * trip and a small fraction of the shorter of the two Phase 0 windows, the
 * five-minute claim window; the grace covers both.
 */
const RECORD_GRACE_MS = 2000;
const RECORD_GRACE_WAKES = 5;

/**
 * The whole of that grace, which is what anything reasoning about it needs:
 * neither constant above means much on its own.
 *
 * **Exported for `spine.test.ts` beside it, and for nothing else.** The
 * package's entry point does not re-export it. The one case that lands a record
 * while a lifecycle is still waiting has to land it inside this window, and a
 * test holding its own copy of the number would drift from it silently: a
 * shorter grace would make that case fail as though the loop had changed, and a
 * longer one would leave it proving less than its name says.
 */
export const RECORD_GRACE_TOTAL_MS = RECORD_GRACE_MS * RECORD_GRACE_WAKES;

/**
 * How long the loop waits before re-reading after a conditional write matched
 * nothing.
 *
 * It is not a backoff for a race the loop expects to lose repeatedly: every
 * cause of a lost write leaves the next read with an answer that returns. A
 * lost transition means the Run moved out of the window it was writing over,
 * and a lost self-record means the column now names somebody else. It is there
 * so that **a future conjunct cannot turn that argument into a tight loop** - a
 * predicate that can fail while the Run stays put would otherwise spin against
 * the database, once per step, at whatever the platform charges for one. Short
 * enough that the genuine races above cost a fraction of a second, which is all
 * that reaches it today.
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
    hostedWorkflowRunId: schedule.hostedWorkflowRunId,
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
 * Writes this lifecycle's own id onto the Run, once the grace has passed with
 * the column still empty.
 *
 * It is the same first-writer-wins statement `dispatchLifecycle` performs,
 * reached from the other side: `IS NULL`-guarded in the control plane, so it
 * neither overwrites a recorded lifecycle nor re-asserts one, and the Run row
 * goes on arbitrating exactly as ADR 0014 has it. What makes it safe to call at
 * all is who is calling: a run that is alive, is past its own deadline, and has
 * watched the column stay empty for the whole grace, `RECORD_GRACE_WAKES` wakes
 * of `RECORD_GRACE_MS`.
 *
 * **The body acts on the re-read rather than on this answer**, which is the
 * loop's rule everywhere. `true` shows up as `mine` on the next wake and closes
 * whichever window is open; `false` shows up as somebody else's id and returns
 * `orphaned`, or as `mine` again where the platform is re-running a step that
 * already wrote, which at-least-once step execution allows and the re-read
 * absorbs like any other answer. The boolean is returned only so the caller can
 * tell a write that landed here from one that did not, without a second read.
 */
async function recordSelf(
  ownerId: number,
  runId: string,
  workflowRunId: string
): Promise<boolean> {
  "use step";
  const plane = await controlPlane();
  return await plane.lifecycle.record(ownerId, runId, workflowRunId);
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
  workflowRunId: string,
  observation: ExecutionLostObservation
): Promise<ExecutionLossOutcome> {
  "use step";
  const plane = await controlPlane();
  return await plane.lifecycle.terminateLostExecution({
    detector: "hosted_watchdog",
    evidence: { kind: "deadline", now: new Date(), workflowRunId },
    observation,
    ownerId,
    runId,
  });
}

/**
 * What the pass's durable run says about itself, read once the deadline has
 * passed and a pass id is recorded.
 *
 * It is read **only then**, and that is not an optimization: a pass that is
 * still running before its Run's deadline is the ordinary case, and asking the
 * World about it on every wake would be a round trip per sleep that could not
 * change what the loop does.
 *
 * Every failure is one answer - `null`, "unreadable" - because the distinction
 * the observation set draws is between a state the watchdog *read* and one it
 * could not. A pass whose id the World has never heard of is unreadable in the
 * same way a World that is down is: neither tells the watchdog what the pass
 * did.
 */
async function readPassDisposition(
  hostedWorkflowRunId: string
): Promise<PassDisposition> {
  "use step";
  try {
    return { status: await getRun(hostedWorkflowRunId).status };
  } catch {
    return { status: null };
  }
}

/**
 * Cancels the pass, best-effort, after the terminal transition has won.
 *
 * ADR 0014 has the lifecycle and the pass "cancelled by opposite mechanisms:
 * the lifecycle is resumed through its cancel hook so it terminates reportably,
 * the pass is cancelled outright". This is the second, and it swallows every
 * failure on purpose: the Run is already `failed(worker_lost)`, and a pass that
 * outlives its cancellation is inert - Acceptance has closed, so it can submit
 * nothing. Reporting a reclamation failure by throwing would retry the step and
 * re-run a transition that has already been decided.
 */
async function cancelPass(hostedWorkflowRunId: string): Promise<void> {
  "use step";
  try {
    await getRun(hostedWorkflowRunId).cancel();
  } catch {
    // Already gone, already terminal, or unreachable. See above.
  }
}

/**
 * What the watchdog saw, as one of ADR 0015's observations.
 *
 * ```text
 * no pass recorded        deadline_elapsed
 * pending | running       deadline_elapsed                 it is still going
 * completed               workflow_terminal_without_result it ended, and no
 *                                                          Result ever arrived
 * failed                  workflow_failed
 * cancelled               workflow_cancelled
 * unreadable              workflow_state_unavailable
 * ```
 *
 * **`deadline_elapsed` covers two different pictures** and that is deliberate:
 * with no pass id, and with a pass still running past its Run's deadline, the
 * watchdog has seen the same thing - nothing usable arrived in time. Inventing
 * a name for the second would claim the watchdog knows why, and it does not.
 *
 * **A `completed` pass is not a completed Run.** The transition only runs at
 * all over a Run still inside Acceptance's window, so a pass that returned
 * normally and left the Run there submitted no Result: that is what
 * `workflow_terminal_without_result` names, and it is why the status is read
 * rather than the pass's return value.
 *
 * **Which is also where a hosted pass's structured Failure ends up, today.**
 * Phase 0 has no transition for a Failure or a Refusal from Worker core, so
 * `@reprove/worker-hosted` returns either as the pass's own value and writes
 * nothing; the durable run then ends `completed`, and this mapping closes the
 * Run `failed(worker_lost)` with `workflow_terminal_without_result`, keeping
 * none of the reason, phase or detail the pass returned. Reading the return
 * value would not fix it - there would still be no failure reason to write
 * (`RUN_FAILURE_REASONS` has one member) - so it is recorded here as a gap
 * rather than patched at the watchdog, and [#83](https://github.com/nick-neely/reprove/issues/83) is where it is
 * received. It is unreachable in the shipped Phase 0 composition, whose Worker
 * core is a fixture that produces a Result or throws, and `spine.test.ts` pins
 * it.
 *
 * An unrecognized status maps to `workflow_state_unavailable` rather than
 * throwing: the World's status vocabulary belongs to a dependency, and a
 * lifecycle's job is to schedule rather than to assert. Saying "its state could
 * not be read" about a status this loop does not understand is true.
 *
 * **Exported for `lifecycle.test.ts` beside it, and for nothing else.** The
 * package's entry point does not re-export it: it takes a type this module
 * keeps to itself, and the mapping is the loop's own business rather than
 * something a consumer composes with. The module-level export is what lets the
 * one part of the liveness branch that can be enumerated exhaustively be
 * enumerated without a World and a database.
 *
 * @param pass What the pass's durable run said, or `null` where the Run records
 *   no pass at all.
 * @returns The observation the terminal transition records.
 */
export const observationFor = (
  pass: PassDisposition | null
): ExecutionLostObservation => {
  if (pass === null) {
    return "deadline_elapsed";
  }
  switch (pass.status) {
    case "pending":
    case "running": {
      return "deadline_elapsed";
    }
    case "completed": {
      return "workflow_terminal_without_result";
    }
    case "failed": {
      return "workflow_failed";
    }
    case "cancelled": {
      return "workflow_cancelled";
    }
    default: {
      return "workflow_state_unavailable";
    }
  }
};

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
  /**
   * Wakes spent waiting for this lifecycle's own id to appear on the Run.
   *
   * Counted per lifecycle rather than per window, so a run that spent part of
   * the grace on the claim window gets only the remainder on the liveness one.
   * That is the right way round: the wakes already spent are evidence that no
   * record is coming, and being claimed does not make one more likely.
   */
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
        // A record may still be on its way, so leave the column to it first:
        // see `RECORD_GRACE_MS`.
        if (unrecordedWakes < RECORD_GRACE_WAKES) {
          unrecordedWakes += 1;
          await sleep(RECORD_GRACE_MS);
          continue;
        }
        // None is coming, and no deadline can close this window: both
        // transitions name the recorded lifecycle in their predicate and there
        // is none, so returning here would leave the Run waiting on something
        // that is not a deadline - the prompt detector's token, or a
        // supersession - and neither is guaranteed to arrive. This run is
        // alive, so it writes its own id and lets the next wake act on what the
        // row says, as every wake does.
        const recorded = await recordSelf(ownerId, runId, mine);
        if (!recorded) {
          // Either another lifecycle wrote between the read above and this
          // write - the lost race `LOST_RACE_MS` bounds - or this step already
          // wrote and the platform is re-running it, which at-least-once step
          // execution allows. The next read names the winner either way.
          await sleep(LOST_RACE_MS);
        }
        continue;
      }

      if (unclaimed) {
        if (await closeUnclaimedWindow(ownerId, runId, mine)) {
          return { kind: "unscheduled" };
        }
      } else {
        const pass =
          woken.hostedWorkflowRunId === null
            ? null
            : await readPassDisposition(woken.hostedWorkflowRunId);
        const observation = observationFor(pass);
        const lost = await closeExecutionWindow(
          ownerId,
          runId,
          mine,
          observation
        );
        if (lost.terminalized) {
          // Terminalized first. Cancelling the still-running pass is
          // reclamation and belongs **after** this, best-effort, and only
          // because this transition won - cancelling first would make a
          // resource operation load-bearing for correctness. Where the Run
          // records no pass there is nothing to cancel, and that is fine: a
          // pass that emerges later cannot change a Run whose Acceptance has
          // already closed.
          if (woken.hostedWorkflowRunId !== null) {
            await cancelPass(woken.hostedWorkflowRunId);
          }
          return {
            cancelledPass: woken.hostedWorkflowRunId,
            kind: "worker_lost",
            lostFrom: lost.lostFrom,
            observation,
          };
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
