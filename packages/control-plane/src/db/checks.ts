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
import { is } from "drizzle-orm";
import type { PgPolicyToOption, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig, PgDialect, PgRole } from "drizzle-orm/pg-core";
import type { Pool } from "pg";

import type { Classification } from "./classification.js";
import { CLASSIFICATION, tableName, tableNames } from "./classification.js";
import { readCommittedMigrations } from "./migrations.js";
import type { CheckName, CheckResult } from "./refusal.js";
import { BootRefusalError } from "./refusal.js";
import { RUNTIME_ROLE } from "./roles.js";

const DIALECT = new PgDialect();

/** `select` against a relation that does not exist. */
const UNDEFINED_TABLE = "42P01";

/** An identifier Postgres would print without quoting it. */
const BARE_IDENTIFIER = /^[a-z_][\da-z_$]*$/u;
const WORD_START = /[A-Za-z_\d]/u;
const WORD_BODY = /[\dA-Za-z_$]/u;
const WHITESPACE = /\s/u;

/**
 * Postgres's own identifier folding, applied to one token: an unquoted
 * identifier folds to lower case, a quoted one does not. That distinction is
 * load-bearing rather than pedantic - `"Owner_Id"` is a **different column**
 * from `owner_id`, and a policy comparing the wrong one is a tenant boundary
 * over nothing.
 */
const foldIdentifier = (raw: string): string => {
  if (!raw.startsWith('"')) {
    return raw.toLowerCase();
  }
  const inner = raw.slice(1, -1).replaceAll('""', '"');
  return BARE_IDENTIFIER.test(inner) ? inner : `"${inner}"`;
};

/**
 * One SQL expression as a token sequence.
 *
 * Postgres re-prints a stored expression through its own deparser, so the text
 * in `pg_policies` never matches the text Drizzle rendered even when the two
 * mean the same thing: it uppercases function names, adds `::text` to every
 * string literal, unquotes what it can and re-parenthesises freely. Tokenising
 * is what lets those differences be reconciled **without** reaching inside a
 * string literal or a quoted identifier, which a blanket lowercase-and-strip
 * would do - and doing it would make `nullif(x, ' ')` indistinguishable from
 * `nullif(x, '')`, which is the ADR 0008 outage wearing a disguise.
 *
 * Whitespace and parentheses are dropped. Dropping parentheses is the one
 * reduction that loses information: two expressions differing only in how a
 * fixed token sequence is grouped compare equal. Nothing in the grammar of a
 * tenant predicate - a comparison, a cast and two function calls - can express
 * such a pair, and the alternative is a SQL parser.
 */
const tokenize = (expression: string): string[] => {
  const tokens: string[] = [];
  let index = 0;

  const readQuoted = (quote: string): string => {
    let end = index + 1;
    while (end < expression.length) {
      if (expression[end] === quote) {
        if (expression[end + 1] === quote) {
          end += 2;
          continue;
        }
        break;
      }
      end += 1;
    }
    const raw = expression.slice(index, Math.min(end + 1, expression.length));
    index = end + 1;
    return raw;
  };

  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (WHITESPACE.test(character) || character === "(" || character === ")") {
      index += 1;
    } else if (character === "'") {
      // Verbatim, quotes included: what is inside a literal is data, and a
      // space is not an empty string.
      tokens.push(readQuoted("'"));
    } else if (character === '"') {
      tokens.push(foldIdentifier(readQuoted('"')));
    } else if (WORD_START.test(character)) {
      let end = index;
      while (end < expression.length && WORD_BODY.test(expression[end] ?? "")) {
        end += 1;
      }
      tokens.push(foldIdentifier(expression.slice(index, end)));
      index = end;
    } else if (expression.startsWith("::", index)) {
      tokens.push("::");
      index += 2;
    } else {
      tokens.push(character);
      index += 1;
    }
  }

  return tokens;
};

/** A separator no token can contain, so a join cannot forge a boundary. */
const TOKEN_SEPARATOR = " ";

/**
 * One predicate reduced to the form both deparsers agree on.
 *
 * Two reductions run over the token stream. `::text` goes because Postgres adds
 * one to every string literal and Drizzle does not. The table qualifier goes
 * because Drizzle renders `"run"."owner_id"` where Postgres, which already
 * knows the relation, renders `owner_id`.
 *
 * @param expression A policy predicate from either side.
 * @param table The SQL name of the table the policy is attached to.
 * @returns The predicate as a token sequence, comparable across deparsers.
 */
const normalizePredicate = (expression: string, table: string): string => {
  const tokens = tokenize(expression);
  const reduced: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "::" && tokens[index + 1] === "text") {
      index += 1;
      continue;
    }
    if (tokens[index] === table && tokens[index + 1] === ".") {
      index += 1;
      continue;
    }
    reduced.push(tokens[index] ?? "");
  }

  return reduced.join(TOKEN_SEPARATOR);
};

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
): { canonical: Policy } | { problem: string } => {
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
  return {
    canonical: {
      name: policy.name,
      permissive: (policy.as ?? "permissive") === "permissive",
      command: (policy.for ?? "all").toLowerCase(),
      roles,
      using: normalizePredicate(DIALECT.sqlToQuery(policy.using).sql, name),
      withCheck: normalizePredicate(
        DIALECT.sqlToQuery(policy.withCheck).sql,
        name
      ),
    },
  };
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

const fromCatalog = (row: CatalogPolicyRow): Policy => ({
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

/**
 * A table's owner is exempt from its own RLS unless `FORCE` is set, so the role
 * must not own tables **and** the tables must be forced. Bootstrap closes the
 * route by revoking `CREATE` on the schema; this measures the result.
 */
const checkOwnsNoTable = async (pool: Pool): Promise<string | null> => {
  const { rows } = await pool.query<{ relname: string }>(
    `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles o on o.oid = c.relowner
      where n.nspname = 'public' and c.relkind = 'r' and o.rolname = current_user`
  );
  return rows.length > 0
    ? `owns ${rows.map((row) => row.relname).join(", ")} in public`
    : null;
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

  return bad.length > 0 ? bad.join("; ") : null;
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
    const expected = declared.canonical;
    const [only, ...extra] = live
      .filter((row) => row.tablename === name)
      .map((row) => fromCatalog(row));

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
};

/**
 * The behavioural one. It reads every tenant table with no Owner context set,
 * using the **same expression the policies use** - if the assertion and the
 * policy disagreed about what "no context" means, the assertion would be
 * measuring something the boundary does not depend on.
 *
 * One statement rather than one per table, because it has to observe a single
 * transaction: a context that leaked from a pooled connection would be released
 * by a second one.
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
      "select nullif(current_setting('app.owner_id', true), '') as owner"
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
