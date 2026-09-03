# The package graph and the open-core boundary

The business model was settled early - open core, Apache-2.0, billing and multi-tenant
management unpublished, a self-hosted Worker first-class and a self-hosted control plane
best-effort - but it was settled as prose. This ADR decides how that boundary is expressed as
packages a stranger can install, which is where open core stops being a statement of intent and
becomes a dependency edge.

It answers [#20](https://github.com/nick-neely/reprove/issues/20) and inherits fixed premises from
[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) (the Worker runs as a host process,
outside the Sandbox), [ADR 0005](0005-adapter-boundary.md) (one Adapter per Harness, and a hard type
boundary against `@ai-sdk/harness`), [ADR 0006](0006-worker-protocol.md) (one Worker core with two
execution lifecycles, an integer `protocolVersion`, a compatibility window) and
[ADR 0008](0008-persistence-tenancy-and-retention.md) (the tenancy boundary and its boot assertion).

The organising idea: **every boundary this map has already argued for should be a fact in the
dependency graph rather than a rule someone has to remember.** ADR 0005's ban on upstream types in
domain code, ADR 0006's insistence that the control plane never holds harness credentials, and the
open-core split itself are all statements about who may depend on what. Expressed as packages, they
are checkable in CI on the pull request that breaks them.

## The graph

> **Amended by [ADR 0014](0014-workflow-orchestration-seam.md):** a `'use step'` function is
> compiled into a bundle whose module graph is fixed at build time, so the layer that defines
> steps is the only layer that can configure them. `@reprove/control-plane` therefore cannot
> hold a workflow while also reading no environment variables. The orchestration seam moved
> to a new package, `@reprove/control-plane-workflow`, making **eight** published packages.
> Every "seven" below should be read as eight, and `workflow` is no longer a permitted
> dependency of `control-plane`. The rule this ADR was protecting - that the package reads no
> environment variables - now holds literally rather than nearly.

Eight published packages and two apps, in one Turborepo monorepo on pnpm workspaces.

```
apps/control-plane      thin Next.js composition shell
apps/docs               reserved; created when there is content

packages/protocol             @reprove/protocol
packages/adapters             @reprove/adapters
packages/sandbox-container    @reprove/sandbox-container
packages/worker-core          @reprove/worker-core
packages/worker               @reprove/worker          (bin: reprove)
packages/worker-hosted        @reprove/worker-hosted
packages/control-plane        @reprove/control-plane   (bin: reprove-control-plane)
packages/control-plane-workflow @reprove/control-plane-workflow
```

Permitted dependencies, which are also the CI matrix:

| Package | May depend on | Must not depend on |
| --- | --- | --- |
| `protocol` | `zod` | everything else |
| `adapters` | `@ai-sdk/harness`, `@ai-sdk/harness-{codex,claude-code,opencode}` | `@reprove/protocol` |
| `sandbox-container` | `@ai-sdk/harness` (core only), container runtime libraries | every `@reprove/*` package |
| `worker-core` | `protocol`, `adapters`, `sandbox-container` | `workflow`, `drizzle-orm`, `octokit` |
| `worker` | `worker-core`, `protocol` | `@ai-sdk/*` directly |
| `worker-hosted` | `worker-core`, `protocol`, `workflow` | `@ai-sdk/*` directly |
| `control-plane` | `protocol`, `drizzle-orm`, `octokit`, `better-auth` | `worker-core`, `adapters`, `sandbox-container`, `@ai-sdk/*`, **`workflow`** |
| `control-plane-workflow` | `protocol`, `control-plane`, `workflow` | `worker-core`, `adapters`, `sandbox-container`, `@ai-sdk/*` |
| `apps/control-plane` | `@reprove/control-plane`, `@reprove/control-plane-workflow`, `@reprove/worker-hosted`, `next`, `react` | `drizzle-orm`, Postgres drivers, `octokit`, `better-auth`, `@ai-sdk/*`, `@reprove/{adapters,worker-core,sandbox-container}` |

Three rows carry most of the weight.

**`@ai-sdk/*` appears in exactly two packages.** ADR 0005 forbids `HarnessV1*` and `experimental_*`
types in Reprove's domain types and worker protocol, and described the response as "a hard type
boundary, not a defensive wrapper layer." Confining the upstream dependency to `adapters` and
`sandbox-container` turns that boundary into a `package.json` fact. The split between those two is
narrower than it looks and is deliberate: `HarnessV1SandboxProvider` lives in `@ai-sdk/harness`
core, and the three bridges depend on core rather than the reverse, so the sandbox provider needs
core alone and never the per-Harness bridges.

**`control-plane` does not depend on `worker-core`.** This is the reason `worker-hosted` exists as
its own package rather than as a module inside the control plane, and it is worth stating as a
product property rather than a layout preference: a control plane that dispatches only to
self-hosted Workers installs **no harness code at all**. "The control plane never touches harness
credentials" becomes something an operator can verify with `pnpm why` instead of something they have
to believe.

**`sandbox-container` depends on nothing of Reprove's.** It is offered as an independent security
primitive, and that claim is only true if the graph says so. If it later needs a small utility, the
answer is to duplicate it or extract a genuinely generic external package, never to reach back into
Reprove's application graph.

## The open-core boundary

**The public repository holds the entire substrate. The private Cloud repository holds only what is
genuinely Cloud-only.**

Two alternatives were rejected. A **private fork or overlay** of the public app is cheaper in week
one and rots permanently: every upstream change becomes a merge, and the overlay quietly becomes the
real product while the public app decays into a demo. **A Cloud-only control plane** - publishing
only the Worker, adapters and protocol - contradicts the standing commitment that self-hosting the
control plane is a documented best-effort path, since best-effort still requires the source to
exist.

The discipline that makes the chosen shape hold is that **control-plane substance never lives in
route handlers.** `@reprove/control-plane` owns GitHub ingress, scheduling, persistence, Acceptance,
Reconciliation, publication, the Drizzle schema and migrations, the Better Auth schema and config
factory. **The hosted Workflow orchestration seam is not its** - ADR 0014 moved every workflow
and step definition, and all step configuration, to `@reprove/control-plane-workflow`.
`apps/control-plane` owns route wiring,
environment parsing and deployment configuration, and nothing else. The dependency matrix enforces
it: an app that cannot import a Postgres driver, Octokit or Better Auth cannot accumulate
control-plane logic, because it would not compile.

**The package reads no environment variables.** The app parses deployment-specific configuration and
passes it explicitly to `createControlPlane(config)`; no Reprove Cloud credential default exists
anywhere in the public package, and GitHub App id, private key and webhook secret are required
configuration with no fallback. A self-hoster registers their own GitHub App.

**Two database paths, deliberately different**, preserving ADR 0008's admin/runtime role separation:

```
migrate / bootstrap  -> admin connection, explicit operator command
createRuntimeDb()    -> restricted runtime connection
                     -> schema and RLS assertions must pass
                     -> otherwise refuse to return a client
```

ADR 0008 required that a misconfigured tenant boundary refuse to serve rather than degrade silently.
Putting that assertion inside the connection factory rather than in application startup makes it
unskippable by construction: there is no path to a client that bypasses it. Had it lived in the app,
two apps would implement it and one of them would eventually get it wrong - and ADR 0008's whole
argument is that this particular failure is invisible when it happens.

**Cloud may not fork or modify base tables or migrations.** Cloud-only persistence owns separate
tables that reference the public schema; a change a base table needs belongs upstream in
`@reprove/control-plane`. Without this, the schema boundary would be the one part of the open-core
split maintained by convention, and divergence there is silent data corruption rather than a build
error.

**The private repository is created late.** It appears when the first genuinely Cloud-only
capability does - billing, entitlements, commercial product surface - and until then
`apps/control-plane` in the public repository powers `reprove.dev` directly. What must not be
deferred is the boundary itself: the packages, the matrix and the export surfaces land at Phase 0,
built as though Cloud already consumed them, because retrofitting the extraction later is exactly
how this shape decays into the overlay it rejected.

When Cloud exists it consumes **published package artifacts**, never source over a git dependency.
Production Cloud consumes stable releases; cross-repo integration may consume a prerelease channel.
Whether that channel is published on every merge or on demand is release automation, not a
foundation decision. The point of the rule is that Cloud consumes the same artifact Reprove claims
an outsider can consume, which is the only way that claim gets tested before it is expensive to
falsify.

## Support tiers

Publishing eight packages reads as eight API commitments. Most of them are on npm only because npm
resolution requires it: `@reprove/worker` is published, it depends on `@reprove/worker-core`,
therefore `worker-core` must resolve from the registry. That is a dependency-graph fact, not a
product decision, and the drift runs one way - someone builds on an internal package and a promise
we never made becomes one we cannot break.

**Supported product surface**

- `@reprove/worker` - what a self-hosted operator installs.
- `@reprove/sandbox-container` - a standalone security primitive, usable with `@ai-sdk/harness` by
  someone who has never heard of Reprove.
- `apps/control-plane` - **as a deployable application, not as a package.** A self-hoster deploys the
  app; they do not write code against `createControlPlane()`. Only Cloud does, and Cloud is us.

**Published infrastructure with a supported wire contract**

- `@reprove/protocol`. Its *package API* is not a supported general-purpose SDK - importing a helper
  from it earns no long-term API promise. Its *wire contract* under `/v1`, `/v2` is
  compatibility-governed by ADR 0006 and cannot be called unstable while a four-month-old official
  Worker depends on it. The distinction is the point: the wire is a contract, the library is not.

**Published by necessity**

- `@reprove/worker-core`, `@reprove/worker-hosted`, `@reprove/adapters`, `@reprove/control-plane`,
  `@reprove/control-plane-workflow`.
  Public source, published so the graph resolves, gated by every CI check, carrying no stability
  promise. Each says so in its README.

## The Worker's three packages

ADR 0006 settled "one Worker core with two execution lifecycles." That is expressed as three
packages rather than one core plus a buried module:

```
@reprove/worker-core     adapters, Sandbox provisioning, Workspace materialization,
                         Result construction and validation, Evidence cross-check
@reprove/worker          self-hosted lifecycle: long-lived daemon, enrollment, polling,
                         claim, lease, cancellation
@reprove/worker-hosted   hosted lifecycle: Vercel Workflow steps driving worker-core via
                         the Adapter's internal detach/resume
```

The hosted driver is doubly coupled - to `@ai-sdk/*` through `worker-core`, and to Workflow's Vercel
World - which is two independent reasons to keep it out of `control-plane`. Under lockstep
versioning the split costs nothing, since the two always move together anyway, whereas splitting a
published package later is a breaking change for every consumer.

**Hosted capability is optional composition, not a default.** A hosted-capable deployment composes
`control-plane` + `worker-hosted`; the self-hosted composition omits `worker-hosted` entirely. If
every control-plane app composed both, the split would buy nothing.

`@reprove/worker` exposes the single globally meaningful command:

```
reprove enroll | start | status
```

`@reprove/control-plane` exposes `reprove-control-plane bootstrap | migrate`, deliberately
namespaced and not expecting global installation - a deployment resolves it through its own package
manager and wraps it in scripts. Two global bins named `reprove` would collide, and the single-host
case is real: someone evaluating Reprove runs the self-hostable control plane and a self-hosted
Worker on the same box. The underlying `bootstrap()` and `migrate()` functions are also exported, so
a consumer is never forced to shell out, but only one command owns the name.

**The artifact is the package, not an installation command.** `@reprove/worker` is distributed on
npm and installed with whatever npm-compatible client the operator uses. No standalone binary and no
primary container image: ADR 0004 already requires the Worker to run as a host process because a
containerised Worker needs a runtime socket, and the host already has Node because Codex, Claude
Code and OpenCode are themselves npm-distributed CLIs. A binary is a second build pipeline and a
second supply-chain surface on precisely the machines holding Codex and Claude credentials, which is
the authority ADR 0006 declined to take when it refused an auto-update channel. It remains available
later if Node installation turns out to be a real adoption barrier.

## The protocol package

`@reprove/protocol` contains the versioned wire contract and nothing else: Result and the
wire-visible Finding and Evidence shapes, progress events, Refusal, capability descriptors,
enrollment, claim, lease and cancellation, repository-access messages, and protocol versioning. Zod
schemas are authoritative; TypeScript types are inferred from them. It depends on `zod` and nothing
more.

**Adapters may not depend on it.** An Adapter yields ADR 0005's unnamed per-Pass bundle; `worker-core`
composes the wire Result. An Adapter that knew the wire format would be reaching a layer above
itself.

**Version families are subpath exports, not a growing union.**

```
@reprove/protocol/v1     zod schemas | JSON Schema | fixtures
@reprove/protocol/v2     ...
```

A Worker imports the single version it speaks and advertises the matching integer. During ADR 0006's
compatibility window the control plane imports both and dispatches on `protocolVersion`. A single
discriminated union was rejected for growing without bound and making the frozen-behaviour property
unenforceable; keeping old schemas privately in the control plane was rejected for hiding wire
history where a Worker author cannot read it.

**A version directory is a compatibility family, not a frozen source snapshot.** ADR 0006 already
settled that compatible additive evolution does not bump the integer, so `/v1` must be allowed to
evolve within v1's own compatibility rules:

| Allowed within `/v1` | Requires `/v2` |
| --- | --- |
| adding an optional field | removing a field |
| adding a field old readers ignore | making an optional field required |
| widening behaviour compatibly | changing an existing field's meaning |
| adding compatibility fixtures | narrowing accepted values |

What is immutable is **established behaviour**: an existing golden fixture may never be removed or
weakened, and a payload previously valid under a version stays valid under it.

**The `.d.ts` API report does not protect the wire.** A zod refinement, a default, an enum change or
a serialization rule can become wire-incompatible without changing the inferred TypeScript
declaration at all. So protocol CI additionally runs **golden fixtures**: previously valid payloads
must still validate at the same `protocolVersion`, and behaviour that breaks them requires a new
version family. That is the load-bearing compatibility gate; the declaration report protects the
TypeScript API only.

**Third-party Worker implementations are not supported at launch, but the protocol is still a
contract.** ADR 0006 depends on it being one - a four-month-old official Worker on someone else's
machine is exactly the case it is for. What is declined is a *support and documentation promise* for
independently implemented Workers, not protocol stability. Notably the reason is not security: ADR
0006 already treats every Worker as untrusted and puts the guarantee in control-plane Acceptance, so
a third-party Worker introduces no new trust problem. The reason is that specifying a protocol we
have not yet shipped freezes decisions we should still be learning from.

Two cheap constraints keep it a documentation project later rather than a redesign:

- **Publish JSON Schema and fixtures beside the zod schemas** for each version family, including
  invalid fixtures with their expected rejection where useful.
- **Wire shapes stay plain JSON.** No branded runtime-only representation, no zod transform whose
  meaning exists only in TypeScript, no class instances, `Map`, `Set`, or `bigint` ambiguity.

The schemas and this ADR define the contract; fixtures prove compatibility properties and important
examples. Fixtures are deliberately **not** described as the specification, or an unrepresented edge
case silently becomes undefined.

## Deployment topologies

```
Reprove Cloud / Vercel        self-hosted
@reprove/control-plane        @reprove/control-plane
@reprove/worker-hosted        (no worker-hosted)
Workflow Vercel World         Workflow Postgres World
hosted + self-hosted Workers  self-hosted Workers only
```

The self-hosted product is **your control plane, your Workers**: a standard Node 22+ process
deployment of the Next.js app against Postgres, with no harness stack anywhere in the control-plane
process. It has no managed hosted-Worker capability unless someone later authors a second hosted
execution driver.

**Durable orchestration is not Vercel-specific; hosted Worker execution is.** Workflow runs against
pluggable Worlds, and `@workflow/world-postgres` is first-party and Apache-2.0, so the off-Vercel
control plane keeps ADR 0006's durable Run orchestration rather than growing a second scheduler
beside it. Recorded as a dependency risk rather than a settled guarantee: that package
self-describes as "a reference World implementation," it lags the main `workflow` release line, and
a `5.0.0` line is already in beta. The mitigation is that `@workflow/world` is a published
*interface*, so authoring a Reprove World stays possible if the reference implementation proves
inadequate.

**Workflow's storage stays opaque.** It may point at the same Postgres server operationally, but its
tables are never part of `@reprove/control-plane`'s Drizzle model, never covered by ADR 0008's
migrations, and never subject to its RLS policies. They are the Workflow SDK's infrastructure, not
Reprove's persistence.

**Neon remains the settled, tested database.** This ADR does not broaden that promise, which belongs
to the map and ADR 0008. What it settles is narrower and is a packaging decision: `@reprove/control-plane`
uses **standard PostgreSQL connection semantics** through a plain TCP driver, with no
`@neondatabase/serverless` API in data-access contracts. ADR 0008's load-bearing properties -
interactive transactions, `SET LOCAL`, RLS and `FORCE ROW LEVEL SECURITY`, a restricted
non-`BYPASSRLS` runtime role, a separate migration role, the boot assertion - are ordinary Postgres
features; the Neon-specific findings were hazards to handle, not capabilities consumed. A
WebSocket-only driver would work on Neon and nowhere else, making "self-hostable" false at exactly
the layer where ADR 0008 put the tenancy boundary. Transaction-scoped tenant context is
**non-optional in the factory**, never a configuration flag, so the same code is correct on a pooled
Neon endpoint and on plain Postgres. Other PostgreSQL deployments are best-effort until a
compatibility matrix covers them in CI; promoting them to supported is a separate decision.

## Versioning and publishing

**Lockstep across all eight packages**, via changesets in fixed mode. Independent versioning would
produce an eight-package compatibility matrix nobody maintains, and package semver is doing far less
work here than it appears to, because the questions that actually matter have better instruments:

```
package version      which Reprove release is this?
protocolVersion      can these two processes speak safely?
workerBuildVersion   what Worker build executed this Run?
```

These are deliberately different. `@reprove/protocol@2.7.0` does **not** mean `protocolVersion = 2`,
and a lockstep major bump is not a wire break. The cost is cosmetic version churn on `protocol`,
which is preferable to operating a matrix. `workerBuildVersion` derives from the lockstep release
version plus build metadata; `protocolVersion` stays entirely independent.

**Publishing starts when the first real external consumer arrives** - `@reprove/worker`, at Phase 3 -
and all eight publish together at `0.x` from that train. Publishing unused packages earlier to prove
packaging works is not necessary, because CI proves it from Phase 0 without the registry:

```
build -> pnpm pack -> install the tarball into a clean consumer fixture
      -> typecheck, import, smoke test -> publint -> attw
```

Testing the **packed artifact** rather than the workspace source is what catches workspace-only
assumptions. `0.x` is doing real work: the package boundary is real while the public APIs are
explicitly pre-stable.

Published output is **ESM-only JavaScript plus `.d.ts` declarations**, with `engines.node >= 22`
matching the settled runtime. No CJS build: the only consumers are a Node CLI and a Next.js app, and
dual output would double the packaging surface for a consumer who does not exist.

## Enforcement

**The CI dependency matrix is load-bearing.** pnpm's strict `node_modules` layout is defence in
depth - it prevents a package importing what it never declared - but the architectural rule is the
matrix itself: a small explicit script asserting the table above, kept deliberately tiny rather than
adopting an architecture-lint framework for a rule this size.

Alongside it:

- **API report per published package**, derived from emitted declarations and checked in, so a public
  TypeScript API change produces a reviewable diff rather than depending on a reviewer recalling ADR
  0005.
- **Forbidden-type gate** on `adapters` and `sandbox-container`: the public declaration surface must
  contain no `HarnessV1*`, no `experimental_*`, and no other upstream implementation type. An
  upstream type can leak through an exported signature even when the consuming package never imports
  `@ai-sdk/harness`, so this does not rest on someone noticing it in a snapshot diff.
- **Protocol golden fixtures**, as above.
- **A real-builder workflow check** ([ADR 0014](0014-workflow-orchestration-seam.md)): build
  from clean, assert the workflow bundle requires no external module, assert the output trace
  carries what the steps need, then start the built app and execute a workflow. It asserts
  observable execution rather than artifact shape, because the bundling behaviour it guards is
  undocumented and would otherwise make CI brittle against an SDK upgrade.
- **`publint` and `attw`** on the packed artifact.
- **pnpm catalogs** for the two churning dependency sets, so each has one source of truth and is
  bumped atomically. The harness set needs care: the bridges exact-pin core
  (`harness-codex@1.0.96` depends on `@ai-sdk/harness@1.0.94`), so a catalog entry for core that
  disagrees yields two copies in the store and breaks type identity. Pin the bridges and let core
  resolve, or pin all four to a verified-agreeing set. The Workflow set needs its own entry, since
  `world-postgres` and `workflow` release on different cadences.
- **Explicit workspace globs** - `packages/*` and `apps/*` only. `prototypes/**` stays outside the
  workspace entirely, keeping its throwaway dependencies and lockfiles isolated.

Shared tooling configuration (TypeScript base configs, lint configuration) lives in private
workspace packages that are never published. Public source does not imply every package is a
user-facing npm product.

> **Amended by [issue #29](https://github.com/nick-neely/reprove/issues/29):** it settled that
> TypeScript, Vitest, Turbo, lint, format and boundary configuration all live at the repository
> root instead. No private tooling workspace exists, so the workspace set stays exactly the eight
> packages and two apps.

> **Amended by [issue #43](https://github.com/nick-neely/reprove/issues/43), 2026-09-03:**
> `tools/verify-packages.mjs` implements this section's packed-package obligations as one step
> inside `pnpm verify`, and it runs the forbidden-type gate over **every** publishable package's
> packed declarations rather than only `adapters` and `sandbox-container`. That is a strict superset:
> scanning all eight needs no list to maintain, and ADR 0005's ban on upstream types in Reprove's own
> types holds everywhere, not only where a leak is likeliest. The API report per published package
> lives at `packages/<dir>/api-report.md` and holds the emitted declarations verbatim.

## Consequences

- **ADR 0005's type boundary is now mechanically enforced** rather than reviewed, by the two-package
  confinement of `@ai-sdk/*` plus the forbidden-type gate on emitted declarations.
- **ADR 0006's "one Worker core, two execution lifecycles" becomes three packages**, and its
  compatibility window gains a concrete expression in version-family subpaths. Its sentence "what the
  two lifecycles share is the Result and progress contract and the acceptance code path" was
  ambiguous between two different operations and is corrected there.
- **ADR 0008's boot assertion moves into the connection factory**, where it cannot be skipped, and
  its constraints are re-read as standard Postgres rather than Neon features at the package seam.
  Neon remains the settled deployment.
- **`CONTEXT.md` gains `Acceptance` and `Reconciliation`, and the Worker-side operation is named
  `Evidence cross-check`.** The package split exposed that "reconciliation" meant two different
  things in ADR 0005 and ADR 0007, and "acceptance" two different things in ADR 0005 and ADR 0006 -
  neither word was in the glossary, which is how the collision went unnoticed.
- **The protocol schema validates at both sides of the untrusted boundary.** Worker-side validation
  ensures Reprove's own Worker does not emit a malformed Result; control-plane validation treats
  every submission as untrusted input, because a hostile or buggy Worker can skip its own code and
  POST arbitrary bytes. This is one authoritative schema applied twice, not duplicated logic.
- **Two supported npm packages, not eight.** The self-hosting surface is an application, which
  substantially reduces the API commitment this map takes on.
- **Third-party Worker implementations are out of scope** for the foundation map, while remaining
  possible later at documentation cost rather than redesign cost.
- The first `package.json` in this repository unblocks the map's Dependabot and supply-chain patch,
  which was waiting on exactly that.
