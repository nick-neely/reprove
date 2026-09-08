/**
 * Durable runs that stand in for a **pass** whose disposition is the subject.
 *
 * The watchdog reads one thing about a pass: the status its durable run carries
 * in the World. So what a case needs is a durable run that is genuinely
 * running, or that ended each of the three ways a durable run can end - not a
 * hosted pass in particular. These are that, and they are deliberately not
 * hosted passes: the shipped `hostedPass` composes the Phase 0 fixture core and
 * therefore submits a Result within milliseconds, which terminalizes the Run
 * and leaves no Run for a watchdog to close. A pass that has not answered yet is
 * the ordinary case in production and the impossible one for a fixture, so the
 * cases that need it start one of these instead.
 *
 * `failedPass` is the one exception to "the status is all that matters", and it
 * is there because that is the point: it ends `completed` like `silentPass`
 * while carrying a structured Failure as its value, so the case that starts it
 * measures what the watchdog does with a reason nothing wrote down.
 *
 * `spine.test.ts` drives the real `hostedPass` for what only it can show: that
 * a hosted Run reaches Worker core and its Result reaches Acceptance.
 */
import type { HostedPassOutcome } from "@reprove/worker-hosted";
import { sleep } from "workflow";

/*
 * `'use workflow'` is a directive the Workflow SDK's compiler reads off a
 * **function declaration**, so `func-style` yields to the SDK here as it does
 * in every module that defines one.
 */
/* oxlint-disable func-style */

/**
 * A pass that has not answered yet: it sleeps past any deadline a case will
 * wait for, so the World reports it `running` while the watchdog decides.
 */
export async function unfinishedPass(): Promise<"slept"> {
  "use workflow";
  await sleep(600_000);
  return "slept";
}

/** A pass that ended normally and submitted nothing. */
export async function silentPass(): Promise<"returned"> {
  "use workflow";
  return await Promise.resolve("returned");
}

/**
 * The structured Failure `failedPass` below ends with, which is the shape
 * `runHostedPlacement` returns for a Worker core that failed.
 *
 * A literal rather than a call into `@reprove/worker-hosted`: the value is what
 * matters, and a workflow body may reach only what the bundle inlines.
 */
export const PASS_FAILURE = {
  detail: "teardown could not be confirmed",
  kind: "failed",
  phase: "teardown",
  reason: "sandbox_teardown_incomplete",
} as const satisfies HostedPassOutcome;

/**
 * A pass that ended in a **structured Failure** - the outcome the real
 * placement returns when Worker core fails - and therefore wrote nothing.
 *
 * It is a durable run that ended `completed` carrying a reason, which is the
 * whole point: Phase 0 has no transition for a Worker's structured Failure, so
 * the reason travels in the return value and the Run is left inside
 * Acceptance's window for the watchdog. The case in `spine.test.ts` that starts
 * this is what measures that gap.
 */
export async function failedPass(): Promise<HostedPassOutcome> {
  "use workflow";
  return await Promise.resolve(PASS_FAILURE);
}

/** A pass that ended by throwing, which the World records as `failed`. */
export async function throwingPass(): Promise<never> {
  "use workflow";
  await Promise.resolve();
  throw new Error("the pass threw where no in-process detector could see it");
}
