# Vercel Workflow SDK: what the build actually does to your code

Research for [#38](https://github.com/nick-neely/reprove/issues/38) (child of
[#28](https://github.com/nick-neely/reprove/issues/28)).
Measured: **2026-08-31**, against `workflow@4.8.5`, `@workflow/vitest@4.0.21`,
`@workflow/world-postgres@4.3.5`, Next.js 16.3.3 with Turbopack, Node 24.

Every claim below is tagged **MEASURED** (reproduced in
[`prototypes/38-workflow-dispatch/`](https://github.com/nick-neely/reprove/tree/prototype/38-workflow-dispatch),
with the command that shows it), **READ** (from the installed package source, not executed),
or **UNVERIFIED**. Nothing here is inferred from documentation alone: several of these
behaviours are undocumented, and two of them contradict what a reasonable reading of the
docs would suggest.

These are facts about a dependency, not decisions Reprove made. The decisions they forced
are in ADR 0014.

---

## TL;DR

- A `'use workflow'` function's bundle inlines **everything the workflow function body
  reaches**, module-scope helpers included, and **excludes step bodies**. It externalizes
  nothing.
- All workflows in an app share **one** bundle, so one bad import breaks every workflow,
  with an error naming an innocent one.
- That bundle runs in a VM with **no `require`**, so any CommonJS package or Node built-in
  reaching it is a runtime `ReferenceError`. The build stays green.
- Step bodies may import CommonJS and Node built-ins freely, statically.
- Whether a step shares a module instance with its caller is **builder-dependent**.
- `start()` has no idempotency key and no caller-supplied run id.
- Hook tokens are **globally unique**; a second run claiming a held token gets
  `HookConflictError`.
- `@workflow/world-postgres` executes work by HTTP POST back into your own app, and creates
  its tables in three schemas of its own, never `public`.

---

## 1. What lands in the workflow bundle

**MEASURED.** The rule is narrower than it first appears, and getting it wrong costs real
work: an earlier draft of this research stated it as "everything reachable from the module",
which is false and led to a page of unnecessary dynamic imports.

| What | In the workflow bundle? |
| --- | --- |
| Module-scope helper called from the workflow body | **Yes**, with its whole transitive graph |
| A `'use step'` function's body | No |
| A module imported only for use inside a step body | No |
| Anything imported only for types | No |

Reproduction, in `prototypes/38-workflow-dispatch/nextcheck`: adding one module-scope helper
called from a workflow body, whose graph reaches `@proto38/control-plane`, moved the emitted
`app/.well-known/workflow/v1/flow/route.js` from **99KB to 1172KB**, inlined `pg`,
`node:crypto` and eight further Node built-ins, and made every workflow in the app fail. A
static `import { withOwner } from '@proto38/control-plane/db'` used *only inside step bodies*
leaves the bundle at 99KB.

**Barrel imports are the usual way this happens.** Importing one function from a package's
index pulls the index's own top-level imports along with it. `@reprove/control-plane`'s
barrel imports `node:crypto`; importing `acceptResult` from it, rather than from
`@reprove/control-plane/acceptance`, was enough to poison the bundle. **Packages consumed
from workflow-adjacent code need fine-grained subpath exports.**

### The bundle is shared across all workflows

**MEASURED.** One `flow/route.js` holds every workflow in the app. A module-level `require`
executes when the bundle loads, so a defect introduced by workflow A surfaces as a failure
in workflow B - whichever runs first. The stack trace names B.

### `serverExternalPackages` does not help

**MEASURED.** Adding `pg` to `serverExternalPackages` changed nothing. **READ:**
`@workflow/builders`' step bundler passes `external: [...config.externalPackages]`, but the
workflow bundler carries the comment "We intentionally do NOT use the external option here
for workflow bundles."

### The two builders disagree about when this fails

**MEASURED.** esbuild (via `@workflow/vitest`) fails at **build** time with
`You are attempting to use "node:crypto" which is a Node.js module... Move this function
into a step function.` Turbopack (via `next build`) emits `require("node:crypto")` and fails
at **runtime** with `ReferenceError: require is not defined`. Local testing on the vitest
path can therefore be clean while production breaks.

---

## 2. Module identity across the step boundary

**MEASURED**, as a full 2x2, because measuring only the diagonal is how an earlier draft
reached a confounded conclusion.

| | caller vs step | static vs dynamic import |
| --- | --- | --- |
| `@workflow/vitest` | **different** instances | identical to each other |
| Next.js / Turbopack | **same** instance; a value set by the caller is visible | identical to each other |

The axis is the builder, not the import style. Under vitest the step runs from a pre-built
bundle with its own module registry; under Turbopack a step resolves through Node's registry
and shares the route handler's instance.

**Consequence:** a package that owns steps can neither rely on being configured by its caller
nor be said to require the environment. It must resolve its own configuration.

---

## 3. Run creation, hooks and cancellation

**`start()` has no idempotency key and no caller-supplied run id.** **READ** -
`StartOptionsBase` exposes only `world` and `specVersion`. So the window between starting a
durable run and recording its id cannot be closed, and a crash inside it orphans a run that
no conditional update can find. **MEASURED:** the orphan can be made inert instead, by making
every write conditional on `getWorkflowMetadata().workflowRunId`.

**Hook tokens are globally unique.** **MEASURED** - a second run creating a hook with a held
token receives `HookConflictError`. A token derived from a domain id therefore collides
exactly in the orphan window above, and collides the wrong way round: the orphan starts
first, takes the token, and the run that is actually recorded is the one that dies.

**`Promise.race` over a hook and a `sleep` works**, on every branch, and is the SDK's own
documented pattern. **MEASURED.** The losing branch logs
`uncommitted operation(s): sleep`. On `world-local` that is cosmetic. **UNVERIFIED:** whether
on `world-postgres`, where a sleep is a graphile-worker job with a `runAt`, a completed run
leaves a scheduled wake-up behind.

**`getRun(id).cancel()` exists and works.** **MEASURED.** Note the SDK's own bundled skill
documentation says runs "cannot be cancelled directly via a method" and directs you to create
a `run_cancelled` event; that is stale for 4.8.5.

---

## 4. `@workflow/world-postgres`

**It executes work by HTTP POST back into your own app.** **MEASURED and READ.** The queue
resolves a base URL (`WORKFLOW_LOCAL_BASE_URL`, the port, or a health probe) and POSTs to
`/.well-known/workflow/v1/flow` and `/step`. So a self-hosted control plane must expose those
routes and be reachable from its own worker process. Next generates them; `createWorkflowUrl`
appends the route base, so the environment variable must be the **origin only**.

**It uses graphile-worker, and can share the app's `pg.Pool`.** **READ.**

**Its schema layout, verified on Postgres 17:** **MEASURED** via `npm run world`.

```
graphile_worker._private_jobs, .jobs, .migrations, ...
workflow.workflow_runs, .workflow_events, .workflow_steps,
         .workflow_hooks, .workflow_stream_chunks, .workflow_waits
workflow_drizzle.workflow_migrations
public: (nothing)
```

Three schemas of its own; nothing in `public`. ADR 0010's "Workflow's storage stays opaque"
therefore holds - **provided** ADR 0008's boot assertion is scoped to the tables Reprove's own
migration manifest manages, rather than to every table in the database. Scoped to the
database, a deployment sharing a Postgres server with Workflow refuses to boot. ADR 0008 is
corrected accordingly.

**UNVERIFIED:** this was measured against local Postgres 17, not Neon. The schemas come from
the package's own migrations so they should be identical, but that is inference.

---

## 5. What was not measured

- **Anything on Vercel.** No deployment, no `world-vercel`, no Function ceiling, no skew
  protection. The output trace was inspected; a trace is not a deploy.
- **A real Pass**: many short steps around a long-lived Sandbox using detach/resume.
- **Whether these behaviours are stable across SDK versions.** None of section 1 is
  documented, so none of it is contractual. That is the argument for the CI gate in ADR 0014
  asserting observable execution rather than artifact shape.

---

## Sources

Measured in `prototypes/38-workflow-dispatch/` on branch `prototype/38-workflow-dispatch`:
`npm run prototype`, `npm run boundary`, `npm run world`, and `cd nextcheck && npm run gate`.

Package source read at the pinned versions: `@workflow/builders/dist/base-builder.js`,
`@workflow/core/dist/runtime/start.d.ts`, `@workflow/core/dist/workflow/hook.js`,
`@workflow/world-postgres/dist/queue.js`, `@workflow/world-postgres/README.md`.

SDK documentation: <https://useworkflow.dev>, <https://workflow-sdk.dev/docs/foundations/hooks>,
<https://vercel.com/docs/workflows>.
