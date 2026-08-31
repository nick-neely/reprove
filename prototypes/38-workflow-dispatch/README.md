# Prototype: Workflow dispatch and hosted Worker composition

Throwaway. Answers [#38](https://github.com/nick-neely/reprove/issues/38):

> What exact seam lets `@reprove/control-plane` durably schedule a Worker-ready Run
> through Workflow while keeping all harness code outside the control-plane package,
> composing `@reprove/worker-hosted` only in the app, and preserving the same protocol
> contract a self-hosted Worker will later use?

## Run it

```bash
npm install
npm run boundary     # ADR 0010's dependency matrix AND resolved closure
npm run prototype    # 22 scenarios against a real Postgres and the real Workflow SDK
npm run world        # what Workflow's own Postgres world creates, and where
```

And the one that matters most, because it is the only path that exercises the
real builder rather than the test harness:

```bash
cd nextcheck && npm install && npm run build   # real Next.js 16.3 + withWorkflow
# then, with the world bootstrapped (see below):
npm run start & node seed.mjs && curl -X POST localhost:3838/api/probe ...
```

`npm run prototype` starts Postgres in Docker. The first run also needs the Reprove
database and the Workflow world schema:

```bash
docker compose up -d --wait
PGPASSWORD=world psql -h 127.0.0.1 -p 55438 -U world -d world -c 'create database reprove'
WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:55438/world" \
  node node_modules/@workflow/world-postgres/dist/cli.js bootstrap
```

## What is real and what is a stand-in

Real: `workflow@4.8.5` and `@workflow/vitest@4.0.21` (the SDK's own in-process runner,
which does the real SWC transform and the real bundle split), `@workflow/world-postgres@4.3.5`,
Postgres 17, a real HTTP ingest server, a real package graph with a real dependency matrix
check, and the real `Promise.race` / `createHook` / `sleep` / `resumeHook` / `cancel` API.

Stand-ins: `worker-core` returns fixture outcomes instead of running a Harness (#35 owns
that seam). Persistence is a thin slice of ADR 0008 - `withOwner` and owner-scoped tables,
without the runtime-role split, `FORCE ROW LEVEL SECURITY` or the seven-check boot
assertion, because [#37](https://github.com/nick-neely/reprove/issues/37) already proved
those and reproducing them here would test #37 again. GitHub is a fixture file.

Vitest is the harness, not a test suite: it is the only documented way to drive workflows
in-process, and the SDK ships the plugin for exactly that. The output is a ledger.

## The seam

```
GitHub delivery
  -> receiveDelivery()            commit a bounded envelope, then 2xx
  -> start(ingressDelivery, [deliveryId, ownerId, profile])
       step processDelivery       advisory lock, canonical fetch, create the Run
                                  RetryableError on contended/transient == the re-drive
       step dispatchRun           start(runLifecycle); the Reprove row arbitrates
       step closeLedger
  -> runLifecycle                 the Run's durable schedule
       race( accepted hook | cancelled hook | sleep(claimableUntil) )

app: dispatchHosted()
  -> claimRun()                   the control plane claims on the hosted Worker's behalf
  -> hosted.dispatch(spec, ingest)
  -> start(hostedPass, [spec, ingest, fault])
       step executeStep           @reprove/worker-core
       step submitStep            POST ingest.resultUrl
  -> POST /v1/runs/:id/result -> acceptResult() -> respond -> notifyLifecycle()
```

Three properties hold in the ledger:

- `@reprove/control-plane` reaches neither `worker-core`, `worker-hosted` nor `@ai-sdk/*`,
  in declared dependencies or in the import graph.
- The self-hosted composition omits `worker-hosted` entirely, and the same code path
  leaves the Run `queued` and claimable rather than failing.
- The hosted Worker reaches Acceptance over the same authenticated route a self-hosted
  Worker will, with the same envelope.

## What it falsified

**1. A composition-root singleton does not reach a workflow step - but how far
that goes is builder-dependent.** Under `@workflow/vitest` (esbuild, prebuilt
step bundles), probing three `Math.random()` module ids in one run - caller,
workflow bundle, step bundle - returned three different values, and
configuration the composition root set was `undefined` in both bundles. Under
the real Next.js/Turbopack build, a `await import()` inside a step body resolves
through Node's own module registry and the step sees the *same* instance as the
route handler: measured identical (`caller` and `inStep` both `76zwaztw` in
`npm run nextcheck`).

So the honest claim is narrow: **a package that owns workflow steps cannot rely
on being configured by its caller, and equally cannot be said to require the
environment.** It needs a documented fallback that a deployment can satisfy
either way. An earlier draft of this prototype concluded that ADR 0010's "the
package reads no environment variables" was false; that was too strong, and an
adversarial review caught it. The rule survives.

**2. The HTTP hosted path is one composition, not the only one.** An earlier
draft argued that because `worker-hosted` may not import `@reprove/control-plane`
and steps cannot be injected, a run-scoped ingest URL over HTTP was the only
shape left, and that ADR 0006's rejection of it therefore had to be reversed.
That exhaustiveness claim was false and is retracted.

`apps/control-plane-appowned/` is the counterexample, and it runs in the ledger:
ADR 0010's matrix already permits an app to depend on *both* packages, so an
app-owned step imports `executePass` and `acceptResult` statically, in one
bundle, with no HTTP, no ingest token, and no environment access inside the core
package. Acceptance still runs control-plane-side and is still the only path that
absorbs a Result; only the transport changed.

**ADR 0006 does not have to be reversed.** What does follow is smaller and still
real: ADR 0010 assigns "the hosted Workflow orchestration seam" to
`@reprove/control-plane`, and the *workflow and step definitions* have to sit
where they can statically reach their configuration - the app, or an app-owned
adapter - while the substance stays in the packages.

**3. A Run has two durable runs, and conflating them cancels the wrong one.** The
lifecycle run is the Run's schedule; the hosted pass is one Worker's attempt at it.
Storing one `workflow_run_id` and cancelling it on supersession cancelled the schedule
and left the Worker running - the run then threw `WorkflowRunCancelledError` instead of
reporting `cancelled`. They need separate columns and opposite treatment: the schedule is
resumed through its cancel hook so it can terminate reportably, the pass is cancelled
outright.

**4. `start()` has no idempotency key, and the arbitration window cannot be
closed.** A retried step that starts a workflow creates a second durable run, and
`StartOptions` offers neither an idempotency key nor a caller-supplied run id, so
the id cannot be written before the run exists. A crash *between* `start()` and
the conditional write therefore orphans a durable run that no conditional update
can find or cancel - which an adversarial review pointed out and the first draft
had not exercised.

The answer is not to prevent the orphan but to make it **inert**. Every write
`runLifecycle` performs is now conditional on `workflow_run_id` matching its own
`getWorkflowMetadata().workflowRunId`, which an orphan never became. Scenario K
starts an unrecorded lifecycle, drives it to its deadline, and asserts the Run is
untouched: still `queued`, `failure_reason` null, owned by the other run. The
orphan wakes, matches nothing, and ends.

**5. The workflow bundle inlines everything reachable from a workflow and
externalizes nothing, and every workflow in an app shares one bundle.** This is
the finding the real build path produced and the vitest harness had hidden.

- A `'use workflow'` module's transitive *static* import graph is compiled into
  one shared workflow bundle that runs in a VM with no `require`. A single
  static `import { withOwner } from '../db.ts'` pulls all of `pg` - CommonJS -
  into it, and the run dies with `ReferenceError: require is not defined`.
- Importing from a package **barrel** is enough to do it: `acceptResult` from
  `@proto38/control-plane` dragged the barrel's own `node:crypto` in. Packages
  consumed from workflow code need fine-grained subpath exports.
- Because all workflows share one bundle, one workflow's bad import breaks
  *every other workflow in the app*, with an error naming the innocent one.
- `serverExternalPackages` does not help: the workflow bundle deliberately
  externalizes nothing.
- The escape is a **dynamic `await import()` inside the step body**. Applying it
  to `run-lifecycle.ts` and `ingress-delivery.ts` took the generated flow bundle
  from 706KB with all of `pg` inlined to a small file containing only the three
  workflow modules, and the run then completed.
- esbuild (vitest) fails this at *build* time with a clear message; Turbopack
  fails at *runtime* with a confusing one. Only the real build path shows it.

## What it settled

**The Phase 0 claimable deadline is 30 minutes**, carried in `Phase0RunProfile` and
written into immutable `spec` at creation as ADR 0013 requires. Long enough that a cold
hosted dispatch or a self-hosted Worker on a slow poll is not raced out; short enough
that "nobody could run this" is a fast visible answer rather than a silent hang. It is
profile policy, not protocol, so Phase 1 can move it without touching this seam.

**The deadline means two different things, and conflating them lies about the
Run.** ADR 0007 defines `unscheduled` as "never dispatched" and `CONTEXT.md`
reserves Failure for a Run that began executing. The first draft wrote
`unscheduled` over `status in ('queued','claimed','executing')`, which states
that nothing ran about a Run that ran. Corrected: the deadline writes
`unscheduled` only over `queued`/`claimed`, and an `executing` Run whose deadline
expires is ADR 0006's `worker_lost` Failure.

**A hosted Failure is signalled, and the control plane decides.** `reportHostedFailure()`
is a conditional UPDATE using the same eligibility window Acceptance uses, so a
Failure reported for a Run that is terminal, superseded, or under a different
lease changes nothing. It absorbs no Result, so Acceptance remains the only path
by which a Result enters a Run, and it is not a protocol v1 message - #35's
verdict stands. "Hosted-only" is structural rather than policy: it is reachable
by static import from an app that composes `worker-hosted`, and no endpoint
exposes it, so a self-hosted Worker has no way to call it.

**The re-drive is Workflow's step retry**, not a Reprove sweeper. `contended` and
`transient` throw `RetryableError` from inside the ingress step; the platform's backoff
is the mechanism, which is why no second job system appears beside the one #6 settled.
`unauthorized` throws `FatalError` and stops.

**Acceptance is one conditional UPDATE.** The eligibility window and the write are the
same statement, so a Worker returning from a partition loses the race by construction
rather than by cooperating with a cancel. It names its rejections - `oversized`,
`upgrade_required`, `malformed`, `unknown_run`, `wrong_tenant`, `stale_lease`,
`not_eligible` - because "rejected" cannot distinguish a superseded Run from a forged
tenant. Compatibility is checked before the payload is parsed.

**Acceptance and the hook are separate.** The database write is what makes a Result
accepted; resuming the durable run is a notification that follows the response. Doing
both inside the request re-enters the workflow runtime from a request it is waiting on,
which deadlocked this prototype until it was split.

**Workflow's storage really is opaque.** `npm run world` shows every table in
`workflow`, `workflow_drizzle` and `graphile_worker`, and nothing in `public`. ADR 0010's
claim holds - with a caveat for #37: the boot assertion's "every table is classified"
must be scoped to Reprove's own schema, not to the database, or sharing a server with
Workflow would refuse boot.

**`world-postgres` executes, and the self-hosted topology works.** `npm run nextcheck`
builds a real Next.js 16.3 app with `withWorkflow`, points it at
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, and runs a Run end to end: the
postgres world dispatches over HTTP to the `/.well-known/workflow/v1/{flow,step}`
routes Next generates, the step executes worker-core, Acceptance absorbs the
Result, and the Reprove row lands `completed` with `accepted_at` set. ADR 0010
recorded `world-postgres` as a dependency risk; it is now a measured one.

**A `'use workflow'` function defined inside a package compiles under the real
builder**, not only under the vitest plugin: the build reports 3 workflows
discovered, including `runLifecycle` and `hostedPass` from the packages, and the
route imports `runLifecycle` from the package and gets a function.

## What it did not prove
- **Whether a lost race leaks a scheduled wake-up.** When the hook wins, the SDK logs
  `uncommitted operation(s): sleep`. On `world-local` that is cosmetic. On
  `world-postgres` a sleep is a graphile-worker job with a `runAt`, so a completed Run may
  leave a 30-minute job behind. Unmeasured.
- **Nothing about Vercel.** No deployment, no Function ceiling, no skew protection, no
  real Sandbox. Every step here is milliseconds, and `world-vercel` was never used.
- **Whether the app-owned composition scales past one Pass.** It runs one
  execute-then-absorb pair. A real Pass is many steps around a long-lived Sandbox.
- **Nothing about a real self-hosted Worker.** The HTTP contract exists and the hosted
  Worker uses it; no enrollment, credential, lease renewal or progress message does,
  because #32 kept them out of v1.

## Open questions this hands on

1. **A Failure has no terminal transition.** When worker-core returns an internal Failure,
   nothing is submitted - correctly, since v1 has no wire form for it (#35) - and the Run
   sits in `executing` until the claimable deadline fires. That is the one deliberate
   `[BAD]` in the ledger. A hosted Failure is known to Reprove's own infrastructure the
   moment it happens, so discovering it by timeout is a choice, not a constraint. The
   hosted pass could write the Run's failure directly, at the cost of a second writer of
   terminal state; or v1 could gain a Failure report, at the cost of reopening #35's
   verdict. Neither is obviously right.
2. **What resolves a lifecycle whose hosted pass died.** `worker_lost` has no detector
   here. The deadline covers it, slowly.

## What changed after adversarial review

The first version of this prototype reached two conclusions it had not earned,
and shipped two defects. An adversarial review caught all four; the revisions are
above and in the ledger. Recorded here because the *pattern* matters more than
the individual errors:

1. **Two exhaustiveness claims** ("the only remaining composition", "must come
   from the environment") rested on having tested one design that worked, not on
   having eliminated the alternatives. Both were false, and the counterexample -
   an app-owned workflow - was cheap to build once someone asked for it.
2. **A ledger line that proved a runtime flag while claiming a dependency-graph
   property.** The old "self-hosted composition" app still declared and imported
   `worker-hosted` and merely skipped calling it. ADR 0010's claim is about what
   `pnpm why` shows, so the check now walks the resolved closure and the
   self-hosted deployment is a genuinely separate package.
3. **A status transition that contradicted `CONTEXT.md`** - `unscheduled` written
   over an `executing` Run.
4. **An unexercised crash window** in the `start()` arbitration.

The general lesson for the next prototype: a scenario that passes proves the
design *works*, never that it is *necessary*, and a ledger line is only as strong
as the property it actually measures.
