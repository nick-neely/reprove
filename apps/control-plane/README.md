# `@reprove/control-plane-app`

The thin Next.js composition shell for the control plane. It is **a deployable application, not a package** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)): a self-hoster deploys it, and nobody writes code against it.

It owns route wiring and deployment configuration, and nothing else. Even the environment is read elsewhere: [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) gives all step configuration to `@reprove/control-plane-workflow`, because a step compiles into a bundle whose module graph is fixed at build time and so cannot be configured by the route that composed the deployment. Control-plane substance lives in `@reprove/control-plane`, and every workflow and step definition in `@reprove/control-plane-workflow`. The dependency matrix in `tools/verify-workspace.mjs` enforces that: this app cannot import a Postgres driver, Octokit or Better Auth, so it cannot accumulate control-plane logic.

## Routes

| Route | What it is |
|---|---|
| `POST /api/github/webhook` | The App's single hook URL. Wiring only; the handler, the signature check, the envelope and the commit are all `@reprove/control-plane`, and the composition over the environment is `@reprove/control-plane-workflow`. |
| `/.well-known/workflow/v1/*` | Generated, not written here. `withWorkflow` emits the `flow`, `step` and `webhook/[token]` routes the World drives a durable run through ([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)). |

## Environment

Reprove's own configuration is read in one place, and it is not this app:
[ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) puts all step configuration in
`@reprove/control-plane-workflow`, whose `ENVIRONMENT` names every variable below, and
`@reprove/control-plane`'s library code reads none - only its operator CLI does. A deployment sets:

| Variable | What it is |
|---|---|
| `REPROVE_DATABASE_URL` | The **pooled** endpoint, as the restricted runtime role. |
| `REPROVE_GITHUB_WEBHOOK_SECRET` | The webhook secret the App was registered with. |
| `REPROVE_GITHUB_APP_ID` | GitHub's numeric App id, which is the App JWT's issuer. |
| `REPROVE_GITHUB_PRIVATE_KEY` | The App's PEM private key, with `\n` accepted as the escaped form so one value works in a `.env` file and in a secret store alike. |
| `REPROVE_GITHUB_API_URL` | Optional. GitHub's REST root, for a GitHub Enterprise Server deployment or a build gate standing a canned GitHub up on loopback. Unset means `https://api.github.com`. It must be `https:`, or `http:` on loopback: every request under it carries an App credential, so a cleartext root off the machine is refused at boot rather than sent a token. |

The App id and the private key are what
[ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s canonical fetch
runs under: App JWT, then installation token, then `GET /repos/{owner}/{repo}/pulls/{number}`.

Three more are the Workflow SDK's own rather than Reprove's, and the SDK reads them directly:
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres` chooses the durable World,
`WORKFLOW_POSTGRES_URL` is where that World keeps it, and `WORKFLOW_LOCAL_BASE_URL` names this
app's origin so the World's queue can reach the generated routes above. Left unset, the SDK runs
the local file-backed World under `.next/workflow-data`, which is a development convenience and
not something a deployment should run on.

**The World's schema is bootstrapped, not migrated on first use.** `@workflow/world-postgres`
ships a `bootstrap` bin that creates the `workflow`, `workflow_drizzle` and `graphile_worker`
schemas, and it has to be run against `WORKFLOW_POSTGRES_URL`'s database before the app first
starts. Those schemas are Workflow's, not Reprove's:
[ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)'s boot assertion covers only
the tables Reprove's own migration manifest manages and excludes them deliberately. In Phase 0 the
build gate points the bin at the **admin** connection, which is the same separation
`reprove-control-plane migrate` observes.

The Run profile is passed by name and is **not** an environment variable. `PHASE_0_RUN_PROFILE` is
imported from `@reprove/control-plane` and handed to `createControlPlane()`, because ADR 0013
created it precisely so that a harness or a model chosen in composition cannot become product
selection policy by accident.

Three things about this composition are deliberate and would otherwise read as accidents.

**The control plane is composed once per process, not per request.** `createControlPlane()` opens a
connection pool and runs [ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md) rule
6's seven tenancy assertions, and repeating that per delivery would spend GitHub's ten-second wall
on work whose answer cannot change between two requests. A composition that throws is **not**
memoized as a failure: a boot refusal is usually a deployment being repaired, and until it succeeds
every delivery gets a non-2xx, which is the answer
[ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md) wants - the delivery
stays manually redeliverable rather than being acknowledged by a process that cannot store it.

**`@reprove/control-plane` is bundled, and its `drizzle/` folder ships beside the deployment
rather than beside the bundle.** [ADR 0017](../../docs/adr/0017-authoring-time-tenancy-boundary.md)
makes that folder a runtime asset - the boot assertion joins the hashes Drizzle stored against the
committed files that produced them - and the package resolves it by joining a relative path over
`import.meta.url`. That survives bundling: Turbopack rewrites `import.meta.url` to the original
module's path, so the join still lands on `packages/control-plane/drizzle` and the folder is named
in `outputFileTracingIncludes` for every route that composes the control plane. File tracing
follows imports and cannot see a `readFileSync`, so naming it is the only way it ships. The
`new URL("../../drizzle", import.meta.url)` form this replaced does **not** survive: a bundler
reads it as an asset reference and fails the build on a folder it cannot emit.

`pg` is the one dependency held out, through `serverExternalPackages`. It probes for an optional
native binding when it loads, and externalizing it is also what puts it - and its own dependencies
- into the output file trace, where the build gate asserts it is.

**What the acknowledgement hands the delivery to is the durable spine.** The route answers `200`
as soon as the envelope is committed and does not await what follows, which is
[ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s order; on a
serverless platform the invocation may be frozen before that work finishes. That is survivable
because the work is not running in the invocation: the composition's kick calls `start()` on
`@reprove/control-plane-workflow`'s ingress workflow, and from there the delivery is a durable run
the World drives through the generated routes above. The automatic re-drive of `contended` and
`transient` dispositions is that platform's own **step retry** rather than anything Reprove built
([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)). If even the `start()` never
happens, the ledger row is still `received` and the delivery is recoverable by hand.

That the build this app produces actually behaves that way is not left to review.
`node tools/verify-workflow-build.mjs` - `pnpm verify:workflow`, a layer of `pnpm verify` - builds
this app from clean, asserts the workflow bundle imports nothing but the workflow runtime and that
the output traces carry `pg` and the migration journal, then starts the built application and posts
a signed delivery to it against a canned GitHub on loopback.

Beyond these routes this is still a shell - one layout and one page - and carries no product
behaviour of its own.
