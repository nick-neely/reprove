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
 * The behavioural check is not redundant with the other six. Every catalog flag
 * can be correct while the predicate is wrong; that is exactly what the bare
 * `::bigint` cast was, and the behavioural check is what caught it.
 */
import type { PgPolicyToOption, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import type { Classification } from "./classification.js";
import { CLASSIFICATION, tableName, tableNames } from "./classification.js";
import { readCommittedMigrations } from "./migrations.js";
import { RUNTIME_ROLE } from "./schema.js";

/** The stable name of each of rule 6's seven checks. */
export type CheckName =
  | "runtime-role-is-not-privileged"
  | "runtime-role-owns-no-table"
  | "every-managed-table-is-classified"
  | "tenant-tables-are-forced"
  | "tenant-policies-are-exactly-canonical"
  | "migrations-match-the-committed-files"
  | "no-owner-context-reads-empty";

/** One check's verdict. `detail` is what a refusal prints. */
export interface CheckResult {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * What `createRuntimeDb()` throws instead of returning a client. There is no
 * flag that downgrades this to a warning and no path to a client that skipped
 * it: the assertion lives in the connection factory precisely so that it is
 * unskippable by construction (ADR 0010).
 */
export class BootRefusal extends Error {
  readonly checks: readonly CheckResult[];

  constructor(checks: readonly CheckResult[]) {
    const failed = checks.filter((check) => !check.ok);
    super(
      [
        `refusing to serve: ${failed.length} of ${checks.length} tenancy assertions failed`,
        ...failed.map((check) => `  x ${check.name}: ${check.detail}`),
      ].join("\n")
    );
    this.name = "BootRefusal";
    this.checks = checks;
  }
}

const DIALECT = new PgDialect();

// Postgres re-prints a stored expression through its own deparser, so the text
// in `pg_policies` never matches the text Drizzle rendered even when the two
// mean the same thing: it lowercases nothing, adds `::text` to every string
// literal, drops identifier quotes and re-parenthesises freely. These four
// reductions are what the comparison strips from *both* sides before comparing,
// so the shape being compared is the token sequence rather than the formatting.
const TEXT_CAST = /::text\b/gu;
const IDENTIFIER_QUOTE = /"/gu;
const WHITESPACE = /\s+/gu;
const PARENTHESIS = /[()]/gu;

const UNDEFINED_TABLE = "42P01";

/**
 * One predicate reduced to the form both deparsers agree on.
 *
 * The table qualifier goes too: Drizzle renders `"run"."owner_id"` where
 * Postgres, which already knows the relation, renders `owner_id`. Table names
 * come from `getTableConfig()` and are plain lower-case identifiers, so
 * interpolating one into the pattern introduces nothing.
 *
 * @param expression A policy predicate from either side.
 * @param table The SQL name of the table the policy is attached to.
 * @returns The predicate as a token sequence, comparable across deparsers.
 */
function normalizePredicate(expression: string, table: string): string {
  return expression
    .toLowerCase()
    .replaceAll(TEXT_CAST, "")
    .replaceAll(IDENTIFIER_QUOTE, "")
    .replaceAll(new RegExp(`\\b${table}\\.`, "gu"), "")
    .replaceAll(WHITESPACE, "")
    .replaceAll(PARENTHESIS, "");
}

/** A policy as either the schema module declares it or the catalog holds it. */
interface PolicyShape {
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  readonly roles: readonly string[];
  readonly using: string;
  readonly withCheck: string;
}

const describePolicy = (policy: PolicyShape): string =>
  `${policy.name} ${policy.permissive ? "permissive" : "restrictive"} for ${policy.command} to ${[...policy.roles].sort().join(",")} using ${policy.using} with check ${policy.withCheck}`;

const samePolicy = (a: PolicyShape, b: PolicyShape): boolean =>
  describePolicy(a) === describePolicy(b);

/**
 * The role names a declared policy applies to. Drizzle accepts a role, a role
 * name, or a list of either, so all four spellings are flattened here rather
 * than at each call site.
 */
function declaredRoles(to: PgPolicyToOption | undefined): string[] {
  if (to === undefined) {
    return [];
  }
  if (Array.isArray(to)) {
    return to.flatMap((entry) => declaredRoles(entry));
  }
  return [typeof to === "string" ? to : to.name];
}

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
function declaredPolicy(table: PgTable): PolicyShape | string {
  const name = tableName(table);
  const declared = getTableConfig(table).policies;
  if (declared.length !== 1) {
    return `${name} declares ${declared.length} policies; a tenant table declares exactly the canonical one`;
  }
  const policy = declared[0];
  if (!(policy?.using && policy.withCheck)) {
    return `${name}'s policy declares no using or with-check expression`;
  }
  const roles = declaredRoles(policy.to);
  if (!(roles.length === 1 && roles[0] === RUNTIME_ROLE)) {
    return `${name}'s policy applies to ${roles.join(", ") || "no role"} rather than to ${RUNTIME_ROLE} alone`;
  }
  return {
    name: policy.name,
    permissive: (policy.as ?? "permissive") === "permissive",
    command: (policy.for ?? "all").toLowerCase(),
    roles,
    using: normalizePredicate(DIALECT.sqlToQuery(policy.using).sql, name),
    withCheck: normalizePredicate(
      DIALECT.sqlToQuery(policy.withCheck).sql,
      name
    ),
  };
}

/** A Postgres identifier, quoted for the few places a bind parameter cannot go. */
const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

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
 */
async function applicablePolicies(
  pool: Pool,
  tables: string[]
): Promise<CatalogPolicyRow[]> {
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
}

const fromCatalog = (row: CatalogPolicyRow): PolicyShape => ({
  name: row.policyname,
  permissive: row.permissive.toLowerCase() === "permissive",
  command: row.cmd.toLowerCase(),
  roles: row.roles,
  using: normalizePredicate(row.qual ?? "", row.tablename),
  withCheck: normalizePredicate(row.with_check ?? "", row.tablename),
});

// --- the seven checks --------------------------------------------------------

/**
 * Rule 4, and the one that fails **silently**, which is why it is checked at
 * all. `neon_superuser` carries `BYPASSRLS` and is granted to every role created
 * through a provider console: connect as one of those and every policy is
 * ignored with no error, warning or notice raised anywhere.
 */
async function checkRolePrivileges(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user"
  );
  const role = rows[0];
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
}

/**
 * A table's owner is exempt from its own RLS unless `FORCE` is set, so the role
 * must not own tables **and** the tables must be forced. Bootstrap closes the
 * route by revoking `CREATE` on the schema; this measures the result.
 */
async function checkOwnsNoTable(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ relname: string }>(
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles o on o.oid = c.relowner
      where n.nspname = 'public' and c.relkind = 'r' and o.rolname = current_user`
  );
  return rows.length > 0
    ? `owns ${rows.map((row) => row.relname).join(", ")} in public`
    : null;
}

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
async function checkClassification(
  pool: Pool,
  classification: Classification
): Promise<string | null> {
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
}

/**
 * `FORCE` is defense in depth beside the restricted role, not a replacement for
 * it, and Drizzle can express neither `FORCE` nor the classification - which is
 * why ADR 0017 generates the `FORCE` migration from the classification and why
 * this check exists to catch a database that never received it.
 */
async function checkForced(
  pool: Pool,
  classification: Classification
): Promise<string | null> {
  const tenant = tableNames(classification.tenant);
  const { rows } = await pool.query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])`,
    [tenant]
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

  return bad.length > 0 ? bad.join("; ") : null;
}

/**
 * Set equality, not membership. Postgres combines permissive policies by OR, so
 * a `USING (true)` sitting *beside* a correct tenant policy is a full tenant
 * bypass that every presence check passes (ADR 0017).
 */
async function checkPolicies(
  pool: Pool,
  classification: Classification
): Promise<string | null> {
  const problems: string[] = [];
  const tenantNames = tableNames(classification.tenant);
  const nonTenantNames = tableNames(classification.nonTenant);
  const live = await applicablePolicies(pool, [
    ...tenantNames,
    ...nonTenantNames,
  ]);

  for (const table of classification.tenant) {
    const name = tableName(table);
    const expected = declaredPolicy(table);
    if (typeof expected === "string") {
      problems.push(expected);
      continue;
    }
    const found = live
      .filter((row) => row.tablename === name)
      .map((row) => fromCatalog(row));

    if (found.length !== 1) {
      problems.push(
        `${name} has ${found.length} policies applying to this role, not exactly one: ${found.map((policy) => policy.name).join(", ") || "none"}`
      );
      continue;
    }
    const only = found[0];
    if (only && !samePolicy(only, expected)) {
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
}

/**
 * `PgDialect.migrate` writes a hash it never reads, so an edited applied
 * migration is silently ignored and every existing database keeps the old DDL
 * with no error raised anywhere. The join below is what turns that dead column
 * into a drift signal, and it uses Drizzle's own primitives rather than
 * recomputing either side (ADR 0017).
 */
async function checkMigrations(pool: Pool): Promise<string | null> {
  const committed = readCommittedMigrations();

  let applied: { hash: string; created_at: string }[];
  try {
    const result = await pool.query<{ hash: string; created_at: string }>(
      "select hash, created_at from drizzle.__drizzle_migrations"
    );
    applied = result.rows;
  } catch (error) {
    if (
      error instanceof Error &&
      (error as Error & { code?: string }).code === UNDEFINED_TABLE
    ) {
      return `no migration ledger: ${committed.length} pending (${committed.map((migration) => migration.tag).join(", ")}). Run \`reprove-control-plane migrate\``;
    }
    throw error;
  }

  const byMillis = new Map(
    applied.map((row) => [Number(row.created_at), row.hash])
  );
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
  ].filter((problem) => problem !== null);

  return problems.length > 0 ? problems.join("; ") : null;
}

/**
 * The behavioural one. It reads a tenant table with no Owner context set, using
 * the **same expression the policies use** - if the assertion and the policy
 * disagreed about what "no context" means, the assertion would be measuring
 * something the boundary does not depend on.
 */
async function checkNoContextReadsEmpty(
  pool: Pool,
  classification: Classification
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const context = await client.query<{ owner: string | null }>(
      "select nullif(current_setting('app.owner_id', true), '') as owner"
    );
    if (context.rows[0]?.owner != null) {
      return `a tenant context leaked onto a fresh connection: ${context.rows[0].owner}`;
    }

    const visible: string[] = [];
    for (const table of classification.tenant) {
      const name = tableName(table);
      const result = await client.query<{ visible: boolean }>(
        `select exists(select 1 from ${quoteIdentifier(name)}) as visible`
      );
      if (result.rows[0]?.visible) {
        visible.push(name);
      }
    }
    return visible.length > 0
      ? `rows are visible with no tenant context in ${visible.join(", ")}`
      : null;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

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
 *   never passes it.
 * @returns One result per check, in the order ADR 0008 lists them.
 */
export async function runBootChecks(
  pool: Pool,
  classification: Classification = CLASSIFICATION
): Promise<CheckResult[]> {
  const checks: [CheckName, () => Promise<string | null>][] = [
    ["runtime-role-is-not-privileged", () => checkRolePrivileges(pool)],
    ["runtime-role-owns-no-table", () => checkOwnsNoTable(pool)],
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

  const results: CheckResult[] = [];
  for (const [name, check] of checks) {
    try {
      const failure = await check();
      results.push({ name, ok: failure === null, detail: failure ?? "ok" });
    } catch (error) {
      results.push({
        name,
        ok: false,
        detail: `the check itself failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}

/**
 * Rule 6 as an assertion: either every check passed, or nothing is returned.
 *
 * @param pool A pool on the runtime connection.
 * @param classification See {@link runBootChecks}.
 * @returns Every check's verdict, once they have all passed.
 * @throws {BootRefusal} Naming every check that failed and why.
 */
export async function assertTenantBoundary(
  pool: Pool,
  classification: Classification = CLASSIFICATION
): Promise<CheckResult[]> {
  const checks = await runBootChecks(pool, classification);
  if (checks.some((check) => !check.ok)) {
    throw new BootRefusal(checks);
  }
  return checks;
}
