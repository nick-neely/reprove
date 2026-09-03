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
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { MIGRATIONS_FOLDER, readCommittedMigrations } from "./migrations.js";
import { RUNTIME_ROLE } from "./schema.js";

/** What `migrate()` connects with. No value here is read from the environment. */
export interface MigrateConfig {
  /** The **admin** connection on the direct endpoint. Never the runtime role. */
  readonly connectionString: string;
}

/**
 * Applies every committed migration that has not been applied yet.
 *
 * It refuses if the runtime role is missing, rather than failing halfway
 * through: the generated migrations carry `CREATE POLICY ... TO
 * "reprove_runtime"`, which errors outright when the role does not exist, and
 * "run bootstrap first" is a better thing to read than a Postgres role error
 * from inside migration 0000.
 *
 * @param config The admin connection.
 * @returns The journal tags this call applied, in order.
 * @throws {Error} If `bootstrap()` has not run against this database.
 */
export async function migrate(config: MigrateConfig): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 1 });
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
}

/**
 * The `created_at` values already in the ledger, or an empty set when the ledger
 * itself does not exist yet.
 */
async function appliedMillis(pool: pg.Pool): Promise<Set<number>> {
  // Asked separately, because a missing relation is a parse error rather than
  // an empty result: Postgres resolves the FROM clause before any predicate
  // could rule it out.
  const ledger = await pool.query<{ present: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations')::text as present"
  );
  if (ledger.rows[0]?.present == null) {
    return new Set();
  }
  const { rows } = await pool.query<{ created_at: string }>(
    "select created_at from drizzle.__drizzle_migrations"
  );
  return new Set(rows.map((row) => Number(row.created_at)));
}
