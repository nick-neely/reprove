/**
 * The local Postgres-behind-PgBouncer stack these tests measure against, and
 * nothing else. Not shipped: `tsconfig.build.json` keeps it out of `dist`.
 *
 * The connection strings are fixed rather than read from the environment,
 * because the stack is fixed: `tools/db/compose.yaml` is the only thing that
 * serves them, `pnpm db:up` is the only way to start it, and a test that quietly
 * fell back to some other database would be proving the boundary somewhere
 * nobody chose.
 *
 * Every test file creates and drops a database of its own, so the files are
 * independent and can run in parallel. What they share is the cluster: the roles
 * are cluster-wide objects, and `bootstrap()` is written to survive two of them
 * provisioning the same role at once.
 */
import pg from "pg";

import { RUNTIME_ROLE } from "./schema.js";

/** The admin role on the direct endpoint. Owns the tables, applies migrations. */
export const ADMIN_HOST = "127.0.0.1:55432";
/** The runtime role's endpoint: PgBouncer, in transaction mode. */
export const RUNTIME_HOST = "127.0.0.1:56432";

/** The database `docker compose up` creates, used only to create the others. */
export const MAINTENANCE_DATABASE = "reprove";

/**
 * The database PgBouncer serves through a pool of exactly one server
 * connection, which is what makes server-connection reuse deterministic.
 */
export const PINNED_DATABASE = "reprove_pinned";

/** Not a secret: both hops of the local stack authenticate with `trust`. */
export const RUNTIME_PASSWORD = "local-development-only";

const UNREACHABLE = (host: string, cause: string) =>
  new Error(
    `The local database stack is not reachable at ${host} (${cause}).\n` +
      "These tests measure the tenant boundary against real Postgres behind real PgBouncer,\n" +
      "so there is nothing to skip to. Start it with:\n\n" +
      "    pnpm db:up\n"
  );

export const adminUrl = (database: string): string =>
  `postgres://postgres@${ADMIN_HOST}/${database}`;

export const runtimeUrl = (
  database: string,
  role: string = RUNTIME_ROLE
): string => `postgres://${role}@${RUNTIME_HOST}/${database}`;

/**
 * Fails - never skips - with something the reader can act on when either
 * endpoint is down. Both are checked, because a stack with Postgres up and
 * PgBouncer down would pass every catalog check and prove none of the pooled
 * failures these tests exist for.
 */
export async function requireLocalStack(): Promise<void> {
  for (const [host, url] of [
    [ADMIN_HOST, adminUrl(MAINTENANCE_DATABASE)],
    [RUNTIME_HOST, `postgres://postgres@${RUNTIME_HOST}/${MAINTENANCE_DATABASE}`],
  ] as const) {
    const client = new pg.Client(url);
    try {
      await client.connect();
      await client.query("select 1");
    } catch (error) {
      throw UNREACHABLE(
        host,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

/** A database of one test file's own, with both connection strings for it. */
export interface TestDatabase {
  readonly name: string;
  /** Admin role, direct endpoint. */
  readonly adminUrl: string;
  /** Runtime role, through PgBouncer in transaction mode. */
  readonly runtimeUrl: string;
  /** Runs one statement as the admin role, for arranging a scenario. */
  admin<T = unknown>(statement: string, params?: unknown[]): Promise<T[]>;
  /** Drops the database, terminating whatever the pooler still holds. */
  drop(): Promise<void>;
}

async function onMaintenance<T>(
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client(adminUrl(MAINTENANCE_DATABASE));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Drops and recreates a database, so a file starts from a known-clean one
 * however the previous run ended.
 *
 * `WITH (FORCE)` is what makes that true behind a pooler: PgBouncer keeps server
 * connections open across client disconnects, and a plain `DROP DATABASE` would
 * fail on them.
 *
 * @param name The database name, which is this test file's own.
 * @returns Handles onto the new database.
 */
export async function createTestDatabase(name: string): Promise<TestDatabase> {
  await requireLocalStack();
  await onMaintenance(async (client) => {
    await client.query(`drop database if exists "${name}" with (force)`);
    await client.query(`create database "${name}"`);
  });

  const database: TestDatabase = {
    name,
    adminUrl: adminUrl(name),
    runtimeUrl: runtimeUrl(name),
    async admin<T>(statement: string, params?: unknown[]): Promise<T[]> {
      const client = new pg.Client(adminUrl(name));
      await client.connect();
      try {
        const { rows } = await client.query(statement, params);
        return rows as T[];
      } finally {
        await client.end();
      }
    },
    drop: () =>
      onMaintenance(async (client) => {
        await client.query(`drop database if exists "${name}" with (force)`);
      }),
  };
  return database;
}

/**
 * Creates a login role that carries `BYPASSRLS`, which is the shape a provider
 * console hands out: `neon_superuser` carries the flag and is granted to every
 * role created through the console, and connecting as one of those makes every
 * policy inert with no error raised anywhere.
 *
 * It exists only so a test can prove the boot assertion refuses it.
 *
 * @param role The role name to create.
 */
export async function createBypassRlsRole(role: string): Promise<void> {
  await onMaintenance(async (client) => {
    try {
      await client.query(
        `create role "${role}" login nosuperuser bypassrls noinherit`
      );
    } catch (error) {
      // Cluster-wide and shared by every test file, so losing the race is the
      // expected outcome rather than a failure.
      if ((error as { code?: string }).code !== "42710") {
        throw error;
      }
    }
  });
}
