<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/worker-hosted

## dist/core.d.ts

```ts
/**
 * The Worker core the hosted placement composes **in Phase 0**, and the Run
 * input it hands one.
 *
 * [ADR 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md) asserts
 * what the Phase 0 exit leaves absent, in its own words: "No checkout, no
 * Workspace, no Sandbox, no Harness. The Result is `worker-core`'s fixture."
 * This module is that sentence as code. `createPhase0WorkerCore()` satisfies
 * `WorkerCore` and produces a Result the way Worker core produces one - through
 * `composeResult`, against `@reprove/protocol`'s own schema - without launching
 * a Sandbox or invoking an Adapter.
 *
 * **It is a fixture and says so.** A real hosted core is
 * `createWorkerCore({ adapter, sandboxes, materialize, ... })`, and composing
 * one needs `@reprove/adapters` and `@reprove/sandbox-container`, which [ADR
 * 0010](../../../docs/adr/0010-package-graph-and-open-core-boundary.md) keeps
 * out of this package: the harness stack belongs to whoever composes the
 * deployment, and `runHostedPlacement` takes the core as an argument precisely
 * so that this package never has to choose one. Phase 1 replaces what this
 * module returns; nothing that consumes it has to change, because both are the
 * same `WorkerCore`.
 *
 * **What it is not.** It is not a test double: it is shipped, it is what the
 * hosted composition runs today, and it is the honest Phase 0 answer rather
 * than a stand-in for something absent from the build. It is also not a review:
 * the Result it composes has no Findings and says so in its summary, so nothing
 * downstream can read it as a clean bill of health a Reviewer gave. Every claim
 * about review quality is Phase 1's.
 */
import type { RunSpec } from "@reprove/protocol/v1";
import type { RunInput, WorkerCore } from "@reprove/worker-core";
/**
 * The summary the fixture Result carries. It names itself, because a Result
 * whose summary read like a review would be the one way this fixture could
 * mislead someone reading a Run back.
 */
export declare const PHASE_0_SUMMARY = "No review was performed. This Run executed the Phase 0 hosted placement, which composes no Harness and no Sandbox and reports no Findings.";
export interface Phase0WorkerCoreOptions {
    /** The build this Worker reports as its own, recorded on every Pass. */
    readonly workerBuildVersion: string;
    /** The clock the Pass record is stamped from. Injected so a test can pin it. */
    readonly clock?: () => number;
    /** Mints the Pass id. Injected so a test can pin it. */
    readonly newId?: () => string;
}
/**
 * Composes the Phase 0 hosted Worker core.
 *
 * @param options The build version, and the clock and id source a test pins.
 * @returns A `WorkerCore` that composes the fixture Result for any Run.
 * @throws {Error} When the composed Result does not validate. That is a defect
 *   in this module rather than something a Run did, and there is no honest
 *   outcome to degrade to: a Failure would claim a Pass ran and failed.
 */
export declare const createPhase0WorkerCore: (options: Phase0WorkerCoreOptions) => WorkerCore;
/**
 * The Run as Phase 0 hands it to Worker core.
 *
 * Every field below the spec is empty on purpose, and each absence is one of
 * ADR 0016's: no narrative reaches any Reviewer, so the inherited ADR 0013
 * constraint stays inherited; no conventions are read, because there is no
 * checkout to read them from; and `Exposure` is `none`, because no credential
 * is resolved for a Pass that invokes no Harness. The fixture core reads none
 * of it - it is here because `WorkerCore.execute` takes a `RunInput` and a real
 * core would read all of it, so the shape the composition passes is the shape
 * Phase 1 keeps.
 *
 * @param spec The Run's immutable spec, exactly as the claim granted it.
 * @returns The Run input for one Phase 0 hosted pass.
 */
export declare const phase0RunInput: (spec: RunSpec) => RunInput;
```

## dist/dispatch.d.ts

```ts
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
export type HostedClaim = {
    readonly kind: "granted";
    readonly grant: ClaimGrant;
} | {
    readonly kind: "no_run_available";
} | {
    readonly kind: "refused";
    readonly reason: string;
};
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
{
    readonly kind: "dispatched";
    readonly hostedWorkflowRunId: string;
    readonly executionToken: string;
}
/** Nothing was claimed, so nothing was started. The reason is the claim's. */
 | {
    readonly kind: "not_claimed";
    readonly reason: string;
}
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
export declare const dispatchHostedRun: (ports: HostedDispatchPorts, request: HostedDispatchRequest, options?: HostedDispatchOptions) => Promise<HostedDispatchOutcome>;
```

## dist/index.d.ts

```ts
import { createPhase0WorkerCore, phase0RunInput } from "./core.js";
import { dispatchHostedRun } from "./dispatch.js";
import { runHostedPlacement } from "./placement.js";
export declare const packageName: "@reprove/worker-hosted";
/**
 * The Worker core this package drives, named through its package export.
 * Exercising the edge keeps ADR 0010's matrix row a compiled fact rather than a
 * declaration.
 */
export declare const drives: {
    readonly protocolVersion: 1;
    readonly workerCore: {
        readonly adapters: "@reprove/adapters";
        readonly protocolVersion: 1;
        readonly sandboxContainer: "@reprove/sandbox-container";
    };
};
/**
 * The hosted composition, as one value.
 *
 * It is a bundle rather than four loose exports because of how it is reached:
 * `@reprove/control-plane-workflow` imports this module lazily, inside a step,
 * so that a self-hosted deployment can omit the package. One named object is
 * what that import destructures, and it is what makes "hosted dispatch is
 * composed, or it is not" a single fact at the seam.
 */
export declare const hostedPlacement: {
    readonly createPhase0WorkerCore: typeof createPhase0WorkerCore;
    readonly dispatchHostedRun: typeof dispatchHostedRun;
    readonly phase0RunInput: typeof phase0RunInput;
    readonly runHostedPlacement: typeof runHostedPlacement;
};
/**
 * The composition's type, so a consumer that imports this package **only as a
 * type** - which is what an optional dependency is imported as at the top of a
 * module - never has to write `typeof import(...)` to name it.
 */
export type HostedPlacement = typeof hostedPlacement;
export { createPhase0WorkerCore, PHASE_0_SUMMARY, phase0RunInput, } from "./core.js";
export type { Phase0WorkerCoreOptions } from "./core.js";
export { dispatchHostedRun } from "./dispatch.js";
export type { HostedClaim, HostedDispatchOptions, HostedDispatchOutcome, HostedDispatchPorts, HostedDispatchRequest, StartedPass, } from "./dispatch.js";
export { runHostedPlacement } from "./placement.js";
export type { HostedAcceptance, HostedExecution, HostedExecutionLoss, HostedLossOutcome, HostedPassOutcome, HostedPlacementPorts, HostedPlacementRequest, HostedSubmission, } from "./placement.js";
```

## dist/placement.d.ts

```ts
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
 * here as itself. `worker_lost` is the fallback for an execution that ended
 * without any acceptable terminal report, and an uncaught throw is exactly
 * that: Reprove's own code was on the stack, so it does not wait out a
 * ten-minute deadline for a crash it witnessed.
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
 */
import type { Result } from "@reprove/protocol/v1";
import type { FailurePhase, FailureReason, RunInput, WorkerCore } from "@reprove/worker-core";
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
export type HostedAcceptance = {
    readonly kind: "accepted";
    readonly runStatus: "completed" | "incomplete";
} | {
    readonly kind: "malformed";
    readonly reason: string;
} | {
    readonly kind: "rejected";
    readonly reason: string;
};
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
    readonly acceptResult: (submission: HostedSubmission) => Promise<HostedAcceptance>;
    /**
     * ADR 0015's terminal transition, reached by the `hosted_prompt` detector.
     * It absorbs no Result, so Acceptance stays the only path by which one
     * enters a Run.
     */
    readonly reportExecutionLost: (loss: HostedExecutionLoss) => Promise<HostedLossOutcome>;
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
{
    readonly kind: "accepted";
    readonly runStatus: "completed" | "incomplete";
}
/**
 * A Result was produced and Acceptance would not take it - the Run ended
 * while the pass ran, or the token is no longer its current one. Nothing is
 * retried and nothing is written: the Run has already been decided.
 */
 | {
    readonly kind: "rejected";
    readonly reason: string;
}
/** Worker core refused to execute. Nothing ran and nothing is written. */
 | {
    readonly kind: "refused";
    readonly reason: string;
}
/**
 * Execution began and produced no acceptable Result. It keeps its own
 * specific reason and is never collapsed into `worker_lost`.
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
 * what a transient failure needs.
 *
 * @param request Worker core, the Run, the execution's identity and the ports.
 * @returns How the pass ended, as the terminal value of the durable run.
 */
export declare const runHostedPlacement: (request: HostedPlacementRequest) => Promise<HostedPassOutcome>;
```
