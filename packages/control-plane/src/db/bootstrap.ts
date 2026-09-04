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
import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { PoolClient } from "pg";
import { Pool } from "pg";

import { requireNonEmpty } from "./config.js";
import { ddl } from "./privileges.js";
import { RUNTIME_ROLE } from "./roles.js";

/** `CREATE ROLE` against a name another connection created first. */
const DUPLICATE_OBJECT = "42710";

/**
 * The same collision, reported one layer down. `CREATE ROLE` looks the name up
 * before it inserts, so a session that commits *between* that lookup and the
 * insert is caught by the unique index on `pg_authid` instead - measured, by
 * starting two bootstraps together. It means what {@link DUPLICATE_OBJECT}
 * means: the role is already there, and the fallback is the same statement.
 */
const UNIQUE_VIOLATION = "23505";

/**
 * The key the bootstrap transaction serializes on. A string rather than a
 * number, hashed by Postgres, so the key is traceable to the thing it names
 * instead of being a constant nobody can account for.
 */
const BOOTSTRAP_LOCK = "reprove:bootstrap";

/**
 * `tuple concurrently updated`, and the deletion beside it, which is what
 * Postgres says when two sessions write one catalog row.
 *
 * Matched on the words because it is an `elog`, not an `ereport`: it carries the
 * internal-error code every other `elog` carries, so the code alone would retry
 * failures that have nothing to do with contention.
 */
const CONCURRENT_CATALOG_WRITE = /tuple concurrently (?:updated|deleted)/u;

/** The code an `elog(ERROR, ...)` arrives with. */
const INTERNAL_ERROR = "XX000";

/**
 * How many times a bootstrap will re-run its transaction against a cluster where
 * another one beat it to the role.
 *
 * {@link BOOTSTRAP_LOCK} is taken in one database; the role is cluster-wide. So
 * a cluster holding more than one Reprove database - the test suite is exactly
 * that, a database per file, run in parallel - can still put two bootstraps on
 * the same `pg_authid` row, and this covers the part the lock cannot.
 *
 * A retry is not a spin: the losing statement *waits* for the transaction that
 * beat it and is only told `tuple concurrently updated` once that transaction has
 * committed. What the waiting does not do is thin the queue, because every loser
 * is woken by the same commit and they all reach the role again together -
 * measured, at sixteen bootstraps started at once, where waiting alone got twelve
 * of them through these ten attempts and left four still colliding. Hence the
 * backoff below, which is what actually spreads them; with it, thirty-two at once
 * settle inside the same ten.
 *
 * Exhausting it raises the collision Postgres reported, having applied nothing:
 * the transaction rolled back, and the operator's repair is to run the command
 * again.
 */
const CONTENDED_ATTEMPTS = 10;

/**
 * The widest a contended attempt waits before the next one, in milliseconds,
 * growing by this much per attempt.
 *
 * Random within that window, and randomness is the working part rather than a
 * garnish: the losers of a round are released by one commit and would otherwise
 * retry in step with each other, arriving together again. A window an order of
 * magnitude wider than the transaction it is spreading is what lets most retries
 * find the role uncontended.
 */
const CONTENDED_BACKOFF_MILLIS = 50;

/**
 * Every negative privilege flag, spelled out rather than left to a default: a
 * default that changes is exactly the silent failure the boot assertion exists
 * to catch. `NOINHERIT` matters as much as `NOBYPASSRLS`, because a role that
 * inherits could pick the flag up through a membership it was never granted
 * directly.
 *
 * `NOREPLICATION` is on the list for the same reason `NOBYPASSRLS` is, and it is
 * the wider hole of the two: a role carrying `REPLICATION` opens a replication
 * connection and streams the write-ahead log, or takes a base backup, and both
 * hand it every Owner's rows as bytes. Row-level security is a planner rewrite
 * and never runs on that path, so no policy is wrong and none is consulted.
 *
 * Every flag here is applied on both paths - the `CREATE ROLE` and the
 * `ALTER ROLE` that repairs an existing one - because the two spell the same
 * constant.
 */
const ROLE_FLAGS =
  "login nosuperuser nobypassrls noreplication nocreatedb nocreaterole noinherit password %L";

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
 * fallback is the statement the idempotent path would have run anyway. The
 * password is reapplied either way, because re-running `bootstrap` is how an
 * operator repairs one.
 *
 * The savepoint is what lets the collision be caught from *inside* the bootstrap
 * transaction: a failed statement leaves the transaction aborted, and rolling
 * back to a savepoint is the only way back to a usable one.
 */
const provisionRole = async (
  client: PoolClient,
  password: string
): Promise<void> => {
  await client.query("savepoint before_create_role");
  try {
    await ddl(
      client,
      `create role %I with ${ROLE_FLAGS}`,
      RUNTIME_ROLE,
      password
    );
    await client.query("release savepoint before_create_role");
  } catch (error) {
    // SAFETY: `code` is node-postgres's own field on a driver error. Anything
    // without one is not a name collision and is rethrown.
    const { code } = error as { code?: string };
    if (code !== DUPLICATE_OBJECT && code !== UNIQUE_VIOLATION) {
      throw error;
    }
    await client.query("rollback to savepoint before_create_role");
    await ddl(
      client,
      `alter role %I with ${ROLE_FLAGS}`,
      RUNTIME_ROLE,
      password
    );
  }
};

/** Who the admin connection turned out to be. */
interface AdminContext {
  /** The database being bootstrapped. */
  readonly database: string;
  /** The role it connected as, which is the role `migrate()` has to run as too. */
  readonly admin: string;
}

const adminContext = async (client: PoolClient): Promise<AdminContext> => {
  const { rows } = await client.query<{ database: string; admin: string }>(
    "select current_database() as database, current_user as admin"
  );
  const [context] = rows;
  if (!context) {
    throw new Error("the admin connection reported no current database");
  }
  return context;
};

/**
 * Everything one bootstrap provisions, in one transaction, behind one lock.
 *
 * Both halves are the point. The lock makes two bootstraps started together
 * queue instead of meeting on the role's catalog row, and the transaction is
 * what the lock is held for: `pg_advisory_xact_lock` is released by the commit
 * or the rollback, so there is no unlock to forget and a bootstrap that dies
 * mid-flight does not leave the next one waiting on a lock nobody holds.
 *
 * The role provisioning is inside it rather than in front of it because that is
 * the statement being serialized. `CREATE ROLE` and the `ALTER ROLE` behind it
 * both write `pg_authid`, and a session that read that row before another
 * committed a write to it is told `tuple concurrently updated` rather than
 * handed the row again.
 */
const provision = async (
  client: PoolClient,
  { database, admin }: AdminContext,
  password: string
): Promise<void> => {
  await client.query("begin");

  // Postgres hashes the key, so the number nobody would recognize is derived
  // from a string that says what it is. `hashtext` is stable within a cluster,
  // which is all a lock key needs: two bootstraps agree on it, and nothing
  // persists it.
  await client.query("select pg_advisory_xact_lock(hashtext($1::text))", [
    BOOTSTRAP_LOCK,
  ]);

  await provisionRole(client, password);

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
};

/** As much of a node-postgres driver error as this module reads. */
interface DriverError {
  readonly code?: string;
  readonly message?: string;
}

/** Whether Postgres refused because another session wrote the same catalog row. */
const contended = ({ code, message }: DriverError): boolean =>
  code === INTERNAL_ERROR && CONCURRENT_CATALOG_WRITE.test(message ?? "");

const abandon = async (client: PoolClient): Promise<void> => {
  try {
    await client.query("rollback");
  } catch {
    // The transaction is already gone, which the original error explains.
  }
};

/**
 * One attempt, and the next one when the cluster says another bootstrap was
 * already writing the role.
 *
 * Recursive rather than a loop because the attempts are a queue rather than a
 * batch: each one only exists because the previous one was told to stand aside.
 *
 * @param client The admin client, outside a transaction.
 * @param context What that connection reported about itself.
 * @param password The runtime role's password.
 * @param attempt Which attempt this is, counting from one.
 */
const provisionOrRetry = async (
  client: PoolClient,
  context: AdminContext,
  password: string,
  attempt: number
): Promise<void> => {
  try {
    await provision(client, context, password);
  } catch (error) {
    await abandon(client);
    // SAFETY: `code` and `message` are node-postgres's own fields on a driver
    // error; anything raised elsewhere fails both halves of the test and is
    // rethrown by the line below.
    if (attempt === CONTENDED_ATTEMPTS || !contended(error as DriverError)) {
      throw error;
    }
    await sleep(randomInt(attempt * CONTENDED_BACKOFF_MILLIS));
    await provisionOrRetry(client, context, password, attempt + 1);
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
 * **Two of these started together survive each other.** Everything it provisions
 * runs in one transaction that takes {@link BOOTSTRAP_LOCK} first, so bootstraps
 * against one database queue; the runtime role is cluster-wide, so bootstraps
 * against *different* databases in one cluster can still meet on it, and a
 * bootstrap that loses that race re-runs its own transaction - see
 * {@link CONTENDED_ATTEMPTS}. A deployment scaling out and a test suite running
 * a database per file are the same case.
 *
 * @param config The admin connection and the runtime role's password.
 * @throws {TypeError} If either field is not a non-empty string. A JavaScript
 *   caller can omit one, and neither omission fails loudly on its own.
 */
export const bootstrap = async (config: BootstrapConfig): Promise<void> => {
  // Both fields, before anything connects. The bin rejects an unset variable,
  // but the exported function is reachable without it, and what an absent one
  // does here is silent rather than loud - see `config.ts`.
  const connectionString = requireNonEmpty(
    config.connectionString,
    "BootstrapConfig.connectionString"
  );
  const runtimePassword = requireNonEmpty(
    config.runtimePassword,
    "BootstrapConfig.runtimePassword"
  );

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    const context = await adminContext(client);
    await provisionOrRetry(client, context, runtimePassword, 1);
  } finally {
    client.release();
    await pool.end();
  }
};
