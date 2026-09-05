# Contributing to Reprove

Thanks for your interest. Reprove is open source under
[Apache-2.0](LICENSE), and contributions of every size are welcome.

Everyone participating is held to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems do **not** go in a public issue - see [SECURITY.md](SECURITY.md).

## Getting started

The stack is TypeScript on Node 22 (ESM), pnpm workspaces with Turborepo,
Vitest for tests (Playwright later), and Oxlint/Oxfmt through Ultracite.

A clean clone installs and proves itself in five steps:

```text
install Node 22
corepack enable
pnpm install --frozen-lockfile
pnpm db:up                          Docker; see "Database" below
pnpm verify
```

`pnpm verify` is the repository's proof. It sequences six independently owned
layers, and the first to fail names the workspace and the rule it broke:

```text
node tools/verify-workspace.mjs    the ADR 0010 workspace and dependency matrix
node tools/verify-migrations.mjs   migration history was only appended to
turbo run build typecheck          every workspace builds and type-checks
node tools/verify-packages.mjs     the packed package contract
vitest run                         the tests, against the local database stack
ultracite check .                  lint and format
```

Each layer is runnable on its own as an inner-loop shortcut - `verify:workspace`,
`verify:migrations`, `verify:build`, `verify:packages`, `verify:test` and
`verify:lint`, each under `pnpm run` - but passing one is never equivalent to
passing `pnpm verify`.

`verify:migrations` is Git-aware, and it is the only layer that is: it compares
the migration folder against the merge-base with the pull request's base ref, or
against the push event's `before` SHA on a push to `main`, and rejects a
journaled migration that was modified, deleted, reordered or replaced. It **fails
closed** - a baseline it cannot resolve is a failure telling you to fetch the
base branch history and rerun, never a skipped check - so CI checks out with
`fetch-depth: 0` and a shallow clone produces an actionable failure rather than a
green run that proved nothing.

`verify:packages` proves the artifact a consumer would actually install. It
discovers the publishable packages from their own manifests, packs each one with
`pnpm pack`, and installs the tarballs into a throwaway fixture that holds **one
consumer per package, each depending on its own tarball and nothing else**. In
each it type-checks, imports and smoke-runs that package's published subpaths,
then puts `publint` and `attw` over the same tarballs. Giving each package a
consumer of its own is what makes a dependency a package uses but never declared
fail: module resolution walks up from the importing file, so a consumer holding
every tarball would let the siblings satisfy it. It runs after the build because
it packs `dist`, and it needs no network: the fixture installs `--offline` from
the store your `pnpm install` already filled.

It also owns the two checks that guard the published TypeScript surface:

- **The API report.** Each publishable package carries an `api-report.md`
  holding its emitted declarations verbatim, so a public API change shows up as
  a reviewable diff. When a change to it is intended, run
  `pnpm verify:packages --update` and commit the result with the change.
- **The forbidden-type gate.** No `HarnessV1*`, `Experimental_*` or
  `@ai-sdk/*` may appear on a packed declaration surface, because an upstream
  type leaks through an exported signature even when the package never imports
  it ([ADR 0005](docs/adr/0005-adapter-boundary.md)).

`pnpm verify:packages --keep` leaves the consumer fixture on disk and prints its
path, which is the fastest way to see what a consumer actually received.

### Database

`vitest run` includes tests that measure the tenant boundary against a real
database, so they need one running. Docker is the only prerequisite:

```text
pnpm db:up      # Postgres 17 and PgBouncer, from tools/db/compose.yaml
pnpm db:down    # and away again, volumes included
```

If it is not up, those tests **fail with instructions rather than skipping**.
The failures [ADR 0008](docs/adr/0008-persistence-tenancy-and-retention.md)'s
rules 2 and 3 exist for are only observable on a pooled connection - session
state outliving the client that set it, and reaching a client that set nothing -
so a run that quietly skipped them would prove the boundary against an
arrangement production does not use.

The stack serves the two connections ADR 0008 keeps separate and never crosses:
an **admin** role on the direct endpoint at `127.0.0.1:55532`, which owns the
tables and applies migrations, and the restricted **`reprove_runtime`** role
through **PgBouncer in transaction mode** at `127.0.0.1:56532`, which is what
all application traffic uses.

Changing the schema is `pnpm --filter @reprove/control-plane db:generate`, and
then `db:force` if the change touched the tenancy classification. **Migration
history is append-only, and that is a hard invariant rather than a convention**:
Drizzle writes a migration hash it never reads, so editing an applied migration
is silently ignored and every existing database keeps the old DDL with no error
raised anywhere ([ADR 0017](docs/adr/0017-authoring-time-tenancy-boundary.md)).
Two rules follow, and `pnpm verify` enforces both:

- **A hand-authored migration may not touch the tenant boundary.** No
  `CREATE TABLE`, no `ENABLE`/`DISABLE ROW LEVEL SECURITY`, no `FORCE`/`NO
  FORCE`, no `CREATE`/`ALTER`/`DROP POLICY`. Those come from the schema module
  through drizzle-kit, or from the FORCE generator, and from nowhere else.
- **Forcing is generated, never written.** Classify a new table in
  `src/db/classification.ts` and run
  `pnpm --filter @reprove/control-plane db:force`; it derives the `FORCE` or
  `NO FORCE` delta from the classification and appends it as a new migration. It
  never rewrites one it already emitted, because a rewritten migration is correct
  in the repository and inert in every database already carrying it.

Setting a database up is two ordered commands, not two interchangeable ones:
`reprove-control-plane bootstrap` provisions the runtime role, then
`reprove-control-plane migrate` applies the schema and grants the runtime role
its reach over exactly the tables that schema manages. Every migration grants the
tenant boundary to that role, so the role has to exist first. See
[`packages/control-plane`](packages/control-plane/README.md#the-database).

Two things catch people out:

- **A dependency change is deliberate.** Adding, removing or bumping a
  dependency uses a plain `pnpm install` rather than the frozen one, and the
  manifest, catalog and `pnpm-lock.yaml` changes are committed together.
- **A dependency's build script runs only if it has been admitted.**
  Install-time scripts are approved per package and version in
  `pnpm-workspace.yaml`'s `allowBuilds`; an unreviewed one fails the install
  rather than executing.

Continuous integration runs the same command. Two checks are required on every
pull request: `verify`, which is the six layers above on Ubuntu and Node 22 with
the database stack up, and `dependency-review`, which blocks newly introduced
high or critical vulnerabilities in runtime and development dependencies alike.
A new layer is sequenced inside `pnpm verify` rather than added as a third
required check.

## Where the project is right now

**Phase 0 - the foundation.** The workspace, verification seam, and initial
protocol v1 contract exist; most product behaviour does not yet. The
specification and the decision record are still where the reasoning lives:

| Path | What it is |
|---|---|
| [`docs/prd.md`](docs/prd.md) | The product definition. Direction, not gospel - it changes as decisions land. |
| [`CONTEXT.md`](CONTEXT.md) | The glossary. The language of record for every noun in the system. |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records. One file per load-bearing decision. |
| [`docs/research/`](docs/research/) | Findings from investigations that decisions depended on. |
| [`docs/agents/`](docs/agents/) | Conventions for the coding agents that work in this repo. |

Code is not the only useful contribution, and at this stage it is not even the
most useful one. Reading the PRD or an ADR and telling us where it is wrong is
worth more than most patches.

## Speak the glossary

[`CONTEXT.md`](CONTEXT.md) is not a style suggestion; it is the vocabulary the
codebase is being built in, and it lists the synonyms each term exists to
replace. Before you write an issue title, a type name, or a paragraph of docs,
check the term you are about to use.

Two rules it enforces that catch people out:

1. **No `Review` prefix on domain nouns.** The whole system is review, so
   `ReviewJob`, `ReviewResult` and `ReviewFinding` stutter. The nouns are bare:
   **Run**, **Result**, **Finding**.
2. **A dependency's name gets qualified at the seam, not ours.** Where a library
   already occupies a word Reprove needs, Reprove keeps the bare name and renames
   the foreign one where it enters - Vercel Workflow's `runId` becomes
   `workflowRunId` on arrival.

If the concept you need is not in the glossary, that is a signal: either the
project does not use that language, or there is a real gap worth raising.

## How changes get proposed

### Issues

Open an issue before a substantial pull request. It is cheaper to be told an
idea is out of scope than to be told after you have built it.

Issue templates cover the three common cases: a bug, a feature, and support for
a new **Harness**. Pick the closest one.

New issues are labelled `needs-triage`. From there a maintainer applies one of:

| Label | Meaning |
|---|---|
| `needs-triage` | A maintainer still needs to evaluate this |
| `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | Fully specified; an autonomous agent can pick it up |
| `ready-for-human` | Needs human implementation |
| `wontfix` | Will not be actioned |

### Wayfinder maps

Structural decisions are made in the open through **wayfinder maps**: an issue
labelled `wayfinder:map` that names a destination, indexes the decisions made so
far, and carries its open questions as child issues. Each child is labelled by
type - `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or
`wayfinder:task` - and blocked-by edges show which are takeable now.

[Map: Lock the Reprove foundation](https://github.com/nick-neely/reprove/issues/1)
is the live one. If you want to know why something is the way it is, that map
and [`docs/adr/`](docs/adr/) are the answer. If you disagree with a settled
decision, the ADR is the thing to argue with.

Map work lands on a single long-lived branch rather than a branch per ticket.
Ordinary contributions do not need to follow that convention.

### Pull requests

- Branch from `main`.
- Keep a pull request to one concern. Two unrelated fixes are two pull requests.
- Update the docs the change invalidates in the same pull request - a PRD line,
  a glossary entry, an ADR. A decision that contradicts an existing ADR should
  say so explicitly rather than silently overriding it.
- Fill in the pull request template. The "why" matters more than the "what";
  the diff already says what.

## Licensing of contributions

There is nothing to sign. Reprove requires **no CLA and no DCO sign-off** -
open a pull request and that is the whole process.

Contributions are licensed inbound under the same terms as the project's
outbound license. Apache-2.0 Section 5 says so directly: a contribution
submitted for inclusion in the work is under the terms of the license, absent
an explicit statement otherwise. Section 3 carries an explicit patent grant
from each contributor along with it. So by opening a pull request you are
licensing that work to the project under [Apache-2.0](LICENSE), and confirming
you have the right to do so.

That leaves one consequence worth stating plainly, because it is a promise
rather than an oversight: **Reprove cannot unilaterally relicense contributed
code, and does not intend to.** A CLA is the instrument that would grant that
right, and the project deliberately does not collect one. Reprove Cloud stays
proprietary by keeping billing and multi-tenant management in unpublished
packages - by what gets published, not by holding rights over what is
contributed here.

If you are contributing on behalf of an employer, make sure you have the right
to do that before you open the pull request. That is between you and them; the
project takes your submission at face value.

## Reviewing your own work

Reprove is a code review tool. Hold contributions to the standard the product
argues for: a claim about the code should be **verified** by executing something,
not asserted. If you say a change fixes a bug, the pull request should show what
you ran.

## Questions

Open an issue. Discussions are not enabled yet.
