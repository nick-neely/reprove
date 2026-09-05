# What forces a tenant table, and where the failure lands

[ADR 0008](0008-persistence-tenancy-and-retention.md) made Postgres, not discipline, the tenant
boundary, and made rule 6 - the boot assertion - the thing that keeps the other five falsifiable.
It also recorded the hole it could not close: Drizzle emits `ENABLE ROW LEVEL SECURITY` and the
policies but never `FORCE`, so nothing at authoring time guarantees a newly added Owner-scoped
table is forced. The boot assertion was the only backstop, and a boot assertion refuses in a
deployment rather than failing on the pull request that introduced the defect.

[ADR 0014](0014-workflow-orchestration-seam.md) then scoped that assertion, because a
database-wide check would refuse boot on a deployment co-located with Vercel Workflow. This ADR
decides the authoring-time boundary, and corrects that scoping, which removed the property it was
protecting.

Every claim below about what Drizzle does was measured against `drizzle-orm@0.45.2` and
`drizzle-kit@0.31.10` rather than read from documentation, and two of the decisions exist only
because the measurement contradicted what this repository already had written down.

## The scoping correction was a tautology

ADR 0014's correction reads: the assertion covers *"every table Reprove's own migration manifest
manages"*, and requires that each *"appears in exactly one of the two declared sets"*. But the
manifest, as the prototype implemented it, **was** those two declared sets. So the check could
only ever catch a declared table that was absent from the database. The direction it existed to
catch - a table present in the database that nobody classified - had become unrepresentable.

The correction conflated two questions that have different answers. *Which tables must be
classified* is a question about Reprove's own inventory. *Which tables the assertion may refuse
over* is a question about the boundary with a neighbour. ADR 0014 answered the second correctly
and, in the same move, silently answered the first with a tautology.

## The managed universe is the schema module, enumerated independently

The manifest is **every `pgTable` the schema module exports or adopts**, Better Auth's four
included. It is enumerable at authoring time and at boot from the same import, and drizzle-kit
generates every migration from it, so it is by construction the set Reprove's migrations manage.

```text
MANAGED_TABLES  = every pgTable exported or adopted by the schema module
MANAGED_TABLES == TENANT_TABLES ∪ NON_TENANT_TABLES
TENANT_TABLES  ∩  NON_TENANT_TABLES == ∅
```

That closes the tautology, because the universe is now derived from a source the classification
does not control. A table added to the schema module and left out of both sets fails, which is
the property ADR 0008 promised and the corrected text had quietly dropped.

**A full scan of `public` is not restored.** ADR 0014's boundary is right for a stronger reason
than the measurement that prompted it: Reprove must refuse over its own malformed boundary, not
because another component legitimately placed a table beside it. That Workflow happens to use
`workflow`, `workflow_drizzle` and `graphile_worker` today is a fact about Workflow, not a
guarantee Reprove should build on.

A dedicated `reprove` schema would make the boundary structural rather than conventional and is
the stronger long-term answer. It is **deliberately not taken in Phase 0**: it moves Better
Auth's adopted tables, changes `search_path`, and buys isolation that the managed-universe rule
already provides at the only point where it is checked.

## Classification is declared; everything else is derived from it

Policy presence is a computable predicate - `getTableConfig(t).policies` returns each policy's
name, `to` role and `using`/`withCheck` SQL - so the two declared arrays could be deleted and the
classification derived. **They are not**, and the reason is what derivation would cost:

```text
derived:   new Owner-scoped table, tenant policy forgotten   ─┐
           deliberately non-tenant table                     ─┴─ indistinguishable
```

The most dangerous authoring mistake in this design would become the safe case. ADR 0008 rejected
an allowlist of RLS-exempt tables because *"an allowlist is precisely the thing that grows
quietly"*; deriving the classification would not shrink that allowlist, it would make it
invisible. Classification is a **human security decision** and stays a reviewable declaration.
Drizzle's metadata is then used to prove the implementation agrees with the declaration, in both
directions.

Classification names **table objects**, not string literals, with SQL names derived through
`getTableConfig()`. A rename in the schema module cannot drift from the classification, because
there is no second spelling of the name to update.

The dependency runs one way only:

```text
human declares tenancy → classification → policy cross-check → generated FORCE DDL
```

There is exactly one correct mechanical consequence of a table being tenant-scoped, so no human
restates it in migration SQL. Forcing and classification are two concepts, not one, joined by
generation rather than by a second list.

## The runtime-effective policy set is exact, not a superset

Postgres combines permissive policies by OR, so `USING (true)` sitting *beside* a correct tenant
policy is a full tenant bypass that every presence check passes. The assertion is therefore set
equality, not membership: for a tenant table the runtime-effective policy set is **exactly** the
canonical `tenantPolicy()` policy, and for a non-tenant table it is empty.

The comparison is against **what the pinned dialect currently renders**, not a frozen SQL literal.
That preserves ADR 0008's hardest-won fix - `nullif(current_setting('app.owner_id', true), '')`
rather than a bare `::bigint` cast, which is correct on every unpooled connection and an outage
behind PgBouncer after a reset - without fossilising its spelling. A hand-rolled policy carrying
that exact bug fails, where a "has a policy on the runtime role" check would pass it.

The property splits across two layers, and neither half is sufficient:

| layer | sees | asserts |
| --- | --- | --- |
| authoring, from the schema module | declared policies | the declared set is exactly the canonical policy, or empty |
| boot, from `pg_policies` | `roles`, including `PUBLIC` and inherited roles | nothing else applies to the runtime role |

Role inheritance and `PUBLIC` are database facts with no representation in the schema module, so
only the catalog can see them. A table needing a different predicate later declares that exception
in its classification, where it is reviewable intent rather than a silent divergence.

**`enableRLS` is not a usable signal and must not be read as one.** `getTableConfig(t).enableRLS`
and the snapshot's `isRLSEnabled` reflect only an explicit `.enableRLS()` call. A table carrying a
policy reads `false` in both while drizzle-kit still emits `ALTER TABLE … ENABLE ROW LEVEL
SECURITY` for it. The implicit enablement is real in the generated SQL and absent from the object
graph, which makes either field a plausible-looking source for a check that would be wrong.

## Forcing is generated, appended, and never authored by hand

`FORCE ROW LEVEL SECURITY` has **no representation anywhere** in `drizzle-orm@0.45.2` or
`drizzle-kit@0.31.10` - not a builder method, not a config field, not a snapshot field.
`PgPolicyConfig` carries only `as | for | to | using | withCheck`. This is a measured negative
across both packages' `dist` and `.d.ts`, not an inference from the documentation.

So a generator derives the statements from the classification and emits them into a
`drizzle-kit generate --custom` migration, which is a first-class journal entry with a chained
snapshot, indistinguishable in shape from a generated one. It emits a **delta**, symmetric in both
directions:

```text
tenant     && !forced  →  ALTER TABLE … FORCE ROW LEVEL SECURITY
non-tenant &&  forced  →  ALTER TABLE … NO FORCE ROW LEVEL SECURITY
already matching       →  nothing
```

A tenant → non-tenant reclassification is security-significant, and it is safe here because the
generator never runs on its own: a failing check tells the developer to invoke it, and both the
classification change and the generated `NO FORCE` appear in the same pull request.

**The generator never rewrites a migration it already emitted**, and the reason is measured in the
next section rather than stylistic.

This replaces ADR 0008's statement that forcing *"lives in hand-written migration SQL"*, and it
replaces the prototype's `grantAndForce()` as the mechanism. Provisioning-time forcing cannot be
the only path: a database that already exists gets a new table's policy from a migration and would
never get its `FORCE`.

## The generator owns a grammar; hand-authored SQL may not touch the boundary

Effective final state is the property, not textual occurrence - `0010 FORCE` followed by
`0020 NO FORCE` must fail. Establishing it does **not** require interpreting arbitrary SQL, because
the tenant boundary is closed to hand-authored migrations:

```text
drizzle generation      CREATE TABLE, ENABLE RLS, CREATE/DROP POLICY, from schema metadata
FORCE generator         FORCE / NO FORCE only, in one canonical marked form
hand-authored custom    neither of the above
```

Forbidden in a hand-authored migration: `CREATE TABLE`, `ALTER TABLE … ENABLE`/`DISABLE ROW LEVEL
SECURITY`, `ALTER TABLE … FORCE`/`NO FORCE ROW LEVEL SECURITY`, and `CREATE`/`ALTER`/`DROP POLICY`.
This generalises "may not introduce a table" to "may not touch the tenant boundary", which closes
`DROP POLICY` and `DISABLE ROW LEVEL SECURITY` - the same hole in a different doorway.

The generator emits a canonical form carrying a generator marker, and the verifier **rejects a
generator-owned migration whose contents do not conform to that grammar exactly**, so a second
arbitrary statement cannot ride into a file that claims to be generated.

> **Amended by [issue #46](https://github.com/nick-neely/reprove/issues/46), 2026-09-05:** this ADR
> names three authors and does not say how a reader tells them apart, and the implementation found
> that the answer is **measured, not declared**, because drizzle-kit marks nothing. `generate`
> writes a snapshot reflecting the new schema; `generate --custom` writes its parent's content back
> out unchanged apart from the snapshot's own identity. So a migration whose snapshot did not
> advance is a custom one, and the marker separates the generator's from a human's. That is what
> lets the denylist apply to a hand-authored migration without also refusing the `CREATE TABLE` in
> the drizzle-generated file it is the whole point of.
>
> Attribution alone would then have left a hole, and the amendment closes it rather than recording
> it. A drizzle-attributed file is *allowed* to carry `CREATE POLICY` and `ENABLE ROW LEVEL
> SECURITY`; nothing in the grammar could say whether the statements in front of it are the ones the
> schema module asked for, so a `DROP POLICY` or a `DISABLE ROW LEVEL SECURITY` edited into one
> passed. **The effective-state walk therefore covers all three of the boundary's facts, not just
> `FORCE`**: the policy set and the RLS enablement each table is left with at the end of the journal
> are compared against what the pinned dialect renders for the classification, over every migration
> whoever wrote it. A boundary statement the walk cannot parse is a failure rather than a skip. What
> remains outside authoring time is unchanged from "What this deliberately does not claim" below:
> only the catalog assertion sees what a database actually has. A generated file is still scanned
> for `FORCE`, which drizzle-kit cannot emit and whose presence therefore means the file was edited.

`effectiveForceState(table)` is then a walk of the journal in order over statements Reprove itself
owns the shape of, rather than regex-driven SQL interpretation. The denylist is the argument; the
scan is the measurement. ADR 0008 already took this posture when it kept one behavioural check
beside six catalog ones, for the same reason: an argument that is never measured is what rule 6
exists to distrust.

The result is three independent representations of one decision, cross-checked pairwise:

```text
schema metadata   →  canonical policy shape
migration history →  effective FORCE state
live catalog      →  what actually deployed
```

## Drizzle does not protect migration history; Reprove does

`PgDialect.migrate` reads only the most recent `created_at` from `__drizzle_migrations` and applies
every migration whose `folderMillis` exceeds it. It writes a `hash` column **and never reads it**.

```text
applied migration edited
  → Drizzle does not compare the stored hash
  → does not reapply
  → every existing database silently retains the old DDL, indefinitely
```

No error, no warning, no drift signal. `drizzle-kit check` does not catch it either: it validates
snapshot version, well-formedness and parent-id collisions, with no database connection and no
schema-versus-database comparison.

This is why append-only is a **hard invariant** rather than a convention, and why a generator that
rewrote its own prior output would be actively harmful - correct in the repository and inert in
every database already carrying it.

Reprove closes it at both ends:

**At authoring time**, a Git-aware verifier compares the migration directory against the merge-base
with the pull request's base ref, and against the push event's *before* SHA on a push to `main` - a
push may carry several commits, so `HEAD^` is wrong. A journaled migration file may not be
modified, deleted, reordered or replaced; new entries append only. The verifier **fails closed**: if
it cannot resolve its baseline it fails with an instruction to fetch the base branch history and
rerun, and never skips the check. A shallow clone therefore produces an actionable failure rather
than a green run that proved nothing.

**At boot**, the stored hash stops being dead data. `readMigrationFiles`, exported from
`drizzle-orm/migrator`, computes `hash = sha256(entire raw .sql file text)` with
`folderMillis = journalEntry.when`, which is exactly what `migrate()` writes as `created_at`. So
the check is a join on Drizzle's own primitives, not a reimplementation:

```text
readMigrationFiles({ migrationsFolder })  →  [{ folderMillis, hash }]
select created_at, hash from drizzle.__drizzle_migrations
join on created_at = folderMillis
```

**This does not add an eighth check; it strengthens rule 6's sixth.** The journal comparison
already there becomes strictly stronger: fewer applied rows than journal entries still names the
pending tags, a hash mismatch catches an edited applied migration, and an applied row with no
journal entry catches a database ahead of the repository. The runtime role already holds `select`
on the `drizzle` schema.

One consequence follows and is load-bearing rather than incidental: **the migration folder is a
runtime asset of `@reprove/control-plane`**, resolved relative to the package and required to
survive bundling. The prototype reads `./drizzle/meta/_journal.json` relative to `process.cwd()`,
which is already fragile and would break in the deployed Next.js application.

## Where the checks bind, and what CI gains

Nothing here introduces a gate. Both new verifiers are owning layers inside the `pnpm verify`
sequence [#31](https://github.com/nick-neely/reprove/issues/31) settled, and the required check
set is **unchanged at exactly two**, `verify` and `dependency-review`.

| check | home | proves |
| --- | --- | --- |
| classification completeness, policy set equality, effective FORCE state, generator grammar | ordinary Vitest in `@reprove/control-plane` | the committed schema and migrations intend the boundary |
| migration-history append-only | `tools/verify-migrations.mjs` | history was not rewritten |
| catalog truth | ADR 0016's scenario, via `createRuntimeDb()` | the boundary actually deployed |

The schema checks are **package behaviour** and ride the existing `vitest run` with no new root
step. History immutability is a **repository-history property**, not package behaviour, so it gets
a small Git-aware verifier of its own. Neither belongs in `tools/verify-workspace.mjs`, whose
charter [#29](https://github.com/nick-neely/reprove/issues/29) drew deliberately tight around ADR
0010's package-graph invariants and one dependency matrix.

#31's `verify` job gains `fetch-depth: 0`. Fetching only the base ref is **not** claimed
sufficient: Git may still lack the head-side ancestry needed to establish a merge-base, and for a
repository this size correctness is worth more than optimising a transfer that is not yet a cost.
Revisit when the history is large enough for the fetch to show up in run time.

Both layers therefore fail the same existing `verify` check on a pull request, which is the
two-layer property this ADR exists to produce: drift fails fast and statically at authoring time,
and the assembled application against a migrated pooled Postgres proves it actually landed.

## What was rejected

**Deriving classification from policy presence** - collapses "forgot the policy" into "deliberately
non-tenant". Rejected above.

**A Postgres event trigger forcing RLS on `CREATE TABLE`** - `CREATE EVENT TRIGGER` is superuser-only.
Neon grants it through `neon_superuser`, which carries `BYPASSRLS`, so the role able to install the
guardrail is a role for which forcing is moot, and rule 4 exists to keep that role off the runtime
path. It also fires inside the target database at DDL time, which is not the pull request. Wrong
layer, wrong privilege, wrong moment.

**Atlas** - the strongest external option: it models `row_security { enabled, enforced }` and ships
a built-in lint for "RLS enabled but not enforced", which is precisely this rule. Rejected because
it reaches a Drizzle migration directory only by inspecting a database it has already been applied
to, and because adopting it means a second schema and migration model - a Go binary and an HCL
desired state beside Drizzle's - to express one fact Drizzle cannot. The cost is a permanent second
source of truth; the benefit is a check that fits in a Vitest file over metadata already generated.

**squawk** has no RLS rule and no custom-rule mechanism. **pgrls** has exactly the rule (SEC002) and
is a 26-star beta, cited here as an existence proof rather than a dependency.

**`drizzle-kit check`** - journal integrity only, as measured. Not a candidate.

## What this deliberately does not claim

- **The static checks prove intent, not deployment.** They prove the committed schema and migrations
  *say* the boundary is closed. Only the catalog assertion sees what a database actually has.
- **Nothing here defends against an operator with admin credentials.** A DBA running `NO FORCE`, a
  restored snapshot, or a role granted `BYPASSRLS` out of band is caught at boot, if at all, and
  never at authoring time.
- **The measurements are local.** `drizzle-kit` behaviour, the migrator's hash handling and the
  generated SQL were measured on local Postgres 17 and against the installed packages, not on Neon.
  The packages are the same; the inference that Neon behaves identically is stated, not proven.
- **The generator has no prior art here.** The FORCE generator and its grammar are Reprove's own,
  written because no established linter expresses the rule against a Drizzle migration directory.

## Consequences

- **ADR 0008 is corrected in place, twice.** The manifest becomes the schema module's `pgTable` set
  and the assertion ranges over that rather than over `public`, removing the tautology ADR 0014
  introduced. Its statement that forcing "lives in hand-written migration SQL" is replaced by the
  generated append-only mechanism. Rule 6 stays at seven checks; the migration-journal check
  becomes a hash comparison and the policy check becomes set equality.
- **ADR 0014's scoping correction survives, with its reasoning replaced.** The boundary it drew is
  kept for the stronger reason - Reprove refuses over its own tables - rather than because
  Workflow's schemas happen not to collide.
- **ADR 0010 gains a runtime asset.** `@reprove/control-plane` ships its migration folder and
  resolves it relative to the package.
- **#31's `verify` job gains `fetch-depth: 0`** and a second root-sequenced verifier. The required
  check set is unchanged at two.
- **`CONTEXT.md` is unchanged.** No noun is added: this is verification machinery, and `Owner`,
  `Repository` and the tenancy terms already carry every meaning it relies on.
- **The map's last open decision closes.** What remains before implementation is the tracer-bullet
  handoff, not another decision.
