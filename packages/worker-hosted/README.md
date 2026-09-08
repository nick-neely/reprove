# `@reprove/worker-hosted`

The hosted Worker lifecycle: `@reprove/worker-core`, driven by a durable pass, reporting in-process to a control plane composed beside it.

Hosted capability is optional composition, not a default. A hosted-capable deployment composes `@reprove/control-plane` + `@reprove/control-plane-workflow` + `@reprove/worker-hosted`; the self-hosted composition omits this package entirely. Keeping it out of `@reprove/control-plane` is what makes "a control plane that dispatches only to self-hosted Workers installs no harness code at all" true.

## What the package holds

```text
dispatch.ts    dispatchHostedRun    claim -> start the pass -> record it
placement.ts   runHostedPlacement   Worker core -> Acceptance, or the in-process detector
core.ts        createPhase0WorkerCore, phase0RunInput   ADR 0016's fixture Result
```

Every one of them takes its dependencies as arguments. That is what keeps this package's [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md) row honest in both directions: the ports are named over `@reprove/protocol` values and plain strings, so `@reprove/control-plane` satisfies them structurally while this package depends on none of it, and Worker core arrives composed, so `@reprove/adapters` and `@reprove/sandbox-container` stay out of the graph.

**Nothing here holds a workflow or configures a step.** [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) gives every `'use workflow'` and `'use step'` definition to `@reprove/control-plane-workflow`, because a step compiles into a bundle whose module graph is fixed at build time and *the layer that defines steps is the only layer that can configure them* - a step resolves its own configuration from the environment, and this package reads no environment and composes no control plane. So the durable shape lives there and the behaviour lives here, and `hostedPlacement` is the single object that package imports lazily.

## `runHostedPlacement`: the placement is composition, not behaviour

```text
core.execute(input)
  result   -> acceptResult          the same Acceptance a self-hosted Worker
                                    reaches over HTTP, with no HTTP hop
  refusal  -> reported, unabsorbed  a decision not to execute
  failure  -> reported, unabsorbed  execution began and produced no Result
  threw    -> reportExecutionLost   the in-process `hosted_prompt` detector
```

The Run reaching Worker core here reaches the same `execute` a self-hosted daemon calls, through the same authorization sequence, and produces the same `WorkerOutcome` ([ADR 0001](../../docs/adr/0001-one-worker-concept.md)). What differs is the transport out: a hosted deployment composes both halves, so Acceptance is a function call where the self-hosted lifecycle makes an authenticated HTTP request.

**A thrown Pass is the only thing that reaches `reportExecutionLost`.** [ADR 0015](../../docs/adr/0015-execution-ownership-and-worker-liveness.md) is explicit that a *structured* Failure keeps its own specific reason and is never collapsed into `worker_lost`, so `sandbox_teardown_incomplete` leaves `runHostedPlacement` as itself rather than as a loss report. An uncaught throw is the fallback case: Reprove's own code was on the stack, so the report carries the execution token as evidence and the Run ends in milliseconds rather than at a ten-minute deadline.

**What a Failure or a Refusal costs the Run, which is a gap rather than a design.** Neither reaches a port, so nothing is written and the Run stays inside Acceptance's eligibility window with its execution deadline running. The lifecycle's watchdog is what closes it: the pass's durable run ended normally, so the watchdog reads it `completed` and terminalizes the Run `failed(worker_lost)` with observation `workflow_terminal_without_result`. The Failure's reason, phase and detail reach no column - they exist only as the pass's return value. ADR 0015 names `reportHostedFailure` as the transition that would carry them and there is none: `RUN_FAILURE_REASONS` has the single member `worker_lost`, so a Worker-reported Failure has no reason code to land in, and minting one is its own change rather than this composition's. **It is unreachable in the shipped Phase 0 composition**, whose core is `createPhase0WorkerCore` and produces a Result or throws; the first real Worker core makes it reachable. `spine.test.ts` in `@reprove/control-plane-workflow` drives a pass that ends in a structured Failure to its deadline and asserts exactly this outcome, so the gap is measured rather than remembered.

The `try` covers `core.execute` and nothing else, deliberately. A throw from a port is not a Pass that crashed - it is the control plane being unreachable for a moment - and reporting the execution lost on it would end a Run whose pass is running perfectly well. It propagates instead, to the durable step that called it, where the platform's own retry is the right answer.

## `dispatchHostedRun`: the ordering, and the window it cannot close

```text
claimRun          the same conditional UPDATE the Worker endpoint reaches
  -> startPass    a durable run now exists; nothing records it yet
  -> markExecuting  claimed -> executing, writing the pass id
```

`start()` accepts neither an idempotency key nor a caller-supplied run id ([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)), so there is no arrangement in which starting the pass and recording it are one fact. A crash between them leaves:

```text
status                claimed
executionToken        assigned
hostedWorkflowRunId   null          <- nothing knows the pass exists
claimableUntil        never fires   <- it writes only over `queued`
```

which is [ADR 0016](../../docs/adr/0016-phase-0-acceptance-scenario.md)'s mandatory abandoned case. Execution liveness closes it on the `executionToken` alone, `lostFrom: claimed`, and there is nothing to cancel - which is why ADR 0015 covers the whole of Acceptance's eligibility window rather than `executing` alone.

The order is not negotiable. Claiming last would start a pass against a Run nobody owns; recording before starting would name a durable run that does not exist, and the lifecycle would later try to cancel an id the World has never heard of. Every other order trades an inert orphan - a pass that runs and changes nothing, because the Run it would submit to has closed - for a Run owned by no execution or pointing at no pass.

### The injection point, which is a paid cost

`HostedDispatchOptions.interruptBeforeRecordingPass` is the one test-only branch in shipped orchestration, and ADR 0016 records the price rather than hiding it:

> The crash is inside Reprove's own dispatch path, between `start()` and `markExecuting`, so no misbehaving Worker can reach it: the scenario needs an injection point at the composition seam, which is a test-only branch inside shipped orchestration.

and, under what that ADR deliberately does not claim:

> The injection point is a known impurity. A test-only branch in shipped orchestration is a real cost, accepted for one case.

It is paid because the window it reaches is the reason ADR 0015 widened the terminal transition from `executing` to the whole eligibility window: a Phase 0 exit that could not reach it would not exercise what [#39](https://github.com/nick-neely/reprove/issues/39) inherited. It is shaped to make misuse loud rather than convenient:

```text
an option, not an environment variable  a deployment cannot switch it on
undefined by default                    the shipped composition passes nothing
returns `never`                         it may only throw; nothing forks on a
                                        value it returned
```

`dispatch.test.ts` fixes the default behaviour, and `pass.test.ts` in `@reprove/control-plane-workflow` asserts that no shipped module of the composition that drives this ever assigns it.

## The Phase 0 Worker core is a fixture, and says so

ADR 0016 asserts what the Phase 0 exit leaves absent, in its own words: *"No checkout, no Workspace, no Sandbox, no Harness. The Result is `worker-core`'s fixture."* `createPhase0WorkerCore()` is that sentence as code. It satisfies `WorkerCore` and composes a Result the way Worker core composes one - through `composeResult`, validated against `@reprove/protocol`'s own schema - without launching a Sandbox or invoking an Adapter, and its summary states that no review was performed. An empty Result otherwise means "the review completed and found nothing", which is a claim Phase 0 has no right to make.

It is **shipped, not a test double**: it is what the hosted composition runs today. A real hosted core is `createWorkerCore({ adapter, sandboxes, materialize, ... })`, and composing one needs `@reprove/adapters` and `@reprove/sandbox-container`, which ADR 0010 keeps out of this package - so the core is an argument to `runHostedPlacement`, and Phase 1 replaces what this module returns without changing anything that consumes it.

`phase0RunInput(spec)` is the other half: no narrative reaches any Reviewer, no conventions are read because there is no checkout to read them from, and `Exposure` is `none` because no credential is resolved for a Pass that invokes no Harness. Each absence is one of ADR 0016's.

## Where the optional edge is enforced

`tools/verify-workspace.mjs` carries this package as `@reprove/control-plane-workflow`'s **optional peer**: `peerDependencies` plus `peerDependenciesMeta.optional`, rejected in `dependencies` and in `optionalDependencies` alike. The spelling is load-bearing rather than stylistic. pnpm installs `optionalDependencies` by default - only an install passing `--omit=optional` skips them - so that field would put this package into every deployment. `autoInstallPeers`, which is on by default, installs missing **non-optional** peers only, so an optional peer arrives exactly when the composition root names it and never otherwise. (`devDependencies` names it too, which no consumer installs: the orchestration package type-checks and tests against this one.)

So the **composition root decides**. `apps/control-plane` is the hosted root and declares this package directly; a self-hosted root declares neither it nor anything that requires it. Beside that, a `harness-reach` rule reads the whole `@reprove/*` graph and asserts three things the row-by-row matrix cannot see:

```text
@reprove/control-plane   cannot reach @reprove/worker-core at all
apps/control-plane       declares @reprove/worker-hosted
apps/control-plane       can reach @reprove/worker-core only through it
```

Removing this node from the graph is exactly what a self-hosted install does, so removing it and re-running the search is the question `pnpm why` answers, asked at review time. `tools/verify-workflow-build.mjs` holds the other end: the emitted workflow bundle names no module but the workflow runtime **and** carries none of the harness stack's package names, inlined or imported.

## Tests

```text
pnpm vitest run packages/worker-hosted
```

They run under the root runner, because nothing here is a workflow: the ports are in-memory doubles, and what they measure is which port a given outcome reaches - and, for most cases, which port it does **not**. The pass driving a real durable run against a real database is `spine.test.ts` in `@reprove/control-plane-workflow`.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). Public source, gated by every CI check, carrying **no stability promise**.
