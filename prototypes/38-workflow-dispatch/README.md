# Prototype: Workflow dispatch and hosted Worker composition

Throwaway. Answers [#38](https://github.com/nick-neely/reprove/issues/38):

> What exact seam lets `@reprove/control-plane` durably schedule a Worker-ready Run
> through Workflow while keeping all harness code outside the control-plane package,
> composing `@reprove/worker-hosted` only in the app, and preserving the same protocol
> contract a self-hosted Worker will later use?

## Run it

```bash
npm install
npm run boundary     # ADR 0010's dependency matrix, over the real package graph
npm run prototype    # 17 scenarios against a real Postgres and the real Workflow SDK
npm run world        # what Workflow's own Postgres world creates, and where
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

**1. `createControlPlane(config)` cannot configure a workflow step.** A `'use step'`
function is compiled into its own bundle with its own module instance. Probing three
`Math.random()` module ids in one run - caller, workflow bundle, step bundle - returned
three different values, and configuration the composition root set was `undefined` in
both bundles. So ADR 0010's

> "The package reads no environment variables. The app parses deployment-specific
> configuration and passes it explicitly to `createControlPlane(config)`."

is false for any package that owns workflow steps. What can hold is what the ADR was
actually protecting - no Reprove Cloud default anywhere, every value required with no
fallback - but the *mechanism* has to change. Anything a step needs arrives one of
exactly two ways: as a JSON step argument, or resolved by the step's own module graph
from the environment. `Phase0RunProfile` travels the first way; the GitHub port has to
travel the second, because a port is not JSON. `createControlPlane(config)` governs the
request path only, and the package needs a documented step-path environment contract.

**2. That forces the hosted path onto HTTP, which ADR 0006 had rejected.** ADR 0006 says
requiring hosted execution to reach Acceptance over an endpoint "was considered and
rejected: it would add a network failure mode purely for symmetry." But `worker-hosted`
may not import `@reprove/control-plane` (ADR 0010's matrix), and its steps cannot be
handed a client (finding 1). The only remaining shape is the one the long-running-jobs
research recommended for a different reason: the control plane mints a run-scoped ingest
URL and a lease-bound token, passes both as JSON workflow arguments, and the hosted
Worker POSTs its Result exactly as a self-hosted Worker will. It is not symmetry for its
own sake; it is the only composition the compiler permits. The consolation is real - one
ingest path, one schema, one idempotency story - and on Vercel it is a same-deployment
request rather than a public round trip.

**3. A Run has two durable runs, and conflating them cancels the wrong one.** The
lifecycle run is the Run's schedule; the hosted pass is one Worker's attempt at it.
Storing one `workflow_run_id` and cancelling it on supersession cancelled the schedule
and left the Worker running - the run then threw `WorkflowRunCancelledError` instead of
reporting `cancelled`. They need separate columns and opposite treatment: the schedule is
resumed through its cancel hook so it can terminate reportably, the pass is cancelled
outright.

**4. `start()` has no idempotency key.** A retried step that starts a workflow creates a
second durable run. The Reprove row has to be the arbiter: the first writer of
`run.workflow_run_id` wins under a conditional update and the loser cancels its own run.
Nothing in the ADRs anticipated that Workflow run creation is not idempotent while
Reprove's Run creation carefully is.

**5. A workflow module's import graph may not touch Node built-ins at all.** `node:crypto`
at the top level of a module a `'use workflow'` function imports fails the build with
"Node.js modules are not available in workflow functions". Step bodies are bundled
separately and may use Node freely. So inside `@reprove/control-plane`, the workflow
definitions and the step bodies have different import rules, and `pg` can only ever be
reached from the latter.

## What it settled

**The Phase 0 claimable deadline is 30 minutes**, carried in `Phase0RunProfile` and
written into immutable `spec` at creation as ADR 0013 requires. Long enough that a cold
hosted dispatch or a self-hosted Worker on a slow poll is not raced out; short enough
that "nobody could run this" is a fast visible answer rather than a silent hang. It is
profile policy, not protocol, so Phase 1 can move it without touching this seam.

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

## What it did not prove

- **Nothing about `world-postgres` executing.** Its schema was created and inspected, but
  the scenarios ran on `world-local`, which is what `@workflow/vitest` provides. Two facts
  read from the package rather than executed: it dispatches work by HTTP POST to
  `/.well-known/workflow/v1/{flow,step}` on a base URL it must discover, so the
  self-hosted control plane has to expose those routes and be reachable from its own
  worker process; and it uses graphile-worker, which can share the app's `pg.Pool`. ADR
  0010 records `world-postgres` as a dependency risk; this narrows the risk without
  retiring it.
- **Whether a lost race leaks a scheduled wake-up.** When the hook wins, the SDK logs
  `uncommitted operation(s): sleep`. On `world-local` that is cosmetic. On
  `world-postgres` a sleep is a graphile-worker job with a `runAt`, so a completed Run may
  leave a 30-minute job behind. Unmeasured.
- **Nothing about Vercel.** No deployment, no Function ceiling, no skew protection, no
  real Sandbox. Every step here is milliseconds.
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
