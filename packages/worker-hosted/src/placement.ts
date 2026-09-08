/**
 * What a hosted Worker does with one Run: drive Worker core, and report what
 * came back through the ports the composition handed it.
 *
 * ```text
 * core.execute(input)
 *   result   -> acceptResult          the same Acceptance a self-hosted Worker
 *                                     reaches over HTTP, with no HTTP hop
 *   refusal  -> reported, unabsorbed  a decision not to execute
 *   failure  -> reported, unabsorbed  execution began and produced no Result
 *   threw    -> reportExecutionLost   the in-process `hosted_prompt` detector
 * ```
 *
 * **Placement is composition, not behaviour** ([ADR
 * 0001](../../../docs/adr/0001-one-worker-concept.md), [ADR
 * 0010](../../../docs/adr/0010-package-graph-and-open-core-boundary.md)). The
 * Run reaching Worker core here reaches the same `execute` a self-hosted daemon
 * calls, through the same authorization sequence, and produces the same
 * `WorkerOutcome`. What differs is the transport out: this composition holds
 * the control plane in the same process, so its ports are function calls where
 * the self-hosted lifecycle's are authenticated HTTP requests.
 *
 * **The ports are named over `@reprove/protocol` values and plain strings.**
 * `@reprove/control-plane` satisfies them structurally, and this package
 * depends on it nowhere: ADR 0010's matrix gives this package `worker-core`,
 * `protocol` and `workflow`, and a type import from the control plane would be
 * an edge the matrix does not carry. It also keeps the unit tests below honest
 * - they compose the placement over in-memory doubles, and a double is the same
 * shape the deployment passes rather than a weaker one.
 *
 * **A thrown Pass is the only thing that reaches `reportExecutionLost`.** [ADR
 * 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md) is
 * explicit that a *structured* Failure keeps its own specific reason and is
 * never collapsed into `worker_lost`, so `sandbox_teardown_incomplete` leaves
 * *this function* as itself rather than as a loss report. `worker_lost` is the
 * fallback for an execution that ended without any acceptable terminal report,
 * and an uncaught throw is exactly that: Reprove's own code was on the stack,
 * so it does not wait out a ten-minute deadline for a crash it witnessed.
 *
 * **What this deliberately does not do.** It does not decide anything about the
 * Run: every outcome above is a call to the control plane, which owns the
 * conditional statement and may refuse it. It does not retry: one pass is one
 * attempt, and a Run that needs another is a Run the control plane creates. It
 * does not submit a Refusal or a Failure anywhere, because Phase 0 has no
 * transition for either - ADR 0013 makes a Refusal unreachable and ADR 0014
 * leaves a hosted Worker's internal Failure signalled rather than submitted -
 * so both are returned to the caller as the pass's own terminal value and
 * nothing is written against the Run for them.
 *
 * **And what that costs the Run, stated rather than implied.** Because nothing
 * is written, the Run stays inside Acceptance's eligibility window with its
 * execution deadline still running, and the lifecycle's watchdog is what closes
 * it: the pass's durable run ended normally, so the watchdog reads it
 * `completed` and terminalizes the Run `failed(worker_lost)` with observation
 * `workflow_terminal_without_result`. The Failure's `reason`, `phase` and
 * `detail` - and a Refusal's reason - survive only as this function's return
 * value and reach no column. ADR 0015 names `reportHostedFailure` as the
 * transition that would carry them and no such transition exists yet:
 * `RUN_FAILURE_REASONS` has the single member `worker_lost`, so there is no
 * reason code for a Worker-reported Failure to land in, and giving it one is
 * its own change rather than this composition's - [#83](https://github.com/nick-neely/reprove/issues/83) is where
 * that change is received. **It is unreachable in the
 * shipped Phase 0 composition** - `createPhase0WorkerCore` composes the fixture
 * Result or throws, and can produce neither outcome - and it becomes reachable
 * with the first real Worker core. `spine.test.ts` in
 * `@reprove/control-plane-workflow` pins the behaviour end to end, so the gap
 * is measured rather than remembered.
 */
import type { Result } from "@reprove/protocol/v1";
import type {
  FailurePhase,
  FailureReason,
  RunInput,
  WorkerCore,
  WorkerOutcome,
} from "@reprove/worker-core";

/**
 * The execution ownership one claim created, as the placement carries it.
 *
 * The token is the whole of the execution's identity to the control plane
 * (ADR 0015): it is what Acceptance recognizes a submission by and what the
 * in-process detector presents as evidence, and it is placement-neutral, so
 * nothing here is a hosted-specific ownership story.
 */
export interface HostedExecution {
  readonly ownerId: number;
  readonly runId: string;
  readonly executionToken: string;
}

/** One Result, as the control plane's Acceptance is told about it. */
export interface HostedSubmission extends HostedExecution {
  readonly result: Result;
}

/**
 * What Acceptance answered, narrowed to what the placement acts on: it accepted
 * the Result, or it named why it would not.
 *
 * `reason` is a plain string rather than the control plane's own union, for the
 * reason the module header gives. The names are the control plane's and are not
 * restated here, because a second copy of a closed set is a set that can drift.
 */
export type HostedAcceptance =
  | {
      readonly kind: "accepted";
      readonly runStatus: "completed" | "incomplete";
    }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * The in-process detector's report, as ADR 0015 shapes it: the detector, what
 * it saw, and the token that proves which execution it saw it in.
 */
export interface HostedExecutionLoss {
  readonly ownerId: number;
  readonly runId: string;
  readonly detector: "hosted_prompt";
  readonly observation: "uncaught_throw";
  readonly evidence: {
    readonly kind: "execution";
    readonly executionToken: string;
  };
}

/** Whether the terminal transition was written by this report. */
export interface HostedLossOutcome {
  readonly terminalized: boolean;
}

/** The control plane, as the hosted placement reaches it. */
export interface HostedPlacementPorts {
  /**
   * ADR 0006's Acceptance, reached in-process because a hosted deployment
   * composes both halves. It is the same function the authenticated endpoint
   * reaches, not a second one beside it.
   */
  readonly acceptResult: (
    submission: HostedSubmission
  ) => Promise<HostedAcceptance>;
  /**
   * ADR 0015's terminal transition, reached by the `hosted_prompt` detector.
   * It absorbs no Result, so Acceptance stays the only path by which one
   * enters a Run.
   */
  readonly reportExecutionLost: (
    loss: HostedExecutionLoss
  ) => Promise<HostedLossOutcome>;
}

/** One pass of the hosted placement, as the composition assembles it. */
export interface HostedPlacementRequest {
  /**
   * Worker core, already composed. It is an argument rather than something
   * built here because ADR 0010 keeps `@reprove/adapters` and
   * `@reprove/sandbox-container` out of this package: what composes a real core
   * is the deployment, and what Phase 0 composes is the fixture in `./core.js`.
   */
  readonly core: WorkerCore;
  /** The Run as Worker core receives it. */
  readonly input: RunInput;
  /** Who this pass is, to the control plane. */
  readonly execution: HostedExecution;
  readonly ports: HostedPlacementPorts;
}

/**
 * How one hosted pass ended.
 *
 * Five members rather than three, because Worker core's three outcomes are not
 * the whole answer: a Result still has to survive Acceptance, and a pass that
 * threw was not an outcome at all.
 */
export type HostedPassOutcome =
  /** A Result was produced and Acceptance absorbed it. The Run is terminal. */
  | {
      readonly kind: "accepted";
      readonly runStatus: "completed" | "incomplete";
    }
  /**
   * A Result was produced and Acceptance would not take it - the Run ended
   * while the pass ran, or the token is no longer its current one. Nothing is
   * retried and nothing is written: the Run has already been decided.
   */
  | { readonly kind: "rejected"; readonly reason: string }
  /**
   * Worker core refused to execute. Nothing ran and nothing is written - so
   * the Run is left for the watchdog, which closes it `failed(worker_lost)` /
   * `workflow_terminal_without_result` at its execution deadline and keeps no
   * trace of this reason. See the module header; ADR 0013 makes a Refusal
   * unreachable in Phase 0.
   */
  | { readonly kind: "refused"; readonly reason: string }
  /**
   * Execution began and produced no acceptable Result. The reason, phase and
   * detail travel here and nowhere else: no transition carries a structured
   * Failure yet, so the Run is closed by the watchdog at its execution
   * deadline as `failed(worker_lost)` with observation
   * `workflow_terminal_without_result`, discarding all three. The shipped
   * Phase 0 core cannot produce this outcome. See the module header.
   */
  | {
      readonly kind: "failed";
      readonly reason: FailureReason;
      readonly phase: FailurePhase;
      readonly detail: string;
    }
  /**
   * The Pass threw past Worker core, and the in-process detector reported it.
   * `terminalized` is the control plane's answer, not this pass's claim.
   */
  | {
      readonly kind: "lost";
      readonly terminalized: boolean;
      readonly detail: string;
    };

/**
 * Runs one Run through Worker core and reports what came back.
 *
 * The `try` covers `core.execute` and nothing else, deliberately. A throw from
 * a port is not a Pass that crashed - it is the control plane being unreachable
 * for a moment - and reporting the execution lost on it would end a Run whose
 * pass is still running perfectly well. Letting it propagate is the correct
 * answer instead: the caller is a durable step, and the platform's own retry is
 * what a transient failure needs. Where the failing port is the loss report
 * itself, the Pass's own throw is carried out on the port error's `cause`: the
 * port failure is what the step must see, and the crash it was reporting has no
 * other trace, because nothing was written about it.
 *
 * @param request Worker core, the Run, the execution's identity and the ports.
 * @returns How the pass ended, as the terminal value of the durable run.
 */
export const runHostedPlacement = async (
  request: HostedPlacementRequest
): Promise<HostedPassOutcome> => {
  const { core, execution, input, ports } = request;

  let outcome: WorkerOutcome;
  try {
    outcome = await core.execute(input);
  } catch (error) {
    // The `hosted_prompt` detector. Reprove's own code is on the stack, so the
    // report carries the token that proves which execution threw rather than
    // waiting for a deadline to notice the silence.
    const detail = error instanceof Error ? error.message : String(error);
    let reported: HostedLossOutcome;
    try {
      reported = await ports.reportExecutionLost({
        detector: "hosted_prompt",
        evidence: {
          executionToken: execution.executionToken,
          kind: "execution",
        },
        observation: "uncaught_throw",
        ownerId: execution.ownerId,
        runId: execution.runId,
      });
    } catch (portError) {
      // Two failures at once, and only one of them can propagate. The port's is
      // the one that has to: it is the control plane being unreachable, and the
      // durable step's retry is the answer to it. But the throw it was
      // reporting is the fact whoever reads the retry needs, and it would
      // otherwise be lost entirely - the Pass that crashed leaves no other
      // trace, because nothing was written about it. So it travels on `cause`.
      // An already-explained port failure keeps its own chain rather than
      // having one overwritten.
      if (portError instanceof Error && portError.cause === undefined) {
        portError.cause = error;
      }
      throw portError;
    }
    return { detail, kind: "lost", terminalized: reported.terminalized };
  }

  // Neither of the next two branches calls a port, and that is the whole of
  // what Phase 0 can do with them: there is no transition for a Refusal or a
  // structured Failure. The consequence is not neutral and is not hidden - the
  // Run is left inside Acceptance's window, and the watchdog closes it
  // `failed(worker_lost)` / `workflow_terminal_without_result` at the execution
  // deadline, keeping none of the reason, phase or detail returned here. The
  // shipped Phase 0 core reaches neither branch; a real core will.
  if (outcome.kind === "refusal") {
    return { kind: "refused", reason: outcome.refusal.reason };
  }
  if (outcome.kind === "failure") {
    return {
      detail: outcome.failure.detail,
      kind: "failed",
      phase: outcome.failure.phase,
      reason: outcome.failure.reason,
    };
  }

  const accepted = await ports.acceptResult({
    executionToken: execution.executionToken,
    ownerId: execution.ownerId,
    result: outcome.result,
    runId: execution.runId,
  });
  if (accepted.kind === "accepted") {
    return { kind: "accepted", runStatus: accepted.runStatus };
  }
  return { kind: "rejected", reason: accepted.reason };
};
