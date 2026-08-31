# Prototype: Workflow dispatch and hosted Worker composition

Throwaway. Answers [#38](https://github.com/nick-neely/reprove/issues/38):

> What exact seam lets `@reprove/control-plane` durably schedule a Worker-ready Run
> through Workflow while keeping all harness code outside the control-plane package,
> composing `@reprove/worker-hosted` only in the app, and preserving the same protocol
> contract a self-hosted Worker will later use?

**This document has been rewritten twice after adversarial review.** Two rounds found
four unearned conclusions and five defects between them. What survives is below; what
did not is recorded at the end, because the pattern of error matters more than any
individual finding.

## Run it

```bash
npm install
npm run boundary     # ADR 0010's matrix, plus the resolved dependency closure
npm run prototype    # 13 scenarios against a real Postgres and the real Workflow SDK
npm run world        # what Workflow's own Postgres world creates, and where

cd nextcheck && npm install
npm run gate         # the real Next.js build, then the workflow-bundle smoke gate
```

`npm run prototype` needs Docker and configures itself; it requires no undocumented
environment variable. The first run also needs the Reprove database and the Workflow
world schema:

```bash
docker compose up -d --wait
PGPASSWORD=world psql -h 127.0.0.1 -p 55438 -U world -d world -c 'create database reprove'
WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:55438/world" \
  node node_modules/@workflow/world-postgres/dist/cli.js bootstrap
```

## What is real and what is a stand-in

Real: `workflow@4.8.5` under **both** builders - `@workflow/vitest` for the scenarios and
a real Next.js 16.3 app with `withWorkflow` in `nextcheck/` - plus
`@workflow/world-postgres`, Postgres 17, a real package graph with a matrix and closure
check, and the real `createHook` / `sleep` / `resumeHook` / `cancel` / `getWorkflowMetadata`
API.

Stand-ins: `worker-core` returns fixture outcomes instead of running a Harness (#35 owns
that seam). Persistence is a thin slice of ADR 0008 - `withOwner` and owner-scoped tables,
without the runtime-role split, `FORCE ROW LEVEL SECURITY` or the boot assertion, because
[#37](https://github.com/nick-neely/reprove/issues/37) proved those. GitHub is a fixture file.

## The layering

```
@proto38/protocol           zod wire contract
@proto38/worker-core        Adapter + Sandbox stand-in; carries @ai-sdk/*
@proto38/worker-hosted      hosted lifecycle; re-exports the Pass
@proto38/control-plane      SUBSTANCE ONLY. Ingress, Run creation, claim,
                            Acceptance, supersession. No `workflow` dependency,
                            no workflow or step definitions, no environment.
                            Resolved closure: protocol, pg, zod.
@proto38/workflow-adapter   ALL durable orchestration and ALL step configuration.
                            App-layer. Depends on control-plane + workflow.
                            Carries no harness code.
apps/control-plane-hosted     control-plane + adapter + worker-hosted
apps/control-plane-selfhosted control-plane + adapter. No harness code at all.
```

That split is the answer to the ticket, and it is forced rather than chosen: a step is
compiled into a bundle whose module graph is fixed at build time, so the layer that
defines steps is the only layer that can reliably configure them. Keeping the definitions
in the core package would have meant the core package reading the environment.

```
GitHub delivery
  -> receiveDelivery()        commit a bounded envelope, then 2xx
  -> startDelivery()          adapter: start(ingressDelivery, [id, owner, profile])
       step processDelivery   advisory lock, canonical fetch, create the Run
                              RetryableError on contended/transient == the re-drive
       step dispatchRun       start(runLifecycle); the Reprove row arbitrates
       step closeLedger
  -> runLifecycle             the Run's durable schedule
       race( accepted hook | cancelled hook | sleep(claimableUntil) )

app: dispatchHosted()
  -> claimRun()               the control plane claims on the Worker's behalf
  -> start(hostedRun, ...)    an APP-OWNED workflow
       step passStep          @proto38/worker-hosted -> worker-core
       step absorbStep        acceptResult(), then notifyAccepted()
```

Three properties hold in the ledger and the boundary check:

- `@proto38/control-plane` resolves neither harness code nor `workflow`.
- The self-hosted deployment resolves no harness code **in its dependency closure**, not
  merely at runtime, and the same code path leaves the Run `queued` and claimable.
- Acceptance is control-plane-side and is the only path by which a Result enters a Run.

## What it settled

**The workflow bundle inlines what the WORKFLOW FUNCTION BODY reaches, and excludes step
bodies.** This is the load-bearing build fact, and it is narrower than an earlier draft
claimed. A module-scope helper called from the workflow body drags its whole transitive
graph in; a step body may import `pg` statically and freely. Measured in `nextcheck`:
adding one helper call took the emitted flow bundle from **103KB to 1176KB**, inlined
`pg`, `node:crypto` and eight Node built-ins, and broke every workflow in the app - while
the build stayed green. `npm run gate` catches exactly this, and was verified against that
deliberate regression rather than only against a passing tree.

**Module identity is builder-dependent, with the axes separated.** An earlier draft
compared a static import under one builder against a dynamic import under the other, which
confounded the two. The full 2x2:

| | caller vs step | static vs dynamic |
| --- | --- | --- |
| `@workflow/vitest` | different instances | identical to each other |
| Next.js / Turbopack | **same** instance, injected value visible | identical to each other |

So the axis is the builder, not the import style. A package that owns steps therefore
cannot rely on being configured by its caller *and* cannot assume it must read the
environment. `@proto38/workflow-adapter` resolves its own configuration at the top of
every step, which is correct under both.

**Hook tokens are scoped to the lifecycle, not the Run.** The SDK enforces globally unique
tokens: a second run claiming a held token gets `HookConflictError`. A Run-scoped token
therefore breaks precisely in the `start()` orphan window, and breaks the wrong way round -
the orphan starts first and holds the token, so the lifecycle actually recorded on the Run
is the one that dies. Tokens now carry `workflowRunId`, and a notifier reads the currently
recorded lifecycle from the database before resuming it. That is the correct dependency
direction: the database decides which lifecycle owns the Run.

**`claimableUntil` bounds the unclaimed window and nothing else.** ADR 0007 defines
`unscheduled` as "never dispatched" and ADR 0006 gives an executing Run's liveness to the
Lease. The deadline now writes one transition, over a `queued` Run, and only when this
lifecycle is the recorded one. An executing Run at its deadline is deliberately left alone.

**The re-drive is Workflow's step retry**, not a Reprove sweeper: `contended` and
`transient` throw `RetryableError` inside the ingress step, so no second job system appears
beside the one #6 settled. `unauthorized` throws `FatalError`.

**Acceptance is one conditional UPDATE** whose eligibility window and write are the same
statement, so a Worker returning from a partition loses by construction rather than by
cooperating. It names its rejections - `oversized`, `upgrade_required`, `malformed`,
`unknown_run`, `wrong_tenant`, `stale_lease`, `not_eligible` - and checks compatibility
before parsing the payload. It no longer resumes anything: notification follows the write,
in the adapter, which is also what stopped an earlier deadlock.

**`start()` cannot be made idempotent**, so the orphan is made inert: every lifecycle write
is conditional on `workflow_run_id` matching its own `getWorkflowMetadata().workflowRunId`.
Scenario F proves both halves - the orphan writes nothing, **and** the recorded lifecycle
survives it and still carries the Run to `completed`.

**Workflow's storage is opaque**: every table in `workflow`, `workflow_drizzle` and
`graphile_worker`, nothing in `public`. With a caveat for #37: the boot assertion's "every
table is classified" must be scoped to Reprove's own schema, or sharing a server with
Workflow refuses boot.

**The Phase 0 claimable deadline is 30 minutes**, provisional, and now scoped to the
unclaimed scheduling window alone.

## What it did not prove

- **Nothing about Vercel.** No deployment, no `world-vercel`, no Function ceiling, no skew
  protection, no real Sandbox. Every step here is milliseconds. The output trace is
  checked, but a trace is not a deploy.
- **Nothing about a real Pass.** One execute-then-absorb pair. A real Pass is many short
  steps around a long-lived Sandbox using detach/resume.
- **Nothing about a real self-hosted Worker.** No enrollment, credential, lease renewal or
  progress message exists, because #32 kept them out of v1.
- **Lease expiry.** Nothing ends an executing Run whose Worker vanished. The deadline no
  longer pretends to. This is the one deliberate `[BAD]` in the ledger and it needs a
  ticket of its own.
- **`reportHostedFailure` is unexposed in this composition, not structurally hosted-only.**
  It is an exported function; any composition could expose it. Making the property real
  needs a private adapter surface.
- **The closure walker is not `pnpm why`.** It walks declared dependencies recursively; it
  does not read the installed tree.
- **Whether a lost race leaks a scheduled wake-up.** On `world-postgres` a sleep is a
  graphile-worker job with a `runAt`. Unmeasured.

## What two rounds of adversarial review corrected

Recorded because the pattern is more useful than the list.

**Round 1** retracted "HTTP is the only remaining composition" and "step config must come
from the environment", and found two defects: a ledger line that measured a runtime flag
while claiming a dependency-graph property, and an unexercised crash window.

**Round 2** found three blocking defects: Scenario K was a false positive (it never awaited
the recorded lifecycle, which was in fact dying of `HookConflictError`); ADR 0010's
no-environment rule did not actually survive, because a `PROTO38_REPROVE_URL` fallback had
been left in the core package while the claim said otherwise; and `claimableUntil` still
owned a transition belonging to the Lease. It also correctly called
"structurally hosted-only" an overclaim, called the module-identity conclusion confounded,
and pointed out the output trace was fine.

Three failure modes recur:

1. **A passing scenario proves the design works, never that it is necessary.** Both
   retracted claims were exhaustiveness claims backed by one working example.
2. **A ledger line is only as strong as the property it measures.** "Self-hosted composes
   no dispatcher" and "the orphan wrote nothing" were both true and both beside the point.
3. **Claiming two things that contradict each other.** Keeping an environment fallback
   *and* saying the no-environment rule survives is the clearest instance.

A fourth, from this round: **a finding stated too broadly costs real work.** "The workflow
bundle inlines everything reachable" was wrong, and the dynamic imports written to work
around it were unnecessary. Narrowing it to the workflow function body removed them.
