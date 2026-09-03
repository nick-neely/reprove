/**
 * What the runtime role may do, spelled once and read by all three places that
 * care: `bootstrap()` and `migrate()`, which grant it, and the boot assertion,
 * which refuses when the live grants say something else.
 *
 * The reach is **manifest-scoped**, not schema-wide. A `grant ... on all tables
 * in schema public` and an `alter default privileges ... on tables` both say
 * "whatever is in this schema", and a schema is a place a neighbour may
 * legitimately put a table ([ADR
 * 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * permits Vercel Workflow to share the server). Naming the managed tables one by
 * one is what keeps a grant from arriving at a relation nobody classified - and
 * a relation nobody classified is one the boot assertion never measured for a
 * tenant policy.
 *
 * A **view** is the sharpest form of that. A view runs as its owner unless it
 * carries `security_invoker`, so an admin-owned view over a tenant table reads
 * every Owner's rows, and a schema-wide grant hands it over.
 */
import type { PoolClient } from "pg";

import { RUNTIME_ROLE } from "./roles.js";

/**
 * What the runtime role holds on a managed table. Exactly the four the
 * application needs, and the list is a SQL fragment because `GRANT` takes no
 * bind parameter for a privilege name.
 */
export const RUNTIME_TABLE_PRIVILEGES = "select, insert, update, delete";

/**
 * The privileges on a managed table the runtime role must **not** hold, revoked
 * on every `migrate()` and refused by the boot assertion.
 *
 * `TRUNCATE` is the one that matters most and the one a schema-wide grant never
 * mentioned: it ignores row-level security entirely, so a role holding it can
 * empty another Owner's table through a boundary that denies it every single
 * row. `REFERENCES` and `TRIGGER` are DDL rights on someone else's table, which
 * an application role has no use for.
 */
export const WITHHELD_TABLE_PRIVILEGES = ["TRUNCATE", "REFERENCES", "TRIGGER"];

/**
 * The privileges whose presence means the role can reach a relation at all.
 *
 * Used against relations **outside** the managed set, where holding any one of
 * them is the failure. `has_table_privilege` answers for a view and a foreign
 * table as readily as for a table, which is the point: `relkind = 'r'` was the
 * hole a view walked through.
 */
export const REACHING_TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
];

/**
 * Runs one DDL statement whose variable parts Postgres itself quotes.
 *
 * `format('%I', ...)` and `format('%L', ...)` are why a role name, a password or
 * a table name travels as a bind parameter rather than as interpolated text: DDL
 * takes no parameters, so something has to do the quoting, and Postgres's own
 * quoting is the one thing guaranteed to agree with Postgres's own parser.
 *
 * @param client A connected admin client.
 * @param template A `format()` template, with the fixed SQL written out.
 * @param args One value per placeholder, in order.
 */
export const ddl = async (
  client: PoolClient,
  template: string,
  ...args: string[]
): Promise<void> => {
  // Cast every placeholder, because `format(text, VARIADIC "any")` gives the
  // planner nothing to infer a parameter's type from.
  const placeholders = args.map((_, index) => `, $${index + 2}::text`).join("");
  const { rows } = await client.query<{ statement: string }>(
    `select format($1::text${placeholders}) as statement`,
    [template, ...args]
  );
  const statement = rows[0]?.statement;
  if (statement === undefined) {
    throw new Error(`Postgres could not format the statement: ${template}`);
  }
  await client.query(statement);
};

/**
 * The names as one comma-separated identifier list, quoted by Postgres.
 *
 * A `GRANT` takes a list of relations rather than one, and the list cannot be a
 * bind parameter. Building it here rather than in JavaScript keeps the quoting
 * rule in the same place as every other quoting rule in this module. The result
 * is passed to {@link ddl} as an argument, never spliced into a template, so a
 * `%` inside a relation name is data rather than a second format directive.
 *
 * @param client A connected admin client.
 * @param names The relation names.
 * @returns The list, or null when there are no names to list.
 */
const identifierList = async (
  client: PoolClient,
  names: readonly string[]
): Promise<string | null> => {
  if (names.length === 0) {
    return null;
  }
  const { rows } = await client.query<{ list: string }>(
    "select string_agg(format('%I', name), ', ' order by name) as list from unnest($1::text[]) as name",
    [names]
  );
  return rows[0]?.list ?? null;
};

/**
 * Every sequence in `public` owned by a column of one of the given tables.
 *
 * Owned by, not merely sitting beside: `pg_depend` with `deptype = 'a'` is the
 * automatic dependency an identity or `serial` column creates, so this reaches
 * exactly the sequences the managed tables brought with them and no others. The
 * schema has none today - its keys are uuids and GitHub's own numeric ids - and
 * the query exists so that the first table to need one is granted correctly
 * rather than silently unwritable.
 */
const ownedSequences = async (
  client: PoolClient,
  tables: readonly string[]
): Promise<string[]> => {
  const { rows } = await client.query<{ relname: string }>(
    `select s.relname
       from pg_class s
       join pg_namespace n on n.oid = s.relnamespace
       join pg_depend d
         on d.objid = s.oid
        and d.classid = 'pg_class'::regclass
        and d.refclassid = 'pg_class'::regclass
        and d.deptype = 'a'
       join pg_class t on t.oid = d.refobjid
      where s.relkind = 'S'
        and n.nspname = 'public'
        and t.relname = any($1::text[])`,
    [tables]
  );
  return rows.map((row) => row.relname);
};

/**
 * Brings the runtime role's privileges on the managed tables to exactly what
 * this module declares, and touches nothing else.
 *
 * Run by `migrate()` on the admin connection after the migrations have applied,
 * which is the only moment at which the managed tables are known to exist. It is
 * idempotent, so re-running `migrate()` on an up-to-date database is how an
 * operator repairs a grant that drifted.
 *
 * Both halves matter and neither implies the other. The grant is what lets the
 * application work; the revoke is what stops a privilege granted out of band -
 * or by an older version of this code, which granted schema-wide - from
 * outliving the decision that it should not exist.
 *
 * @param client A connected admin client, inside a transaction.
 * @param tables The SQL names of the managed tables.
 */
export const applyRuntimeGrants = async (
  client: PoolClient,
  tables: readonly string[]
): Promise<void> => {
  const tableList = await identifierList(client, tables);
  if (tableList !== null) {
    await ddl(
      client,
      `grant ${RUNTIME_TABLE_PRIVILEGES} on %s to %I`,
      tableList,
      RUNTIME_ROLE
    );
    await ddl(
      client,
      `revoke ${WITHHELD_TABLE_PRIVILEGES.join(", ")} on %s from %I`,
      tableList,
      RUNTIME_ROLE
    );
  }

  const sequenceList = await identifierList(
    client,
    await ownedSequences(client, tables)
  );
  if (sequenceList !== null) {
    await ddl(
      client,
      "grant usage, select on sequence %s to %I",
      sequenceList,
      RUNTIME_ROLE
    );
  }
};
