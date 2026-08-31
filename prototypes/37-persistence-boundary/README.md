# Prototype: the persistence and tenancy boundary (#37)

**Throwaway.** Not shipped code, not a package, not in the workspace. It exists so
[ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)'s six tenancy
rules could be **falsified** rather than re-argued, and it is committed as the
primary source behind
[#37](https://github.com/nick-neely/reprove/issues/37)'s resolution.

```bash
cd prototypes/37-persistence-boundary
npm install && npm run prototype     # wipes the database, brings the stack up, runs everything
```

`npm run prototype` is destructive by design and only ever touches its own
containers. Ports are `55532` (direct) and `56532` (pooled), chosen because the
obvious ones were already taken on the machine this was written on.

- `docker-compose.yml` + `pgbouncer/` - Postgres 17 behind **PgBouncer in
  transaction mode**, which is the arrangement Neon fronts its pooled endpoint
  with. The `reprove_proto_pinned` database has `pool_size = 1` so that server
  connection reuse is deterministic instead of load-dependent.
- `src/schema.ts` - the ADR 0008 entity set as Drizzle tables, plus ADR 0013's
  ingress ledger and Better Auth's four.
- `src/bootstrap.ts` - the admin half: roles, migrations, grants, `FORCE`.
- `src/runtime.ts` - `createRuntimeDb()`, the boot assertion, and `withOwner`.
- `src/ingress.ts` - ADR 0013's Run-creation critical section and the re-drive.
- `src/scenarios.ts` - drives it and prints what the database actually does.

## The seam this prototype argues for

The ticket asked which seam is highest. The answer the code settled on is
**`createRuntimeDb()` plus `withOwner()`, exercised through a real pooler**, and
the pooler is the part that was not obvious. Every rule in ADR 0008 can be shown
correct against a direct connection and still be wrong in production, because
three of the six failures below only exist on a pooled one.

## What it demonstrates

Each scenario exists because it settled something.

1. **Bootstrap from clean, admin-only.** The runtime role is created as SQL with
   `nosuperuser nobypassrls` spelled out, owns no table, and cannot `CREATE` in
   the schema - so it can never become the owner of a table and inherit that
   owner's RLS exemption.
2. **The boot assertion refuses rather than degrades**, from inside the
   connection factory, so there is no path to a client that skips it. Seven
   checks, six catalog and one behavioural.
3. **Two tenants, identical code.** A `SELECT` with no `WHERE owner_id` returns
   one tenant's rows; an `INSERT` with another tenant's id is rejected by
   `WITH CHECK`.
4. **The pooled-endpoint leak, reproduced.** A bare `SET` outlives its client and
   the next client inherits the tenant, with **no error raised anywhere**. The
   same code through `withOwner` cannot leak. This is rule 2, shown rather than
   asserted.
5. **No tenant context is zero rows**, not an error and not everything.
6. **The bootstrap circularity**, on the Worker credential path that has no
   natural Owner locator: a forged locator only changes whose lookup returns
   nothing.
7. **`BYPASSRLS` reads every tenant silently**, and the factory refuses it.
8. **Drift refuses to serve** in three shapes: `FORCE` removed, an unclassified
   table, and a deployment behind its migration journal.
9. **A GitHub event creates exactly one Run**, including the redelivered-GUID
   no-op, ADR 0013's T0-T3 interleaving run concurrently for real, the contended
   re-drive, cancellation on close, and the partial unique index.
10. **The Better Auth seam**: same migration history, outside Owner RLS, no
    foreign key to `owner` in either direction, and both token-expiry columns.

## What it found that the ADRs do not say

Four things, in descending order of how much they would have cost to discover later.

**`current_setting(...)::bigint` in a policy is a latent outage behind a pooler.**
`RESET ALL` and PgBouncer's `DISCARD ALL` do not remove a custom GUC - they set it
to the **empty string**. `''::bigint` then raises `invalid input syntax for type
bigint: ""` *from inside the policy*, so the table stops being deniable and starts
being unqueryable. The predicate must be
`nullif(current_setting('app.owner_id', true), '')::bigint`. The bare cast is
correct on a direct connection and fails only when pooled, which is the worst
possible place to learn it. This prototype hit it by accident.

**`SET LOCAL` cannot take a bind parameter.** Postgres will not bind into a `SET`,
so the literal `SET LOCAL app.owner_id = ...` that ADR 0008 writes forces string
interpolation of a value arriving from a webhook. `set_config('app.owner_id', $1,
true)` is the parameterized equivalent with identical transaction scoping, and is
what `withOwner` uses.

**Drizzle cannot express `FORCE ROW LEVEL SECURITY`, and the RLS API is not the
one the docs describe.** `drizzle-kit generate` emits `ENABLE ROW LEVEL SECURITY`
and the policies but never `FORCE`, so forcing belongs in a
`generate --custom` migration - which means "every tenant table is forced" is a
property nothing enforces at authoring time, and the boot assertion is the only
thing standing between a new table and an unforced one. Separately:
`drizzle-orm@latest` is `0.45.2` and exposes **`.enableRLS()`**, while
`pgTable.withRLS()` - the form the published documentation shows and ADR 0008
names - exists only on the unreleased `1.0.0-rc` line. Better Auth `1.7.2`
independently requires `drizzle-orm >= 0.45.2`, so the floor is not ours to
choose.

**Policies name the runtime role, so role creation must precede migrations.**
`CREATE POLICY ... TO "reprove_runtime"` fails if the role does not exist yet.
`bootstrap` and `migrate` are therefore ordered, not independent commands.

## What it deliberately does not contain

- **Anything Neon-specific.** The database is local Postgres by decision. That
  the pooler hazard reproduces is a property of PgBouncer in transaction mode,
  not evidence about Neon's build or settings; and `neon_superuser` carrying
  `BYPASSRLS` is reproduced by creating such a role by hand, which proves the
  assertion catches the *shape* rather than that Neon hands you that shape. Both
  remain research facts rather than demonstrated ones.
- **Workflow dispatch, Worker claim, and Result Acceptance.** Those are
  [#38](https://github.com/nick-neely/reprove/issues/38) and
  [#39](https://github.com/nick-neely/reprove/issues/39).
- **Retention.** `content_purged_at` exists; no purge job does.
- **Any dashboard or product authentication flow.** Better Auth appears as a
  schema and a boundary, not as a running auth server.
- **Real HTTP, HMAC verification, or Octokit.** Canonical pull request state is
  injected, which is the only way T0-T3 is reproducible on demand.
