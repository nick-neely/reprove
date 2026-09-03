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

**`bootstrap` runs before `migrate`, and the two are not interchangeable.** Every generated migration carries `CREATE POLICY ... TO "reprove_runtime"`, which fails outright if the role does not exist yet, so `migrate` refuses rather than failing halfway through. `bootstrap` provisions the restricted role and the privileges the migrations hand it, and creates no table; re-running it after a migration is safe and is how privileges get repaired.

Both read the admin connection string from `REPROVE_DATABASE_ADMIN_URL`, and `bootstrap` reads the runtime role's password from `REPROVE_DATABASE_RUNTIME_PASSWORD`. Neither is a command-line argument, because argv leaks a secret into every process listing on the host.

`createRuntimeDb()` opens the runtime connection, runs rule 6's seven assertions, and either returns a client or throws a `BootRefusalError` naming every check that failed. There is no flag and no bypass. All Owner-scoped access goes through `withOwner(ownerId, tx => ...)`, which sets the tenant context with `set_config('app.owner_id', $1, true)` - parameterized, and transaction-local, because a bare `SET` released to a pooler in transaction mode is inherited by the next client.

Local development and CI run the stack in [`tools/db/`](../../tools/db): `pnpm db:up` brings up Postgres 17 and PgBouncer in transaction mode, and `pnpm db:down` removes them. Docker is the only prerequisite. See [CONTRIBUTING.md](../../CONTRIBUTING.md#database).

### The published surface names no Drizzle or `pg` type

ADR 0010's matrix forbids `apps/control-plane` - the only consumer - from depending on `drizzle-orm` or a Postgres driver, so nothing this package exports names a type from either. That is ADR 0005's forbidden-type boundary applied to the database: an upstream type leaks through an exported signature even when the importer never names the package.

The schema, the classification, `createRuntimeDb()` and its tenant transaction therefore stay inside the package, reachable from `./db/index.js` by the control-plane code that owns them. Composition reaches the app as `createControlPlane(config)`.

### The migration folder is a runtime asset

`drizzle/` is in the package's `files` list and is resolved relative to the module rather than to `process.cwd()`, because the boot assertion joins the hashes Drizzle stored against the files that produced them ([ADR 0017](../../docs/adr/0017-authoring-time-tenancy-boundary.md)). Migration history is **append-only**: `PgDialect.migrate` writes a hash it never reads, so an edited applied migration is silently ignored and every existing database keeps the old DDL.

`0000_initial_schema` is drizzle-kit generated from `src/db/schema.ts`. `0001_force_row_level_security` is a `generate --custom` migration carrying the one statement Drizzle cannot express, in a canonical grammar:

```sql
-- reprove:force-row-level-security
ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;
```

**That grammar is generator-owned.** [#46](https://github.com/nick-neely/reprove/issues/46) builds the generator that derives these statements from the classification and appends them as a delta; hand-authored migrations may not touch the tenant boundary at all. The file above is written in the shape the generator emits so that #46 never has to rewrite it, which it could not do safely - a rewritten migration is correct in the repository and inert in every database already carrying it.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). The supported self-hosting surface is `apps/control-plane` **as a deployable application, not as a package**. Public source, gated by every CI check, carrying **no stability promise**.

`workerProtocolSchemas` is the control-plane reference to the authoritative
schemas from `@reprove/protocol/v1`; the package does not define a second wire
shape.
