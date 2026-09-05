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
