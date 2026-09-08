/**
 * The composition seam: how a hosted Run is claimed, started and recorded, in
 * that order and no other.
 *
 * ```text
 * claimRun          the same conditional UPDATE the endpoint reaches (ADR 0015)
 *   -> startPass    a durable run now exists; nothing records it yet
 *   -> markExecuting  claimed -> executing, writing the pass id
 * ```
 *
 * **The middle window cannot be closed.** [ADR
 * 0014](../../../docs/adr/0014-workflow-orchestration-seam.md): `start()`
 * accepts neither an idempotency key nor a caller-supplied run id, so there is
 * no arrangement in which starting the pass and recording it are one fact. A
 * crash between them leaves:
 *
 * ```text
 * status                claimed
 * executionToken        assigned
 * hostedWorkflowRunId   null          <- nothing knows the pass exists
 * claimableUntil        never fires   <- it writes only over `queued`
 * ```
 *
 * which is [ADR
 * 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md)'s mandatory
 * abandoned case. Execution liveness closes it on the `executionToken` alone,
 * `lostFrom: claimed`, and there is nothing to cancel - which is why [ADR
 * 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
 * covers the whole of Acceptance's eligibility window rather than `executing`
 * alone.
 *
 * **The order is not negotiable.** Claiming last would start a pass against a
 * Run nobody owns; recording before starting would name a durable run that does
 * not exist, and the lifecycle would later cancel an id the World has never
 * heard of. Every other order trades an inert orphan - a pass that runs and
 * changes nothing, because the Run it would submit to has closed - for a Run
 * that is owned by no execution or points at no pass.
 *
 * **This is where the ports are named and nowhere else.** They are declared
 * over `@reprove/protocol` values and plain strings, so `@reprove/control-plane`
 * satisfies them structurally while ADR 0010's matrix keeps this package free
 * of it. The functions behind them are the control plane's own `claimRun` and
 * `markExecuting`, which are the same statements the Worker-facing endpoints
 * reach rather than a hosted pair beside them.
 */
import type { ClaimGrant } from "@reprove/protocol/v1";

/** Which Run is being dispatched, and to whom it belongs. */
export interface HostedDispatchRequest {
  readonly ownerId: number;
  readonly runId: string;
}

/**
 * What one claim answered. Assignable from the control plane's own
 * `ClaimOutcome`; the refusal names are the control plane's and are not
 * restated here, because a second copy of a closed set is a set that can drift.
 */
export type HostedClaim =
  | { readonly kind: "granted"; readonly grant: ClaimGrant }
  | { readonly kind: "no_run_available" }
  | { readonly kind: "refused"; readonly reason: string };

/** The pass, as the runtime that started it names it. */
export interface StartedPass {
  readonly hostedWorkflowRunId: string;
}

/** Everything hosted dispatch reaches outside itself. */
export interface HostedDispatchPorts {
  /**
   * The hosted claim: the same conditional UPDATE the authenticated endpoint
   * reaches, naming its Run because hosted dispatch already knows which Run it
   * is dispatching and never polls (ADR 0006).
   */
  readonly claimRun: (request: HostedDispatchRequest) => Promise<HostedClaim>;
  /**
   * Starts the durable run that executes the Run, and hands back its id.
   *
   * A port rather than a `start()` call, because a `'use workflow'` function
   * belongs to the package that defines every workflow and configures every
   * step (ADR 0014), and this package defines none. What it owns is the
   * ordering above.
   */
  readonly startPass: (grant: ClaimGrant) => Promise<StartedPass>;
  /** `claimed` to `executing`, recording the pass. The write that closes the window. */
  readonly markExecuting: (execution: {
    readonly ownerId: number;
    readonly runId: string;
    readonly executionToken: string;
    readonly hostedWorkflowRunId: string;
  }) => Promise<boolean>;
}

/**
 * The one test-only branch in shipped orchestration, and the cost of it.
 *
 * ADR 0016 states the cost outright: *"The crash is inside Reprove's own
 * dispatch path, between `start()` and `markExecuting`, so no misbehaving
 * Worker can reach it: the scenario needs an injection point at the composition
 * seam, which is a test-only branch inside shipped orchestration."* And, under
 * what the ADR deliberately does not claim: *"The injection point is a known
 * impurity. A test-only branch in shipped orchestration is a real cost,
 * accepted for one case."*
 *
 * It is paid rather than avoided because the window it reaches is the reason
 * ADR 0015 widened the terminal transition from `executing` to the whole of
 * Acceptance's eligibility window. A Phase 0 exit that could not reach it would
 * not exercise what [#39](https://github.com/nick-neely/reprove/issues/39)
 * inherited.
 *
 * It is shaped to make misuse loud rather than convenient:
 *
 * ```text
 * an option, not an environment variable  a deployment cannot switch it on
 * undefined by default                    the shipped composition passes nothing
 * returns `never`                         it may only throw; it cannot alter a
 *                                         value, so no execution path forks on
 *                                         what it returns
 * ```
 *
 * `dispatch.test.ts` asserts that the shipped hosted composition never sets it.
 */
export interface HostedDispatchOptions {
  /**
   * Called after `start()` has returned and before the pass id is recorded, so
   * that a test can end the process there. Left unset in every composition
   * Reprove ships.
   */
  readonly interruptBeforeRecordingPass?: () => never | Promise<never>;
}

/** How one dispatch ended. */
export type HostedDispatchOutcome =
  /** The Run is claimed, its pass is running, and the Run records it. */
  | {
      readonly kind: "dispatched";
      readonly hostedWorkflowRunId: string;
      readonly executionToken: string;
    }
  /** Nothing was claimed, so nothing was started. The reason is the claim's. */
  | { readonly kind: "not_claimed"; readonly reason: string }
  /**
   * The pass is running and the Run does not record it, because the Run moved
   * while dispatch was starting one: it ended, or its token was rotated. The
   * pass is inert - it can submit nothing to a Run whose Acceptance has closed
   * - and there is no id anywhere for the lifecycle to cancel.
   */
  | {
      readonly kind: "unrecorded";
      readonly hostedWorkflowRunId: string;
    };

/**
 * Claims a Run, starts its pass, and records it.
 *
 * @param ports The control plane's claim and transition, and the pass start.
 * @param request The Run to dispatch.
 * @param options The test-only injection point. Nothing Reprove ships sets it.
 * @returns What the dispatch concluded.
 */
export const dispatchHostedRun = async (
  ports: HostedDispatchPorts,
  request: HostedDispatchRequest,
  options: HostedDispatchOptions = {}
): Promise<HostedDispatchOutcome> => {
  const claimed = await ports.claimRun(request);
  if (claimed.kind !== "granted") {
    return {
      kind: "not_claimed",
      reason:
        claimed.kind === "no_run_available"
          ? "no_run_available"
          : claimed.reason,
    };
  }

  const { executionToken } = claimed.grant;
  const started = await ports.startPass(claimed.grant);

  // ADR 0016's paid cost. Between `start()` and the write, which is the only
  // place a caller can be when the orphan is created.
  await options.interruptBeforeRecordingPass?.();

  const recorded = await ports.markExecuting({
    executionToken,
    hostedWorkflowRunId: started.hostedWorkflowRunId,
    ownerId: request.ownerId,
    runId: request.runId,
  });
  if (!recorded) {
    return {
      hostedWorkflowRunId: started.hostedWorkflowRunId,
      kind: "unrecorded",
    };
  }
  return {
    executionToken,
    hostedWorkflowRunId: started.hostedWorkflowRunId,
    kind: "dispatched",
  };
};
