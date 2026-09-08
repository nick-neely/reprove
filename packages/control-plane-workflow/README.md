# `@reprove/control-plane-workflow`

Every workflow and step definition for the hosted control plane, and all step configuration. The [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md) matrix permits it `@reprove/protocol`, `@reprove/control-plane` and `workflow`, and no harness code; the `workflow` dependency arrived with the Run-lifecycle scheduling issue ([#50](https://github.com/nick-neely/reprove/issues/50)), so all three edges are declared and the package holds the durable spine rather than a shell.

It exists because a `'use step'` function is compiled into a bundle whose module graph is fixed at build time, so **the layer that defines steps is the only layer that can reliably configure them**. Leaving the definitions in `@reprove/control-plane` would force that package to read the environment, which [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md) forbids ([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)).

The name is qualified deliberately: `Adapter` is already a `CONTEXT.md` noun, and naming rule 4 qualifies the _foreign_ word - Vercel's `Workflow` - at the seam. The same rule governs the identifiers below: Vercel Workflow's `runId` is a `workflowRunId` everywhere it crosses into Reprove, because a Run is Reprove's own noun.

## What the package holds

```text
composition.ts   controlPlane(), composed once per process from process.env, and
                 hostedPlacement(), the optional hosted composition
environment.ts   configFromEnvironment(), the only place Reprove's library code reads the environment
ingress.ts       ingressDelivery, the workflow a committed delivery is handed to, and startDelivery()
lifecycle.ts     runLifecycle, the Run's durable schedule, and lifecycleToken()
pass.ts          hostedPass, one hosted Worker's attempt at a Run
hosted.ts        dispatchHostedPass(), which claims a Run and starts one
notify.ts        notifyLifecycle(), waking a lifecycle after the control plane has already decided
```

`apps/control-plane` composes all of it: its `next.config.ts` wraps the build with `withWorkflow`, and its webhook route calls `controlPlane()` and hands the request on. The workflow functions are exported for the **builder** rather than for callers - a `'use workflow'` function has to be reachable from the application's module graph for the Workflow build to discover and register it, and the builder follows a bare import only into a package that declares `workflow`. Nothing else in Reprove calls `start()`.

## `controlPlane()` and why a step reads the environment

`controlPlane()` composes the one control plane a process holds, from `process.env` through `configFromEnvironment()`, and memoizes it. Composition is **once per process** rather than per call because `createControlPlane()` opens a connection pool and runs [ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md) rule 6's seven tenancy assertions, and repeating that per delivery would spend GitHub's ten-second wall on work whose answer cannot change between two requests. The memo holds the promise rather than the resolved value, so concurrent first callers share one composition instead of racing to build several pools. **A composition that throws is not memoized as a failure**: the memo is cleared and the next caller tries again, because a boot refusal is usually a deployment being repaired and a permanently poisoned module would need a redeploy to clear.

Every step calls `controlPlane()` first rather than receiving a composed plane from its caller, and that is a fact about the build rather than a preference. A `'use step'` function compiles into a bundle whose module graph is fixed at build time, and **whether that bundle shares a module instance with the route that composed the deployment is builder-dependent** - the same instance under Turbopack, a different one under `@workflow/vitest`. A step can therefore neither rely on being configured by its caller nor assume it must not read the environment, so it resolves its own configuration ([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)). Under a builder that gives a step its own module registry this costs a second pool and a second pass over the boot checks, and nothing else: neither composition holds state the other needs.

That is also what lets `@reprove/control-plane`'s library code read no environment variable at all, literally rather than nearly - its operator CLI, `src/bin.ts`, is the one named exception and reads only what an operator passes it. `ENVIRONMENT` in [`src/environment.ts`](src/environment.ts) names each variable once - `REPROVE_DATABASE_URL`, `REPROVE_GITHUB_WEBHOOK_SECRET`, `REPROVE_GITHUB_APP_ID`, `REPROVE_GITHUB_PRIVATE_KEY` and the optional `REPROVE_GITHUB_API_URL` - so the app's README, the build gate and this parser cannot drift on a spelling. The parse is a pure function of an environment object, and an absent value passes through as an empty string rather than being refused twice: `createControlPlane()` already names the missing field in the error it throws. `PHASE_0_RUN_PROFILE` and the `kick` are passed **by name**, not read from the environment, which is the whole point of [ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s profile - a harness or a model read from a variable would be a Phase 0 fixture quietly becoming product selection policy.

## `ingressDelivery`: a committed delivery becomes a Run

```text
webhook commits the envelope, answers 200
  -> startDelivery()                 start(ingressDelivery, [delivery])
       step processDelivery          the advisory lock, the canonical fetch, the Run
       step dispatchLifecycle        start(runLifecycle); the Run row arbitrates
       step notifyEnded              wake the lifecycles of Runs this delivery ended
```

`startDelivery()` is the kick the app passes to `createControlPlane()`. Like every kick it is synchronous and returns nothing - the acknowledgement must not wait on it - and it does not rethrow, because an unhandled rejection would take the process down for a delivery whose envelope is already durable and recoverable by a manual GitHub redelivery. It does **report**, to standard error: a deployment whose World is misconfigured would otherwise acknowledge every delivery, run nothing and say nothing anywhere, and a manual recovery nobody is told to perform is not one. `composition.ts` imports the workflow module lazily for exactly this: `ingress.ts` imports `composition.ts` for its steps, so a static import each way would be a cycle, and the kick is the one edge that can be deferred without changing what it does.

**The re-drive is the platform's own step retry, not a mechanism Reprove built.** `processDelivery` calls the control plane, and where the ledger row settles nonterminal it turns the retry class into a throw: `contended` and `transient` throw `RetryableError`, and Workflow's step retry is then the re-drive [ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md) made a Phase 0 exit condition. `operator_attention` throws `FatalError` and stops, because retrying reaches the same answer on every attempt and a retry loop nobody can see is exactly what classifying by cause exists to prevent. No Reprove-owned sweeper, backoff table or second job system appears beside the orchestrator [#6](https://github.com/nick-neely/reprove/issues/6) already settled, which is what makes [ADR 0006](../../docs/adr/0006-worker-protocol.md)'s "ingress must not write a parallel queue" true by construction rather than by discipline.

The schedule is a Phase 0 fixture, exported as `RE_DRIVE`:

```text
contendedAfterMs   2_000    another processor holds the same pull request's lock
transientAfterMs   30_000   GitHub answered 5xx, 429 or a rate limit
maxRetries         5        retries after the first attempt
```

Nothing in Phase 0 measures either delay; both are chosen to be observable during development rather than to be right. `contended` is short because the lock holder releases within one transaction's `idle_in_transaction_session_timeout` at most, and `transient` is long because GitHub clears on its own but not in a second. `maxRetries` counts retries **after** the first attempt, so a delivery is attempted at most one more time than that before the workflow run fails and the ledger row is left `received` for an operator, with its retry class saying why.

`dispatchLifecycle` starts the lifecycle and then records it, in that order, because `start()` cannot be made idempotent: it accepts neither an idempotency key nor a caller-supplied run id, so the window between starting and recording cannot be closed and a crash inside it orphans a durable run no conditional update can find. The Run row arbitrates instead - first writer of the lifecycle id wins - and the loser cancels its own run on the spot, which is [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)'s orphan being made inert immediately rather than at its deadline.

## `runLifecycle`: the Run's durable schedule

The lifecycle is the Run's schedule and outlives any Worker; a **pass** is one Worker's attempt at it, recorded in a separate column and cancelled by the opposite mechanism. **The lifecycle schedules; it does not decide.** Every fact about a Run's outcome is written by the control plane, and this workflow reads what was written. [ADR 0015](../../docs/adr/0015-execution-ownership-and-worker-liveness.md) shapes it as a state-driven loop that re-reads authoritative Run state on every wake rather than trusting the timestamp it slept toward:

```text
wake
  -> read authoritative Run state
     invisible, or another lifecycle recorded  -> return, having written nothing
     terminal                                  -> return
     queued              -> claim-window branch, on claimableUntil
     claimed | executing -> liveness branch, on the CURRENT executionExpiresAt
                            deadline ahead   -> sleep toward it, or until notified
                            deadline passed  -> attempt failed(worker_lost)
```

**The two branches are one shape.** Each window is a bounded deadline the Run itself carries, so below the branch the loop either sleeps toward it or tries to close it, and only the transition differs. That is what keeps this **one durable run per Run**: a separate watchdog workflow was rejected because it would add a third `start()` orphan window of exactly the kind that leaves a Run at `claimed` with a live, unrecorded pass - the hole the liveness branch exists to close. The cost is one pending `sleep` per lost race, an un-cancelled job that fires later as an early-return no-op.

The read and the conditional write are steps; the branching is the workflow body. That split is not stylistic. **Everything the workflow body reaches is inlined into the workflow bundle, and that bundle runs in a VM with no `require`**, so the body calls the runtime's own primitives and the steps and nothing else - a helper hoisted to module scope and called from the body would drag its whole transitive graph into the bundle and break every workflow in the application, at runtime, with an error naming an innocent one, while the build stayed green. That is also why the step decides whether the deadline has passed: a workflow body may not read the clock, and the loop needs an answer about a deadline it did not sleep toward.

Every lifecycle-side mutation is conditional on the writer being the lifecycle the Run records, so an orphan wakes, matches nothing, and ends.

**A deadline that passes while nothing is recorded is waited out, briefly, rather than treated as orphanhood.** `dispatchLifecycle` starts before it records, so a Run whose lifecycle has not yet been written has two possible causes and they want opposite answers: the dispatching step crashed in that window, in which case this run is an orphan and must end, or the write is simply still in flight. Ending immediately is wrong for the second - the record then commits against a lifecycle that has already returned, and nothing is left to close the unclaimed window, so the Run would stay `queued` past its deadline forever. The loop waits two seconds per wake for five wakes and then gives up, because a genuine orphan must not linger either; ten seconds is many times one database round trip and a small fraction of the five-minute deadline it has to cover. `claimableUntil` bounds the unclaimed window and nothing else: it writes exactly one transition, `unscheduled`, over a Run that was never claimed.

**The liveness branch is what ends a Run whose Worker stopped answering.** [ADR 0015](../../docs/adr/0015-execution-ownership-and-worker-liveness.md) gives execution liveness to this same loop, with `executionExpiresAt` - written at claim for both placements - as its second window. The branch re-reads that column on every wake rather than remembering it, which is what will make a self-hosted Lease renewal a column write rather than a second liveness system: a wake that finds a later deadline simply sleeps again. The transition itself is the control plane's, over exactly Acceptance's eligibility window, so the watchdog and Acceptance cannot disagree about whether a Run was still live. **This branch is one of the two detectors with a caller in Phase 0**; the other is the in-process `try`/`catch` `@reprove/worker-hosted` wraps a hosted pass in ([#57](https://github.com/nick-neely/reprove/issues/57)). A stopped Lease renewal is the third, and waits on a self-hosted Worker.

**What the watchdog can say for itself depends on whether a pass is recorded.** Once the deadline has passed and the Run records one, the branch reads that durable run's state and maps it onto ADR 0015's observations - `workflow_failed`, `workflow_cancelled`, `workflow_terminal_without_result`, and `workflow_state_unavailable` where nothing could be read at all. It is read **only then**: a pass running inside its Run's window is the ordinary case, and asking the World about it on every wake would be a round trip per sleep that could not change what the loop does. With no pass id, or one still running, `deadline_elapsed` is the whole of what the watchdog saw, and it says only that. A `completed` pass is not a completed Run - the transition writes only over a Run still inside Acceptance's window, so a pass that returned normally and left it there submitted no Result.

**The terminal write is the correctness boundary; cancelling is reclamation.** The branch terminalizes first and cancels the still-running pass second, best-effort, and only because its transition won - cancelling first would make a resource operation load-bearing for correctness. The cancel swallows every failure, because the Run is already `failed(worker_lost)` and a pass that outlives its cancellation is inert: Acceptance has closed, so it can submit nothing. Where the Run records no pass there is nothing to cancel, and that is fine for the same reason.

## `hostedPass` and `dispatchHostedPass`: the hosted placement

```text
dispatchHostedPass                    a plain function; nothing durable yet
  plane.claimRun                      execution ownership, the same conditional UPDATE
                                      the Worker endpoint reaches
  start(hostedPass, [grant, owner])   the pass is now genuinely running
  -- the window ADR 0016 pays to reach --
  plane.markExecuting                 claimed -> executing, pass id recorded

hostedPass                            'use workflow'
  step executeHostedPass              worker-hosted drives worker-core and reports
                                      through the control plane
```

**The workflow is here and the behaviour is in [`@reprove/worker-hosted`](../worker-hosted/README.md).** [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) gives this package every workflow and step definition for the reason above - a step resolves its own configuration, and that package reads no environment and composes no control plane. So the placement, the dispatch ordering and the Phase 0 Worker core are its, reached here through ports; the durable shape, the step boundaries and the composition are this package's.

**`@reprove/worker-hosted` is an optional dependency**, declared in `optionalDependencies` and imported lazily by `hostedPlacement()`. That is [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)'s deployment table as an edge: a hosted deployment composes it, a self-hosted one omits it, and *"a control plane that dispatches only to self-hosted Workers installs no harness code at all"* is only true if this package runs without it. So its absence is an answer rather than a crash - `null` composes no hosted dispatch, every step above answers `not_composed`, and the webhook, the claim endpoint, Acceptance and the lifecycle are untouched. A package that is present and *broken* is rethrown instead, because answering `null` there would report a defective deployment as a self-hosted one. `tools/verify-workspace.mjs` carries the edge as an explicit optional class and asserts, over the whole `@reprove/*` graph, that the app reaches `@reprove/worker-core` only through this driver and that `@reprove/control-plane` cannot reach it at all.

**`dispatchHostedPass` lives in `hosted.ts` rather than beside the workflow, and that is a build decision.** It calls `controlPlane()` and `hostedPlacement()` at module scope, and everything a module holding a `'use workflow'` function reaches is inlined into the workflow bundle - which runs in a VM with no `require`. Beside `hostedPass` it dragged the control plane, the Postgres driver and the whole harness stack into that bundle and the builder refused the build naming a Node built-in in an innocent file, which is exactly the failure the real-builder gate exists for.

**The grant travels in the pass's arguments, and that includes the execution token.** It has to: the control plane stores only `sha256(token)`, so the plaintext cannot be re-read, and a pass that could not present it could neither submit a Result nor report itself lost. The consequence is stated rather than hidden - the token is at rest in the World's storage for the life of the durable run, and the control plane's row still holds a digest only.

**Nothing in this repository dispatches automatically yet.** ADR 0016's Phase 0 scenario drives the claim endpoint itself and needs the Run left claimable, so wiring dispatch into the ingress spine would dispatch every Run before that scenario could reach one. `dispatchHostedPass` is the entry point that scenario ([#58](https://github.com/nick-neely/reprove/issues/58)) and the tests call.

### The injection point ADR 0016 pays for

`dispatchHostedPass` forwards `HostedDispatchOptions` unchanged, and that type carries the one test-only branch in shipped orchestration: `interruptBeforeRecordingPass`, called between `start()` and `markExecuting`. [ADR 0016](../../docs/adr/0016-phase-0-acceptance-scenario.md) records it as a known impurity accepted for one case, because the window it reaches - a pass genuinely running against a Run that records none - is the reason execution liveness covers the whole of Acceptance's eligibility window rather than `executing` alone. It is undefined by default, may only throw, and is set by no shipped module here; `pass.test.ts` asserts that by reading this package's own source.

### `lifecycleToken(runId, workflowRunId)`

A hook token is globally unique, and `start()` takes no idempotency key, so two lifecycles can exist for one Run. **A token derived from the Run id alone would therefore collide, and collide the wrong way round**: the orphan is created first, holds the token, and the lifecycle actually recorded on the Run is the one that dies. Carrying the lifecycle's own `workflowRunId` makes the two disjoint. The cost is that a notifier must read the recorded lifecycle from the database before it can resume anything, which is the right dependency direction anyway - the database decides which lifecycle owns a Run, so a notification must consult it, and an orphaned lifecycle is never notified because it was never recorded.

A `LifecycleSignal` carries a reason and nothing else. The lifecycle re-reads the Run rather than trusting the payload, so a notification is a wake-up rather than a mechanism: a hook resolves once, and after it has fired the loop waits on the deadline alone.

## `notifyLifecycle`: Acceptance decides, notification follows

`notifyLifecycle(ownerId, runId, reason)` reads the Run's currently recorded lifecycle, and resumes that lifecycle's hook under `lifecycleToken()`. It is called **after** the control plane has already committed the status - [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md): "the database write is what makes a Result accepted. Resuming the durable run is a notification that follows it." The same order holds for a supersession or a cancellation. Doing both inside the ingest request would re-enter the workflow runtime from a request that runtime is waiting on, which is why the resume lives here rather than in `@reprove/control-plane`.

**A notification that cannot be delivered is reported, not thrown.** A Run with no recorded lifecycle returns `no_recorded_lifecycle`; a `HookNotFoundError` or `WorkflowRunNotFoundError` returns `no_open_hook`, because the recorded lifecycle either has not reached its hook yet or has already ended. Any other error propagates. The lifecycle's deadline still bounds the Run, so a lost notification costs latency and never correctness - which is what lets `notifyEnded` call this from a step without turning a cosmetic failure into a failed workflow run.

## Tests

The tests run this package's workflows under a real Workflow builder: `@workflow/vitest` compiles every `'use workflow'` and `'use step'` function it discovers into bundles and executes them in-process against the local World. `spine.test.ts` is therefore measuring what [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) could only decide on paper - that a created Run reaches a claimable state through the real workflow runtime rather than a stub, that the `run` row arbitrates between two lifecycles, that the unclaimed window closes as `unscheduled` and nothing else, that a claimed Run nobody came back for ends `failed(worker_lost)` from the same durable run, that a hosted Run reaches Worker core and its Result reaches Acceptance, that the watchdog terminalizes before it cancels the pass and names what that pass did, and that the re-drive of a contended delivery is the platform's own step retry - with GitHub substituted at the transport and nowhere else.

The watchdog cases start a **stand-in** durable run rather than a hosted pass, and `pass.test-support.ts` says why: the shipped pass composes the Phase 0 fixture Worker core, so it submits a Result within milliseconds and terminalizes the Run, leaving nothing for a watchdog to close. A pass that has not answered yet is the ordinary shape in production and the impossible one for a fixture, and the watchdog reads exactly one thing about a pass - the status its durable run carries. The claim, the `markExecuting` write, the dispatch ordering and the injection point are all the real ones in those cases; only what `start()` starts is the test's. The steps compose their own control plane from `process.env` in a module registry the test file does not share, which is the builder-dependence this package exists for, exercised rather than assumed.

**They run from the package directory**, not from the root:

```text
pnpm --filter @reprove/control-plane-workflow run test
```

The root `pnpm verify:test` chains it after the root Vitest run, and the root config excludes this package. The reason is mechanical: the transform stamps a workflow's id from `process.cwd()` and the bundle stamps it from the project root, and the two agree only when those are the same place.

**They run against the local stack's maintenance database, `reprove`.** This package may depend on no Postgres driver ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)), so it cannot create a database of its own the way `@reprove/control-plane`'s tests do; it bootstraps and migrates the one `docker compose` created instead, and keeps every Run distinct by giving each case a repository id of its own. Rows accumulate there between runs, and `pnpm db:down` is what clears them. `pnpm db:up` brings the stack up; see [CONTRIBUTING.md](../../CONTRIBUTING.md#database).

`@workflow/vitest` is one builder, and the deployment uses another. The real-builder gate is what proves the same thing under Turbopack:

```text
node tools/verify-workflow-build.mjs        # root: pnpm verify:workflow
```

It builds `apps/control-plane` from clean, asserts the workflow bundle imports nothing but the workflow runtime, asserts the output trace carries what the steps need, then **starts the built application and drives a signed delivery through it** against a canned GitHub on loopback, ending at a queued Run recording a lifecycle that is running in the World ([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)). Absence fails: a missing artifact or trace is a failure rather than a note. It asserts no bundle size and no other property of today's output, because the SDK promises workflow-mode transformation and dead-code elimination, not one shared bundle or its externalization behaviour - the runtime execution is the check that survives a dependency upgrade.

### The `builtin-modules` root hoist

The repository hoists exactly one package to the root, **for `@workflow/vitest`'s step bundler rather than for any Reprove code**: under the strict layout the bundler cannot resolve `builtin-modules` from the project root, inlines it, and drops the import attribute Node requires, so every step fails to load. The full measurement, and the note that it is pinned to `workflow@4.8.5`, is in the `publicHoistPattern` comment in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) and is not restated here.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). Public source, gated by every CI check, carrying **no stability promise**.

The Workflow family is pinned rather than ranged for the same reason the real-builder gate exists: the build behaviour this seam depends on is undocumented and version-specific, so a version bump is a reviewed change that reruns the gate.
