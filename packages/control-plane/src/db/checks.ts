/**
 * Rule 6 of [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md): the
 * boot assertion that makes the other five rules falsifiable.
 *
 * Seven checks, six read from the catalog and one behavioural, **all through the
 * runtime connection** - a check run on the admin connection would measure a
 * privilege set the application never uses. Rule 4 fails silently, which is the
 * class ADR 0004 bans outright, so without this the strongest guarantee in the
 * schema is one connection-string typo away from being decorative.
 *
 * Seven is the count ADR 0008 fixed and ADR 0017 kept. A gap the checks did not
 * cover is closed by strengthening one of them rather than by adding an eighth;
 * {@link checkPrivilegeReach} is the second one so widened.
 *
 * The behavioural check is not redundant with the other six. Every catalog flag
 * can be correct while the predicate is wrong; that is exactly what the bare
 * `::bigint` cast was, and the behavioural check is what caught it.
 */
import { is } from "drizzle-orm";
import type { PgPolicyToOption, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig, PgDialect, PgRole } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import type { Classification } from "./classification.js";
import { CLASSIFICATION, tableName, tableNames } from "./classification.js";
import { readCommittedMigrations } from "./migrations.js";
import { normalizePredicate } from "./predicate.js";
import {
  REACHING_TABLE_PRIVILEGES,
  WITHHELD_TABLE_PRIVILEGES,
} from "./privileges.js";
import type { CheckName, CheckResult } from "./refusal.js";
import { BootRefusalError } from "./refusal.js";
import { RUNTIME_ROLE } from "./roles.js";
import { ownerContext } from "./schema.js";

const DIALECT = new PgDialect();

/**
 * The tenant predicate's Owner-context half, as SQL.
 *
 * Rendered from the fragment the policies are built out of rather than spelled
 * again here, so there is exactly one definition of it in the package. ADR 0008
 * requires the behavioural check to evaluate the **same expression** the
 * policies use; a second spelling would satisfy that on the day it was written
 * and stop satisfying it the day one of them changed.
 */
const OWNER_CONTEXT = DIALECT.sqlToQuery(ownerContext).sql;

/** `select` against a relation that does not exist. */
const UNDEFINED_TABLE = "42P01";

/** A policy as either the schema module declares it or the catalog holds it. */
interface Policy {
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  readonly roles: readonly string[];
  readonly using: string;
  readonly withCheck: string;
}

const describePolicy = (policy: Policy): string =>
  `${policy.name} ${policy.permissive ? "permissive" : "restrictive"} for ${policy.command} to ${[...policy.roles].toSorted().join(",")} using ${policy.using} with check ${policy.withCheck}`;

const samePolicy = (a: Policy, b: Policy): boolean =>
  describePolicy(a) === describePolicy(b);

/** Everything about a policy except the two predicates, which are reduced. */
type RawPolicy = Omit<Policy, "using" | "withCheck"> & {
  readonly using: string;
  readonly withCheck: string;
};

/**
 * One policy with both predicates reduced to comparable form, or the reason
 * neither side can be compared.
 *
 * Every policy that reaches {@link samePolicy}, declared or live, is built here,
 * which is what makes the connective refusal unskippable: the comparison has no
 * other way to obtain a `Policy`.
 *
 * @param table The SQL name of the table the policy is attached to.
 * @param raw The policy as its own side spells it.
 * @returns The comparable policy, or the connective that refused it.
 */
const comparablePolicy = (
  table: string,
  raw: RawPolicy
): { policy: Policy } | { problem: string } => {
  const refused = (side: string, connective: string): { problem: string } => ({
    problem: `${table}'s policy ${raw.name} has \`${connective}\` in its ${side} expression; a predicate the boot assertion can compare carries no boolean connective, because the comparison drops parentheses and grouping changes what a connective means`,
  });

  const using = normalizePredicate(raw.using, table);
  if ("connective" in using) {
    return refused("using", using.connective);
  }
  const withCheck = normalizePredicate(raw.withCheck, table);
  if ("connective" in withCheck) {
    return refused("with-check", withCheck.connective);
  }
  return {
    policy: {
      ...raw,
      using: using.normalized,
      withCheck: withCheck.normalized,
    },
  };
};

/**
 * The role names a declared policy applies to. Drizzle accepts a role object, a
 * role name, or a nested list of either, so all of them are flattened here
 * rather than at the one call site that cares.
 */
const declaredRoles = (to: PgPolicyToOption | undefined): string[] => {
  if (to === undefined) {
    return [];
  }
  if (Array.isArray(to)) {
    return to.flatMap((entry) => declaredRoles(entry));
  }
  return [is(to, PgRole) ? to.name : to];
};

/**
 * The canonical policy a tenant table declares, rendered by the pinned dialect
 * rather than compared against a frozen SQL literal.
 *
 * That is what preserves ADR 0008's hardest-won fix - `nullif(...)` rather than
 * the bare cast, which is correct on every unpooled connection and an outage
 * behind PgBouncer after a reset - without fossilising its spelling. A
 * hand-rolled policy carrying that exact bug fails here, where a "has a policy
 * on the runtime role" check would pass it.
 *
 * @param table A tenant table.
 * @returns The single declared policy, or the reason there is not exactly one.
 */
const declaredPolicy = (
  table: PgTable
): { policy: Policy } | { problem: string } => {
  const name = tableName(table);
  const [policy, ...extra] = getTableConfig(table).policies;
  if (policy === undefined || extra.length > 0) {
    return {
      problem: `${name} declares ${extra.length + (policy ? 1 : 0)} policies; a tenant table declares exactly the canonical one`,
    };
  }
  if (!(policy.using && policy.withCheck)) {
    return {
      problem: `${name}'s policy declares no using or with-check expression`,
    };
  }
  const roles = declaredRoles(policy.to);
  const [role, ...otherRoles] = roles;
  if (role !== RUNTIME_ROLE || otherRoles.length > 0) {
    return {
      problem: `${name}'s policy applies to ${roles.join(", ") || "no role"} rather than to ${RUNTIME_ROLE} alone`,
    };
  }
  return comparablePolicy(name, {
    name: policy.name,
    permissive: (policy.as ?? "permissive") === "permissive",
    command: (policy.for ?? "all").toLowerCase(),
    roles,
    using: DIALECT.sqlToQuery(policy.using).sql,
    withCheck: DIALECT.sqlToQuery(policy.withCheck).sql,
  });
};

/** A Postgres identifier, quoted for the few places a bind parameter cannot go. */
const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

/** The same, for a string literal. */
const quoteLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

interface CatalogPolicyRow {
  tablename: string;
  policyname: string;
  permissive: string;
  cmd: string;
  roles: string[];
  qual: string | null;
  with_check: string | null;
}

/**
 * Every policy in `public` that applies to the runtime role, on the tables
 * given.
 *
 * `pg_has_role(..., 'usage')` is what makes this see more than a name match: a
 * policy granted to `PUBLIC`, or to a role the runtime role inherits, applies
 * just as much and has no representation in the schema module. Only the catalog
 * can see either.
 *
 * `usage` rather than `member`, and the difference was measured rather than
 * inferred. Postgres 16 records `INHERIT` per grant, and a policy applies only
 * through an inheritable one: the same `GRANT ... WITH INHERIT FALSE` leaves the
 * policy inert. `usage` reports exactly that, where `member` would report a
 * membership that grants nothing and refuse a boot that was fine.
 */
const applicablePolicies = async (
  pool: Pool,
  tables: string[]
): Promise<CatalogPolicyRow[]> => {
  const { rows } = await pool.query<CatalogPolicyRow>(
    `select p.tablename, p.policyname, p.permissive, p.cmd,
            p.roles::text[] as roles, p.qual, p.with_check
       from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = any($1::text[])
        and exists (
          select 1 from unnest(p.roles::text[]) as r
           where r = 'public' or pg_has_role(current_user, r::name, 'usage')
        )`,
    [tables]
  );
  return rows;
};

const fromCatalog = (
  row: CatalogPolicyRow
): { policy: Policy } | { problem: string } =>
  comparablePolicy(row.tablename, {
    name: row.policyname,
    permissive: row.permissive.toLowerCase() === "permissive",
    command: row.cmd.toLowerCase(),
    roles: row.roles,
    using: row.qual ?? "",
    withCheck: row.with_check ?? "",
  });

// --- the seven checks --------------------------------------------------------

/**
 * Rule 4, and the one that fails **silently**, which is why it is checked at
 * all. `neon_superuser` carries `BYPASSRLS` and is granted to every role created
 * through a provider console: connect as one of those and every policy is
 * ignored with no error, warning or notice raised anywhere.
 */
const checkRolePrivileges = async (pool: Pool): Promise<string | null> => {
  const { rows } = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user"
  );
  const [role] = rows;
  if (!role) {
    return "current_user has no pg_roles row";
  }
  const flags = [
    role.rolsuper ? "SUPERUSER" : null,
    role.rolbypassrls ? "BYPASSRLS" : null,
  ].filter((flag) => flag !== null);
  return flags.length > 0
    ? `${role.rolname} carries ${flags.join(" + ")}, so every policy would be ignored with no error`
    : null;
};

/** The relation kinds a privilege can be granted on and rows can be read from. */
const READABLE_RELKINDS = "{r,p,v,m,f}";

/**
 * How far the runtime role can reach, which is meant to be exactly the managed
 * tables and exactly four verbs on them.
 *
 * This is ADR 0008's "owns no table", strengthened rather than joined by an
 * eighth check, because the original wording measured one corner of one
 * property. Three clauses now, and each closes something the `relkind = 'r'`
 * filter let through:
 *
 * 1. **The role owns no relation of any kind in `public`.** An owner is exempt
 *    from its own RLS unless `FORCE` is set, and that is as true of a view or a
 *    materialized view as of a table.
 * 2. **It holds no `TRUNCATE`, `REFERENCES` or `TRIGGER` on a managed table.**
 *    `TRUNCATE` ignores row-level security outright, so a role holding it can
 *    empty another Owner's table through a boundary that denies it every row.
 *    No policy check sees this, because it is not a policy.
 * 3. **It can reach no relation in `public` outside the managed set.** This is
 *    the view bypass: a view runs as *its owner* unless it carries
 *    `security_invoker`, so an admin-owned view over a tenant table returns
 *    every Owner's rows and carries no policy of its own to fail. Nothing that
 *    filtered on `relkind = 'r'` could ever see it.
 *
 * Clause 3 is stated as reach rather than as existence, which is what keeps it
 * neighbour-safe: a relation a co-located component placed in `public` and the
 * runtime role cannot touch is not Reprove's boundary failing. Only a relation
 * the role can actually read or write refuses the boot.
 */
const checkPrivilegeReach = async (
  pool: Pool,
  classification: Classification
): Promise<string | null> => {
  const managed = tableNames(classification.managed);

  const owned = await pool.query<{ relname: string; relkind: string }>(
    `select c.relname, c.relkind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles o on o.oid = c.relowner
      where n.nspname = 'public' and o.rolname = current_user`
  );

  const excess = await pool.query<{ relname: string; privilege: string }>(
    `select c.relname, p.privilege from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join unnest($2::text[]) as p(privilege)
      where n.nspname = 'public'
        and c.relname = any($1::text[])
        and has_table_privilege(current_user, c.oid, p.privilege)
      order by c.relname, p.privilege`,
    [managed, WITHHELD_TABLE_PRIVILEGES]
  );

  // Relations the role owns are excluded, because clause 1 already names them
  // and an owner reaches everything it owns by definition.
  const reachable = await pool.query<{ relname: string; relkind: string }>(
    `select c.relname, c.relkind from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles o on o.oid = c.relowner
      where n.nspname = 'public'
        and c.relkind = any($3::"char"[])
        and not (c.relname = any($1::text[]))
        and o.rolname <> current_user
        and exists (
          select 1 from unnest($2::text[]) as p(privilege)
           where has_table_privilege(current_user, c.oid, p.privilege)
        )
      order by c.relname`,
    [managed, REACHING_TABLE_PRIVILEGES, READABLE_RELKINDS]
  );

  const problems = [
    owned.rows.length > 0
      ? `owns ${owned.rows.map((row) => `${row.relname} (relkind ${row.relkind})`).join(", ")} in public, and an owner is exempt from its own RLS unless FORCE is set`
      : null,
    excess.rows.length > 0
      ? `holds ${excess.rows.map((row) => `${row.privilege} on ${row.relname}`).join(", ")}, and TRUNCATE in particular ignores row-level security`
      : null,
    reachable.rows.length > 0
      ? `reaches ${reachable.rows.map((row) => `${row.relname} (relkind ${row.relkind})`).join(", ")} in public, which the schema module does not manage and the boundary was therefore never measured over`
      : null,
  ].filter((problem) => problem !== null);

  return problems.length > 0 ? problems.join("; ") : null;
};

/**
 * The check that keeps the Better Auth exemption from becoming the allowlist ADR
 * 0008 rejected. It is not "these four tables are exempt" but "every table the
 * schema module manages appears in exactly one of the two declared sets", so a
 * table nobody classified refuses boot.
 *
 * Tables outside the manifest are ignored on purpose. ADR 0010 permits Vercel
 * Workflow to share the same Postgres server; refusing over a neighbour's table
 * would be a production refusal caused by a correctly-behaving neighbour.
 */
const checkClassification = async (
  pool: Pool,
  classification: Classification
): Promise<string | null> => {
  const managed = tableNames(classification.managed);
  const tenant = new Set(tableNames(classification.tenant));
  const nonTenant = new Set(tableNames(classification.nonTenant));

  const unclassified = managed.filter(
    (name) => !(tenant.has(name) || nonTenant.has(name))
  );
  const both = managed.filter(
    (name) => tenant.has(name) && nonTenant.has(name)
  );
  const unmanaged = [...tenant, ...nonTenant].filter(
    (name) => !managed.includes(name)
  );

  const { rows } = await pool.query<{ relname: string }>(
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])`,
    [managed]
  );
  const live = new Set(rows.map((row) => row.relname));
  const absent = managed.filter((name) => !live.has(name));

  const problems = [
    unclassified.length > 0
      ? `managed but classified as neither tenant nor non-tenant: ${unclassified.join(", ")}`
      : null,
    both.length > 0 ? `classified as both: ${both.join(", ")}` : null,
    unmanaged.length > 0
      ? `classified but not managed by the schema module: ${unmanaged.join(", ")}`
      : null,
    absent.length > 0
      ? `managed but absent from the database: ${absent.join(", ")}`
      : null,
  ].filter((problem) => problem !== null);

  return problems.length > 0 ? problems.join("; ") : null;
};

/**
 * `FORCE` is defense in depth beside the restricted role, not a replacement for
 * it, and Drizzle can express neither `FORCE` nor the classification - which is
 * why ADR 0017 generates the `FORCE` migration from the classification and why
 * this check exists to catch a database that never received it.
 */
const checkForced = async (
  pool: Pool,
  classification: Classification
): Promise<string | null> => {
  const { rows } = await pool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])`,
    [tableNames(classification.tenant)]
  );

  const bad = rows
    .filter((row) => !(row.relrowsecurity && row.relforcerowsecurity))
    .map(
      (row) =>
        `${row.relname} (${[
          row.relrowsecurity ? null : "RLS not enabled",
          row.relforcerowsecurity ? null : "not FORCEd",
        ]
          .filter((flag) => flag !== null)
          .join(", ")})`
    );

  // Absence is not success. The query returns a row only for an ordinary table
  // in `public`, so a tenant table that is missing, or that is a view or a
  // partitioned table, would otherwise pass an assertion whose whole job is to
  // refuse.
  const seen = new Set(rows.map((row) => row.relname));
  const unseen = tableNames(classification.tenant)
    .filter((name) => !seen.has(name))
    .map((name) => `${name} (absent, or not an ordinary table in public)`);

  const problems = [...bad, ...unseen];
  return problems.length > 0 ? problems.join("; ") : null;
};

/**
 * Set equality, not membership. Postgres combines permissive policies by OR, so
 * a `USING (true)` sitting *beside* a correct tenant policy is a full tenant
 * bypass that every presence check passes (ADR 0017).
 */
const checkPolicies = async (
  pool: Pool,
  classification: Classification
): Promise<string | null> => {
  const problems: string[] = [];
  const nonTenantNames = tableNames(classification.nonTenant);
  const live = await applicablePolicies(pool, [
    ...tableNames(classification.tenant),
    ...nonTenantNames,
  ]);

  for (const table of classification.tenant) {
    const name = tableName(table);
    const declared = declaredPolicy(table);
    if ("problem" in declared) {
      problems.push(declared.problem);
      continue;
    }
    const expected = declared.policy;

    // Built one at a time rather than mapped, because a policy the normal form
    // refuses has no comparable value to stand in for it.
    const applying: Policy[] = [];
    let refused = false;
    for (const row of live.filter((candidate) => candidate.tablename === name)) {
      const built = fromCatalog(row);
      if ("problem" in built) {
        problems.push(built.problem);
        refused = true;
        continue;
      }
      applying.push(built.policy);
    }
    if (refused) {
      continue;
    }
    const [only, ...extra] = applying;

    if (only === undefined || extra.length > 0) {
      problems.push(
        `${name} has ${extra.length + (only ? 1 : 0)} policies applying to this role, not exactly one: ${[only, ...extra].map((policy) => policy?.name).join(", ") || "none"}`
      );
      continue;
    }
    if (!samePolicy(only, expected)) {
      problems.push(
        `${name} carries ${describePolicy(only)} where the schema declares ${describePolicy(expected)}`
      );
    }
  }

  for (const name of nonTenantNames) {
    const found = live.filter((row) => row.tablename === name);
    if (found.length > 0) {
      problems.push(
        `${name} is non-tenant and must carry no policy for this role, but carries ${found.map((row) => row.policyname).join(", ")}`
      );
    }
  }

  return problems.length > 0 ? problems.join("; ") : null;
};

/**
 * `PgDialect.migrate` writes a hash it never reads, so an edited applied
 * migration is silently ignored and every existing database keeps the old DDL
 * with no error raised anywhere. The join below is what turns that dead column
 * into a drift signal, and it uses Drizzle's own primitives rather than
 * recomputing either side (ADR 0017).
 */
const checkMigrations = async (pool: Pool): Promise<string | null> => {
  const committed = readCommittedMigrations();
  const tags = committed.map((migration) => migration.tag);

  let applied: { hash: string; created_at: string }[];
  try {
    const result = await pool.query<{ hash: string; created_at: string }>(
      "select hash, created_at from drizzle.__drizzle_migrations"
    );
    applied = result.rows;
  } catch (error) {
    // SAFETY: `code` is node-postgres's own field on a driver error. Anything
    // without one is not the missing-ledger case and is rethrown.
    if ((error as { code?: string }).code !== UNDEFINED_TABLE) {
      throw error;
    }
    return `no migration ledger: ${tags.length} pending (${tags.join(", ")}). Run \`reprove-control-plane migrate\``;
  }

  const byMillis = new Map(
    applied.map((row) => [Number(row.created_at), row.hash])
  );
  // A Map keeps the last row per key, so two rows sharing a `created_at` would
  // hide one another from the hash comparison below. There should never be two.
  const duplicated = applied.length !== byMillis.size;
  const pending = committed.filter(
    (migration) => !byMillis.has(migration.folderMillis)
  );
  const edited = committed.filter(
    (migration) =>
      byMillis.has(migration.folderMillis) &&
      byMillis.get(migration.folderMillis) !== migration.hash
  );
  const committedMillis = new Set(
    committed.map((migration) => migration.folderMillis)
  );
  const ahead = applied.filter(
    (row) => !committedMillis.has(Number(row.created_at))
  );

  const problems = [
    pending.length > 0
      ? `${pending.length} pending: ${pending.map((migration) => migration.tag).join(", ")}`
      : null,
    edited.length > 0
      ? `applied but no longer matching the committed file: ${edited.map((migration) => migration.tag).join(", ")}`
      : null,
    ahead.length > 0
      ? `${ahead.length} applied migration(s) have no journal entry, so the database is ahead of this build`
      : null,
    duplicated
      ? `the ledger holds ${applied.length} rows for ${byMillis.size} distinct migrations, so one is shadowing another`
      : null,
  ].filter((problem) => problem !== null);

  return problems.length > 0 ? problems.join("; ") : null;
};

/**
 * The behavioural one. It reads every tenant table with no Owner context set,
 * having first evaluated {@link OWNER_CONTEXT} - which is the policies' own
 * fragment, rendered - rather than a second spelling of it. If the assertion and
 * the policy disagreed about what "no context" means, the assertion would be
 * measuring something the boundary does not depend on.
 *
 * One statement rather than one per table, because it has to observe a single
 * transaction: a context that leaked from a pooled connection would be released
 * by a second one.
 *
 * **What it does not prove.** An empty table reads empty under any policy, so on
 * a freshly migrated database this check passes without exercising the
 * predicate. It still catches the failure ADR 0008 built it for - the bare
 * `::bigint` cast raises from inside the policy rather than returning rows - and
 * it is the six catalog checks beside it that carry the rest. Writing a row to
 * make it non-vacuous is not available: a boot assertion does not write.
 */
const checkNoContextReadsEmpty = async (
  pool: Pool,
  classification: Classification
): Promise<string | null> => {
  const tenant = tableNames(classification.tenant);
  const probes = tenant
    .map(
      (name) =>
        `select ${quoteLiteral(name)} as tenant_table, exists(select 1 from ${quoteIdentifier(name)}) as visible`
    )
    .join(" union all ");

  const client = await pool.connect();
  try {
    await client.query("begin");
    const context = await client.query<{ owner: string | null }>(
      `select ${OWNER_CONTEXT} as owner`
    );
    const leaked = context.rows[0]?.owner;
    if (leaked !== null && leaked !== undefined) {
      return `a tenant context leaked onto a fresh connection: ${leaked}`;
    }

    const seen = await client.query<{ tenant_table: string; visible: boolean }>(
      probes
    );
    const visible = seen.rows
      .filter((row) => row.visible)
      .map((row) => row.tenant_table);
    return visible.length > 0
      ? `rows are visible with no tenant context in ${visible.join(", ")}`
      : null;
  } finally {
    try {
      await client.query("rollback");
    } catch {
      // A rollback that cannot be issued means the connection is already gone,
      // which the check above has already reported on.
    }
    client.release();
  }
};

// --- the assertion -----------------------------------------------------------

/**
 * Runs all seven checks and reports every verdict, failures included.
 *
 * A check that throws is a failed check rather than a thrown error, so one
 * unreachable catalog view cannot hide the six answers beside it.
 *
 * @param pool A pool on the **runtime** connection. Reading these facts through
 *   the admin connection would measure a privilege set the application never
 *   uses.
 * @param classification The classification to measure against. The parameter
 *   exists so a test can present a deliberately malformed one; production code
 *   never passes it, and `createRuntimeDb()` does not expose it.
 * @returns One result per check, in the order ADR 0008 lists them.
 */
export const runBootChecks = async (
  pool: Pool,
  classification: Classification = CLASSIFICATION
): Promise<CheckResult[]> => {
  const checks: [CheckName, () => Promise<string | null>][] = [
    ["runtime-role-is-not-privileged", () => checkRolePrivileges(pool)],
    [
      "runtime-role-reaches-only-the-managed-tables",
      () => checkPrivilegeReach(pool, classification),
    ],
    [
      "every-managed-table-is-classified",
      () => checkClassification(pool, classification),
    ],
    ["tenant-tables-are-forced", () => checkForced(pool, classification)],
    [
      "tenant-policies-are-exactly-canonical",
      () => checkPolicies(pool, classification),
    ],
    ["migrations-match-the-committed-files", () => checkMigrations(pool)],
    [
      "no-owner-context-reads-empty",
      () => checkNoContextReadsEmpty(pool, classification),
    ],
  ];

  return await Promise.all(
    checks.map(async ([name, check]) => {
      try {
        const failure = await check();
        return { name, ok: failure === null, detail: failure ?? "ok" };
      } catch (error) {
        return {
          name,
          ok: false,
          detail: `the check itself failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    })
  );
};

/**
 * Rule 6 as an assertion: either every check passed, or nothing is returned.
 *
 * @param pool A pool on the runtime connection.
 * @param classification See {@link runBootChecks}.
 * @returns Every check's verdict, once they have all passed.
 * @throws {BootRefusalError} Naming every check that failed and why.
 */
export const assertTenantBoundary = async (
  pool: Pool,
  classification: Classification = CLASSIFICATION
): Promise<CheckResult[]> => {
  const checks = await runBootChecks(pool, classification);
  if (checks.some((check) => !check.ok)) {
    throw new BootRefusalError(checks);
  }
  return checks;
};
