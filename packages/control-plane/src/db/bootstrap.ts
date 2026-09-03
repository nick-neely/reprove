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
import type { PoolClient } from "pg";
import { Pool } from "pg";

import { ddl } from "./privileges.js";
import { RUNTIME_ROLE } from "./roles.js";

/** `CREATE ROLE` against a name another connection created first. */
const DUPLICATE_OBJECT = "42710";

/**
 * Every negative privilege flag, spelled out rather than left to a default: a
 * default that changes is exactly the silent failure the boot assertion exists
 * to catch. `NOINHERIT` matters as much as `NOBYPASSRLS`, because a role that
 * inherits could pick the flag up through a membership it was never granted
 * directly.
 */
const ROLE_FLAGS =
  "login nosuperuser nobypassrls nocreatedb nocreaterole noinherit password %L";

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
 * Creates the runtime role, or brings an existing one back to these exact flags.
 *
 * A role is cluster-wide, so "check, then create" is a race two deployments can
 * lose. Creating and catching the collision is the race-free form, and the
 * fallback is the statement the idempotent path would have run anyway.
 */
const provisionRole = async (
  client: PoolClient,
  password: string
): Promise<void> => {
  try {
    await ddl(
      client,
      `create role %I with ${ROLE_FLAGS}`,
      RUNTIME_ROLE,
      password
    );
  } catch (error) {
    // SAFETY: `code` is node-postgres's own field on a driver error. Anything
    // without one is not a name collision and is rethrown.
    if ((error as { code?: string }).code !== DUPLICATE_OBJECT) {
      throw error;
    }
    await ddl(
      client,
      `alter role %I with ${ROLE_FLAGS}`,
      RUNTIME_ROLE,
      password
    );
  }
};

/**
 * Provisions the restricted runtime role and the reach it has *before* any table
 * exists, idempotently.
 *
 * The role name is not configurable. The committed policies name it, so a
 * deployment that renamed it would migrate a boundary granted to a role that
 * does not exist. It is exported as {@link RUNTIME_ROLE} instead.
 *
 * **Run this before `migrate()`.** `CREATE POLICY ... TO "reprove_runtime"`
 * fails outright if the role does not exist yet, so the two commands are
 * ordered rather than interchangeable.
 *
 * What it does **not** do is grant anything on Reprove's tables. Those grants
 * name the managed tables one by one and are issued by `migrate()`, which is the
 * only moment those tables are known to exist; see
 * {@link import("./privileges.js").applyRuntimeGrants} for why naming them
 * matters. Re-running `migrate()` is therefore how a table grant is repaired,
 * and re-running `bootstrap` remains safe at any point.
 *
 * **Run it as the same role that runs `migrate()`.** A default privilege is
 * recorded against the role that granted it, so the `drizzle` ledger grant below
 * reaches a migration ledger only when the same admin creates it. That fails
 * closed - the boot assertion refuses on `permission denied` - and re-running
 * `bootstrap` as the migrating role is the repair.
 *
 * @param config The admin connection and the runtime role's password.
 */
export const bootstrap = async (config: BootstrapConfig): Promise<void> => {
  // `format('%L', NULL)` renders the bare token `NULL`, which would create a
  // role with no password at all. The bin rejects an unset variable, but the
  // exported function is reachable without it.
  if (config.runtimePassword === "") {
    throw new Error(
      `the runtime role "${RUNTIME_ROLE}" needs a password; an empty one would provision a role with none.`
    );
  }

  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ database: string; admin: string }>(
      "select current_database() as database, current_user as admin"
    );
    const [context] = rows;
    if (!context) {
      throw new Error("the admin connection reported no current database");
    }
    const { database, admin } = context;

    await provisionRole(client, config.runtimePassword);

    await client.query("begin");

    await ddl(
      client,
      "grant connect on database %I to %I",
      database,
      RUNTIME_ROLE
    );

    // A table the runtime role created would be a table it owns, and a table's
    // owner is exempt from its own RLS unless FORCE is set. Removing the ability
    // to create one closes that route entirely, and it is removed from PUBLIC as
    // well, because PUBLIC is how the role would otherwise still hold it.
    //
    // Revoking from PUBLIC is a no-op on Postgres 15 and later, where `public`
    // is owned by `pg_database_owner` and PUBLIC never held CREATE. It is kept
    // for older clusters and for a database restored from one.
    await client.query("revoke create on schema public from public");
    await ddl(client, "revoke create on schema public from %I", RUNTIME_ROLE);
    await ddl(client, "grant usage on schema public to %I", RUNTIME_ROLE);

    // The same route through a different door. A temporary table lands in
    // `pg_temp`, which the search path resolves *before* `public`, so a role
    // that can create one can shadow a managed table with a relation it owns
    // and is therefore exempt from the policies on. The check that the role
    // owns no relation looks in `public` and would not see it.
    await ddl(client, "revoke temporary on database %I from public", database);
    await ddl(
      client,
      "revoke temporary on database %I from %I",
      database,
      RUNTIME_ROLE
    );

    // Read access to the migration ledger, so the runtime can refuse to serve
    // when it is behind without needing the admin credential to find out.
    await client.query("create schema if not exists drizzle");
    await ddl(client, "grant usage on schema drizzle to %I", RUNTIME_ROLE);

    // The ledger `migrate()` is about to create, and the one it may already have
    // created. A default privilege reaches only tables created after it, and
    // only ones created by the admin role, so both statements are needed for
    // `bootstrap` to be re-runnable at any point in a database's life.
    //
    // Deliberately scoped to `drizzle` and not to `public`. Nothing that grants
    // "every table in a schema" survives here: a schema is somewhere a
    // neighbour may legitimately put a relation, and `migrate()` names Reprove's
    // own tables instead.
    await ddl(
      client,
      "alter default privileges for role %I in schema drizzle grant select on tables to %I",
      admin,
      RUNTIME_ROLE
    );
    await ddl(
      client,
      "grant select on all tables in schema drizzle to %I",
      RUNTIME_ROLE
    );

    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The transaction is already gone, which the original error explains.
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};
