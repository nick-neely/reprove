/**
 * Applying the committed migrations, over the admin connection.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md):
 * migrations are Drizzle-generated SQL committed to Git and applied by an
 * explicit operator or deployment command, **never automatically at application
 * boot** - auto-migration races concurrent serverless instances and takes a
 * schema change out of the operator's hands. History is forward-only, and a
 * destructive change rolls out as expand and backfill, then contract and drop.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { CLASSIFICATION, tableNames } from "./classification.js";
import { MIGRATIONS_FOLDER, readCommittedMigrations } from "./migrations.js";
import { applyRuntimeGrants } from "./privileges.js";
import { RUNTIME_ROLE } from "./roles.js";

/** What `migrate()` connects with. No value here is read from the environment. */
export interface MigrateConfig {
  /** The **admin** connection on the direct endpoint. Never the runtime role. */
  readonly connectionString: string;
}

/**
 * The `created_at` values already in the ledger, or an empty set when the ledger
 * itself does not exist yet.
 */
const appliedMillis = async (pool: Pool): Promise<Set<number>> => {
  // Asked separately, because a missing relation is a parse error rather than an
  // empty result: Postgres resolves the FROM clause before any predicate could
  // rule it out.
  const ledger = await pool.query<{ present: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations')::text as present"
  );
  const present = ledger.rows[0]?.present;
  if (present === null || present === undefined) {
    return new Set();
  }
  const { rows } = await pool.query<{ created_at: string }>(
    "select created_at from drizzle.__drizzle_migrations"
  );
  return new Set(rows.map((row) => Number(row.created_at)));
};

/**
 * Applies every committed migration that has not been applied yet, then brings
 * the runtime role's privileges on the managed tables to exactly what
 * `privileges.ts` declares.
 *
 * The grants live here rather than in `bootstrap()` because they name the
 * managed tables one by one, and the only moment those tables are known to exist
 * is after the migrations have run. That has a consequence worth stating: a
 * `migrate()` that applied nothing still re-applies the grants, so re-running it
 * is how an operator repairs a privilege that drifted.
 *
 * It refuses if the runtime role is missing, rather than failing halfway
 * through: the generated migrations carry `CREATE POLICY ... TO
 * "reprove_runtime"`, which errors outright when the role does not exist, and
 * "run bootstrap first" is a better thing to read than a Postgres role error
 * raised from inside migration `0000`.
 *
 * Drizzle applies only migrations whose `folderMillis` exceeds the newest
 * `created_at` in the ledger, so a journal entry appended with an *older*
 * timestamp than one already applied is skipped here and reported as pending by
 * the boot assertion forever. ADR 0017's authoring-time append-only verifier is
 * what keeps the journal from reaching that state; there is no recovery from
 * this side.
 *
 * @param config The admin connection.
 * @returns The journal tags this call applied, in order. An empty array means
 *   the database was already up to date, not that nothing happened: the grants
 *   were re-applied either way.
 * @throws {Error} If `bootstrap()` has not run against this cluster.
 */
export const migrate = async (config: MigrateConfig): Promise<string[]> => {
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  try {
    const role = await pool.query("select 1 from pg_roles where rolname = $1", [
      RUNTIME_ROLE,
    ]);
    if (role.rowCount === 0) {
      throw new Error(
        `the runtime role "${RUNTIME_ROLE}" does not exist, and every migration grants the tenant boundary to it. Run \`reprove-control-plane bootstrap\` first; the two commands are ordered, not interchangeable.`
      );
    }

    const before = await appliedMillis(pool);
    await applyMigrations(drizzle(pool), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });
    const after = await appliedMillis(pool);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await applyRuntimeGrants(client, tableNames(CLASSIFICATION.managed));
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
    }

    return readCommittedMigrations()
      .filter(
        (migration) =>
          after.has(migration.folderMillis) &&
          !before.has(migration.folderMillis)
      )
      .map((migration) => migration.tag);
  } finally {
    await pool.end();
  }
};
