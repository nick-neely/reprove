# `@reprove/control-plane`

Control-plane substance: GitHub ingress, scheduling, persistence, Acceptance, Reconciliation, publication, the Drizzle schema and migrations, and the Better Auth schema and config factory.

**The package reads no environment variables.** The app parses deployment-specific configuration and passes it explicitly to `createControlPlane(config)`. No Reprove Cloud credential default exists here. The one exception is the bin below, which is the operator entry point rather than library code.

It does **not** depend on `@reprove/worker-core`, and since [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) it does not depend on `workflow` either - every workflow and step definition lives in `@reprove/control-plane-workflow`.

## The database

Two connections, never crossed ([ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)):

```text
admin / migration connection      runtime connection
  owner-or-admin role               reprove_runtime, non-BYPASSRLS
  direct endpoint                   pooled endpoint
  bootstrap() and migrate()         all application traffic
```

```text
reprove-control-plane <bootstrap|migrate>
```

The command is namespaced deliberately and does not expect global installation; `bootstrap()` and `migrate()` are exported too, so a consumer is never forced to shell out.

**`bootstrap` runs before `migrate`, and the two are not interchangeable.** Every generated migration carries `CREATE POLICY ... TO "reprove_runtime"`, which fails outright if the role does not exist yet, so `migrate` refuses rather than failing halfway through. `bootstrap` provisions the restricted role and the reach it has before any table exists - `CONNECT`, `USAGE` on `public`, read on the migration ledger, and the revocations that keep it from creating a relation of its own - and creates no table. It also revokes **every role membership** the runtime role holds: a membership is a `SET ROLE` into privileges the boot assertion cannot see, since every privilege it reads is `current_user`'s own, and nothing in this design needs one.

**Grants on Reprove's tables belong to `migrate`, and they name those tables one by one.** Nothing grants `on all tables in schema public` or sets a default privilege there, because a schema is somewhere a neighbour may legitimately put a relation and both forms say "whatever is in this schema". A view is the sharpest case: a view runs as *its owner* unless it carries `security_invoker`, so an admin-owned view over a tenant table reads every Owner's rows, and a schema-wide grant hands it over. The runtime role holds `SELECT, INSERT, UPDATE, DELETE` on exactly the managed tables, `USAGE, SELECT` on the sequences those tables own, and `TRUNCATE`, `REFERENCES` and `TRIGGER` on nothing - `TRUNCATE` most of all, because it ignores row-level security entirely. Re-running `migrate` re-applies all of that even when it applies no migration, which is how a drifted grant gets repaired.

Both read the admin connection string from `REPROVE_DATABASE_ADMIN_URL`, and `bootstrap` reads the runtime role's password from `REPROVE_DATABASE_RUNTIME_PASSWORD`. Neither is a command-line argument, because argv leaks a secret into every process listing on the host.

`createRuntimeDb()` opens the runtime connection, runs rule 6's seven assertions, and either returns a client or throws a `BootRefusalError` naming every check that failed. There is no flag and no bypass. All Owner-scoped access goes through `withOwner(ownerId, tx => ...)`, which sets the tenant context with `set_config('app.owner_id', $1, true)` - parameterized, and transaction-local, because a bare `SET` released to a pooler in transaction mode is inherited by the next client.

Local development and CI run the stack in [`tools/db/`](../../tools/db): `pnpm db:up` brings up Postgres 17 and PgBouncer in transaction mode, and `pnpm db:down` removes them. Docker is the only prerequisite. See [CONTRIBUTING.md](../../CONTRIBUTING.md#database).

### The published surface names no Drizzle or `pg` type

ADR 0010's matrix forbids `apps/control-plane` - the only consumer - from depending on `drizzle-orm` or a Postgres driver, so nothing this package exports names a type from either. That is ADR 0005's forbidden-type boundary applied to the database: an upstream type leaks through an exported signature even when the importer never names the package.

The schema, the classification, `createRuntimeDb()` and its tenant transaction therefore stay inside the package, reachable from `./db/index.js` by the control-plane code that owns them. Composition reaches the app as `createControlPlane(config)`.

### The migration folder is a runtime asset

`drizzle/` is in the package's `files` list and is resolved relative to the module rather than to `process.cwd()`, because the boot assertion joins the hashes Drizzle stored against the files that produced them ([ADR 0017](../../docs/adr/0017-authoring-time-tenancy-boundary.md)). Migration history is **append-only**: `PgDialect.migrate` writes a hash it never reads, so an edited applied migration is silently ignored and every existing database keeps the old DDL.

`0000_initial_schema` and `0002_better_auth_account_model` are drizzle-kit generated from `src/db/schema.ts`. `0001_force_row_level_security` is a `generate --custom` migration carrying the one statement Drizzle cannot express, in a canonical grammar:

```sql
-- reprove:force-row-level-security
ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;
```

**That grammar is generator-owned.** `pnpm --filter @reprove/control-plane db:force` derives the delta from the classification - `FORCE` for a newly tenant table, `NO FORCE` for a newly non-tenant one, nothing where the two already agree - and appends it as a new migration. It reads the effective state of the whole journal rather than its own last output, so running it twice produces one migration; it never rewrites one it already emitted, which it could not do safely. The script builds the package first on purpose: a generator run against a stale `dist` would append a migration derived from a classification nobody has any more, into a history that is append-only.

**Hand-authored migrations may not touch the tenant boundary at all** - no `CREATE TABLE`, no `ENABLE`/`DISABLE ROW LEVEL SECURITY`, no `FORCE`/`NO FORCE`, no `CREATE`/`ALTER`/`DROP POLICY`. That generalises "may not introduce a table" to close `DROP POLICY` and `DISABLE ROW LEVEL SECURITY`, which are the same hole in a different doorway.

Which rules a migration is held to follows from **who wrote it**, and that is measured rather than declared, because drizzle-kit marks nothing: `generate` writes a snapshot reflecting the new schema and `generate --custom` copies the previous one verbatim apart from its identity. A migration whose snapshot did not advance is therefore custom, and the marker separates the generator's from a human's.

```text
snapshot advanced             drizzle-kit generated   the schema module's output
snapshot unchanged, marked    the FORCE generator     conforms exactly, or fails
snapshot unchanged, unmarked  hand-authored           may not touch the boundary
```

The effective state is then a walk of the journal in order: `0001 FORCE` followed by `0002 NO FORCE` leaves the table unforced and fails, because effective final state is the property rather than textual occurrence. The walk covers all three of the boundary's facts - the FORCE state, the RLS enablement, and the policy set each table is left with - and it reads **every** migration whoever wrote it, which is what makes attribution safe. Attribution says a drizzle-generated file is *allowed* to carry `CREATE POLICY` and `ENABLE ROW LEVEL SECURITY`; it cannot say whether the statements in it are the ones the schema module asked for, so a `DROP POLICY` or a `DISABLE ROW LEVEL SECURITY` edited into one fails on the policy set it leaves behind rather than on the file it is in. A boundary statement the walk cannot parse is a failure, not a skip.

`0002` adds `account.issuer` as `NOT NULL` with no default and no backfill, which is drizzle-kit's own output and is left as generated. It is safe because it cannot meet a row: nothing wrote to `account` before `createAuth()` existed, so every database at `0001` has it empty. It is also the behaviour to want if that were ever untrue - a default would invent an issuer for accounts nobody can attribute, and mis-key them under the `(issuer, account_id)` unique index beside it, where the bare `NOT NULL` stops the migration and says so.

All of it is ordinary Vitest - `declared.test.ts`, `force.test.ts`, `force-generate.test.ts` - beside `tools/verify-migrations.mjs`, which is the Git-aware half that proves history was only appended to. None of it sees a database: what actually deployed is `createRuntimeDb()`'s seven checks, and that division is ADR 0017's, not an omission.

## GitHub ingress

`POST /api/github/webhook` is composed in [`src/github/`](src/github) and reaches the app as
`createControlPlane(config)`. [ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
fixes the order and makes it the whole decision:

```text
verify HMAC-SHA256 over the raw bytes
  -> normalize a bounded ingress envelope
  -> commit it with its processing state
  -> return 200
  -> kick asynchronous processing        (#49)
```

**Durability comes before the acknowledgement**, because GitHub does not automatically redeliver:
redelivery is manual, from the App's delivery UI or the deliveries API, and only within three days.
A `200` returned before anything is persisted is therefore the one genuinely unrecoverable outcome
in the system, and **a failure to commit is a non-2xx on purpose** - it buys the only recovery
GitHub offers. Once the envelope is committed the opposite holds: a failed asynchronous kick still
returns `200`, because Reprove now holds the intent and the ledger is what recovers it.

The commit is a **port** rather than a database call, and that is what makes the ordering testable
rather than merely intended. A handler that answered first and persisted afterwards passes every
assertion about status codes; `webhook.test.ts` watches where the commit lands relative to the
answer instead. `createControlPlane()` binds the port to a `withOwner` transaction, and
`control-plane.test.ts` measures the whole path against the real database - including that a
rejected delivery leaves the table empty, which a stub commit cannot say.

Each rejection carries a status of its own, because the recovery story differs for each:

| | | |
| --- | --- | --- |
| `200` | acknowledged | the envelope is durable |
| `401` | unsigned | no valid signature over these exact bytes |
| `413` | oversized | over the cap, refused **before** being hashed |
| `422` | unusable | signed, and still not something an envelope can be built from |
| `503` | not committed | nothing was stored, so nothing is acknowledged |

Three things are Reprove's own code rather than a dependency's, and each is one line of ADR 0013's
closing implementation notes. The signature is verified against the **exact received bytes**, never
a re-serialized parse - `JSON.parse` followed by `JSON.stringify` moves key order, whitespace,
unicode escapes and the digits of a number, so a handler hashing its own re-serialization would
accept bodies GitHub never signed. The comparison is `timingSafeEqual`. And the body is read under
a cap as a stream rather than buffered and measured afterwards, because "before hashing it" is a
claim about the bytes rather than about the status.

**The envelope is bounded and normalized, never the raw body.** It carries durable locator and
trigger facts only - Owner, Installation and Repository ids, the repository locator, pull request
number, event, action, delivery GUID - because the pull request's actual state is fetched
canonically later and persisting the raw body would durably duplicate narrative and other
repository-derived content into a retention surface [ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)
would then have to govern.

**The delivery GUID is indexed and deliberately not unique.** GitHub reuses `X-GitHub-Delivery` on a
manual redelivery, so a unique constraint would swallow the only recovery GitHub offers. The rule is
stateful instead - same GUID plus a terminal state is a duplicate, same GUID plus a nonterminal one
resumes - and #49 owns it. The ledger's states, the three terminal dispositions (`ineligible`,
`duplicate_head`, `grant_gone`) and the three retry classes (`transient`, `operator_attention`,
`contended`) are named in [`src/db/schema-values.ts`](src/db/schema-values.ts) and settled through
`settleDelivery()`, which counts the attempt in SQL so two processors cannot both write the count
they each read.

A verified payload establishes **identity** and not scope: `recordDelivery()` upserts Owner,
Installation and Repository rows in front of the ledger insert, because `ingress_delivery`
references `owner` and a first-ever delivery would otherwise be a foreign-key violation. No path may
require that `installation.created` arrived first - GitHub never auto-redelivers, so one dropped
lifecycle delivery would orphan an Owner permanently. Whether a repository is *in scope* stays with
the canonical fetch under installation authority, which #49 builds.

Identity is written so that it can never be what loses a delivery. A repository id is unique across
GitHub and survives a **transfer between accounts**, so the id a delivery carries may already name a
row belonging to another Owner; conflicting into an update there is a row-level security failure
raised from inside the statement, which would fail the transaction and answer non-2xx for a delivery
GitHub will never resend. So the Repository row is an Owner-scoped update and only then an insert
that conflicts into `do nothing`: the foreign row is left as it is, the envelope still commits, and
reconciling the transfer waits for authority over both Owners that no tenant transaction has. For
the same reason an Installation the delivery did not name is left alone rather than cleared - a
delivery that named none is not evidence that there is none.

### The App requests two read permissions and publishes no Check

`githubAppManifest()` is the registration, and the grant in it is the complete one:

```text
Metadata: read          mandatory for every App
Pull requests: read     gates delivery of the pull_request event
```

`Contents: read`, `Pull requests: write` and `Checks: write` are **not** pre-declared. Adding a
permission later requires every existing installation to approve it, which is a real cost and one
Phase 0 does not pay, because it has no third-party installations; pre-declaring write authority
buys nothing today and costs an install consent screen that overstates what the App can do.

**No Check is published.** `CONTEXT.md` requires every Refusal to be visible on a Check, which looks
like it forces `Checks: write` into the grant. It does not: no Refusal is reachable in Phase 0, so
the Check lands with the first phase that can produce one and must land at the same time as it. A
rejected delivery is not a Refusal - nothing was refused and nothing executed.

The App subscribes to exactly `pull_request`. `installation`, `installation_repositories` and
`github_app_authorization` arrive at every App unconditionally and cannot be unsubscribed from, so
their absence from the manifest says nothing about whether they are recorded: the handler
normalizes whatever event it is sent rather than assuming an unsubscribed one never arrives, and
the event name is a column on the ledger row so #49 can dispatch on it.

## Authentication

`createAuth(config)` in [`src/auth/`](src/auth) composes Better Auth over the four tables Reprove **adopted** rather than four it manages ([ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)). `user`, `session`, `account` and `verification` are declared in `src/db/schema.ts` beside everything else, so they share the one migration history and Better Auth runs no migration tool of its own. The Drizzle adapter is handed those table objects directly, which is what makes the sharing real rather than coincidental: it resolves every field against the object it was given.

The consequence is that Better Auth's model is a dependency of the schema, and a divergence is silent until a sign-in. `src/auth/schema.test.ts` therefore reads the expectation out of Better Auth - `auth.$context.tables`, the same model the adapter resolves against - and compares it field for field, so a version bump that adds a column fails on the pull request that bumps it rather than in production.

**These four sit outside Owner RLS and carry no Owner policy.** A User can legitimately reach several Owners, so applying Owner tenancy to authentication tables would model the relationship incorrectly. They are **classified non-tenant**, not exempted: the classification has two sets and no third, and a table in neither refuses boot. `owner` has no foreign key to any user in either direction and Reprove adds no membership relation, so one person installing on a personal account and on an organization is simply two `owner` rows with nothing joining them - `src/db/owner-independence.test.ts` measures both halves of that.

Two decisions are configuration that has to stay configured, so both are tested:

- **`account.encryptOAuthTokens` is on.** Better Auth stores OAuth tokens in plaintext by default; enabling it gives AES-256-GCM keyed from the `secret` passed in. The refresh token it protects is the six-month one.
- **A GitHub grant is asserted before it is stored.** ADR 0008 keeps a person's GitHub credential in the database on the strength of a token that expires in eight hours and a refresh token that renews it, and both come from the App's "Expire user authorization tokens" setting. Opting out changes nothing observable: the sign-in succeeds and the stored token is permanent. `assertGitHubTokenGrant()` is a pure function over the grant, wrapped around the provider's `getUserInfo` and `refreshAccessToken` - the two points a raw response from GitHub is still the response. The database hooks on `account` are the wrong seam for it, because Better Auth filters `undefined` out of the update it writes on a repeat sign-in, so the absent expiry that *is* the condition never reaches one.

Like the database surface, none of this is exported from the package root: ADR 0010 forbids `apps/control-plane` from depending on `better-auth`, so a published signature returning the instance would hand the only consumer a type it may not import.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). The supported self-hosting surface is `apps/control-plane` **as a deployable application, not as a package**. Public source, gated by every CI check, carrying **no stability promise**.

`workerProtocolSchemas` is the control-plane reference to the authoritative
schemas from `@reprove/protocol/v1`; the package does not define a second wire
shape.
