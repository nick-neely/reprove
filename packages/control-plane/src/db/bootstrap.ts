/**
 * The admin half of [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s
 * two-connection design.
 *
 * ```text
 * admin / migration connection      runtime connection
 *   owner-or-admin role               restricted non-BYPASSRLS role
 *   direct endpoint                   pooled endpoint
 *   migrations and bootstrap only     all application traffic
 * ```
 *
 * Everything here runs over the direct endpoint as the table owner, and nothing
 * here is reachable from the runtime path. **Nothing here creates a table**
 * either: the schema is the migrations' business, and a bootstrap that also
 * shaped the schema would be a second, unjournalled source of DDL.
 *
 * ADR 0008 is explicit that the runtime role is provisioned as SQL through this
 * connection and not "created in a provider console", because a console-created
 * role inherits the privileges this whole design exists to deny.
 */
import pg from "pg";

import { RUNTIME_ROLE } from "./schema.js";

/** `CREATE ROLE` against a name another connection created first. */
const DUPLICATE_OBJECT = "42710";

/** What `bootstrap()` connects with. No value here is read from the environment. */
export interface BootstrapConfig {
  /**
   * The **admin** connection on the direct endpoint: the role that owns the
   * tables and applies the migrations.
   */
  readonly connectionString: string;
  /** The password the runtime role will authenticate with. */
  readonly runtimePassword: string;
}

/**
 * Runs one DDL statement whose variable parts Postgres itself quotes.
 *
 * `format('%I', $2)` and `format('%L', $3)` are why the role name and the
 * password travel as bind parameters rather than as interpolated text: DDL takes
 * no parameters, so something has to do the quoting, and Postgres's own quoting
 * is the one thing guaranteed to agree with Postgres's own parser.
 */
async function ddl(
  client: pg.PoolClient,
  template: string,
  ...args: string[]
): Promise<void> {
  // Cast every placeholder, because `format(text, VARIADIC "any")` gives the
  // planner nothing to infer a parameter's type from.
  const placeholders = args.map((_, index) => `$${index + 2}::text`);
  const { rows } = await client.query<{ statement: string }>(
    `select format($1::text${placeholders.length > 0 ? `, ${placeholders.join(", ")}` : ""}) as statement`,
    [template, ...args]
  );
  const statement = rows[0]?.statement;
  if (statement === undefined) {
    throw new Error(`Postgres could not format the statement: ${template}`);
  }
  await client.query(statement);
}

/**
 * Provisions the restricted runtime role and the privileges the migrations will
 * hand it, idempotently.
 *
 * The role name is not configurable. The committed policies name it, so a
 * deployment that renamed it would migrate a boundary granted to a role that
 * does not exist. It is exported as {@link RUNTIME_ROLE} instead.
 *
 * **Run this before `migrate()`.** `CREATE POLICY ... TO "reprove_runtime"`
 * fails outright if the role does not exist yet, so the two commands are
 * ordered rather than interchangeable.
 *
 * Re-running it after `migrate()` is safe and is the supported way to repair
 * privileges: the `ALTER DEFAULT PRIVILEGES` below only reach tables created
 * *after* it, so the grants over what already exists are issued as well.
 *
 * @param config The admin connection and the runtime role's password.
 */
export async function bootstrap(config: BootstrapConfig): Promise<void> {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ database: string; admin: string }>(
      "select current_database() as database, current_user as admin"
    );
    const context = rows[0];
    if (!context) {
      throw new Error("the admin connection reported no current database");
    }

    // Every negative flag is spelled out rather than left to a default, because
    // a default that changes is exactly the silent failure the boot assertion
    // exists to catch. NOINHERIT matters as much as NOBYPASSRLS: a role that
    // inherits could pick the flag up through a membership it was never
    // directly granted.
    const flags =
      "login nosuperuser nobypassrls nocreatedb nocreaterole noinherit password %L";

    // A role is cluster-wide, so "check, then create" is a race two deployments
    // can lose. Creating and catching the collision is the race-free form, and
    // the fallback is the statement the idempotent path would have run anyway.
    // It runs before the transaction below, so losing the race costs nothing.
    try {
      await ddl(
        client,
        `create role %I with ${flags}`,
        RUNTIME_ROLE,
        config.runtimePassword
      );
    } catch (error) {
      if ((error as { code?: string }).code !== DUPLICATE_OBJECT) {
        throw error;
      }
      await ddl(
        client,
        `alter role %I with ${flags}`,
        RUNTIME_ROLE,
        config.runtimePassword
      );
    }

    await client.query("begin");

    await ddl(
      client,
      "grant connect on database %I to %I",
      context.database,
      RUNTIME_ROLE
    );

    // A table the runtime role created would be a table it owns, and a table's
    // owner is exempt from its own RLS unless FORCE is set. Removing the ability
    // to create one closes that route entirely, and it is removed from PUBLIC
    // as well, because PUBLIC is how the role would otherwise still hold it.
    await client.query("revoke create on schema public from public");
    await ddl(client, "revoke create on schema public from %I", RUNTIME_ROLE);
    await ddl(client, "grant usage on schema public to %I", RUNTIME_ROLE);

    // Read access to the migration ledger, so the runtime can refuse to serve
    // when it is behind without needing the admin credential to find out.
    await client.query("create schema if not exists drizzle");
    await ddl(client, "grant usage on schema drizzle to %I", RUNTIME_ROLE);

    // What the migrations will create.
    for (const [schemaName, grant] of [
      ["public", "grant select, insert, update, delete on tables to %I"],
      ["public", "grant usage, select on sequences to %I"],
      ["drizzle", "grant select on tables to %I"],
    ] as const) {
      await ddl(
        client,
        `alter default privileges for role %I in schema ${schemaName} ${grant}`,
        context.admin,
        RUNTIME_ROLE
      );
    }

    // And what they created already, so bootstrapping after a migration repairs
    // privileges instead of silently covering only the next table.
    for (const grant of [
      "grant select, insert, update, delete on all tables in schema public to %I",
      "grant usage, select on all sequences in schema public to %I",
      "grant select on all tables in schema drizzle to %I",
    ]) {
      await ddl(client, grant, RUNTIME_ROLE);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
