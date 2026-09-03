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
 * independent and can run in parallel. What they share is the cluster: roles are
 * cluster-wide objects, and `bootstrap()` is written to survive two connections
 * provisioning the same role at once.
 */
import { Client } from "pg";

import { BootRefusalError } from "./refusal.js";
import { RUNTIME_ROLE } from "./roles.js";

/** The admin role on the direct endpoint. Owns the tables, applies migrations. */
export const ADMIN_HOST = "127.0.0.1:55532";
/** The runtime role's endpoint: PgBouncer, in transaction mode. */
export const RUNTIME_HOST = "127.0.0.1:56532";

/** The database `docker compose up` creates, used only to create the others. */
export const MAINTENANCE_DATABASE = "reprove";

/**
 * The database PgBouncer serves through a pool of exactly one server connection,
 * which is what makes server-connection reuse deterministic.
 */
export const PINNED_DATABASE = "reprove_pinned";

/** Not a secret: both hops of the local stack authenticate with `trust`. */
export const RUNTIME_PASSWORD = "local-development-only";

/** `CREATE ROLE` against a name another connection created first. */
const DUPLICATE_OBJECT = "42710";

export const adminUrl = (database: string): string =>
  `postgres://postgres@${ADMIN_HOST}/${database}`;

export const runtimeUrl = (
  database: string,
  role: string = RUNTIME_ROLE
): string => `postgres://${role}@${RUNTIME_HOST}/${database}`;

const unreachable = (host: string, cause: unknown): Error =>
  new Error(
    `The local database stack is not reachable at ${host} (${cause instanceof Error ? cause.message : String(cause)}).\n` +
      "These tests measure the tenant boundary against real Postgres behind real PgBouncer,\n" +
      "so there is nothing to skip to. Start it with:\n\n" +
      "    pnpm db:up\n"
  );

const reach = async (host: string, url: string): Promise<void> => {
  const client = new Client(url);
  try {
    await client.connect();
    await client.query("select 1");
  } catch (error) {
    throw unreachable(host, error);
  } finally {
    try {
      await client.end();
    } catch {
      // Closing a connection that never opened is not a stack failure.
    }
  }
};

/**
 * Fails - never skips - with something the reader can act on when either
 * endpoint is down. Both are checked, because a stack with Postgres up and
 * PgBouncer down would pass every catalog check and prove none of the pooled
 * failures these tests exist for.
 */
export const requireLocalStack = async (): Promise<void> => {
  await Promise.all([
    reach(ADMIN_HOST, adminUrl(MAINTENANCE_DATABASE)),
    reach(
      RUNTIME_HOST,
      `postgres://postgres@${RUNTIME_HOST}/${MAINTENANCE_DATABASE}`
    ),
  ]);
};

/** A database of one test file's own, with both connection strings for it. */
export interface TestDatabase {
  readonly name: string;
  /** Admin role, direct endpoint. */
  readonly adminUrl: string;
  /** Runtime role, through PgBouncer in transaction mode. */
  readonly runtimeUrl: string;
  /** Runs one statement as the admin role, for arranging a scenario. */
  readonly admin: <T>(statement: string) => Promise<T[]>;
  /** Drops the database, terminating whatever the pooler still holds. */
  readonly drop: () => Promise<void>;
}

const onDatabase = async <T>(
  database: string,
  fn: (client: Client) => Promise<T>
): Promise<T> => {
  const client = new Client(adminUrl(database));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

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
export const createTestDatabase = async (
  name: string
): Promise<TestDatabase> => {
  await requireLocalStack();
  await onDatabase(MAINTENANCE_DATABASE, async (client) => {
    await client.query(`drop database if exists "${name}" with (force)`);
    await client.query(`create database "${name}"`);
  });

  return {
    name,
    adminUrl: adminUrl(name),
    runtimeUrl: runtimeUrl(name),
    admin: <T>(statement: string): Promise<T[]> =>
      onDatabase(name, async (client) => {
        const { rows } = await client.query(statement);
        // SAFETY: every caller states the shape it selected, and a mismatch
        // surfaces as the assertion that reads the row failing in the test.
        return rows as T[];
      }),
    drop: () =>
      onDatabase(MAINTENANCE_DATABASE, async (client) => {
        await client.query(`drop database if exists "${name}" with (force)`);
      }),
  };
};

/**
 * One plain `pg` client on the pooled endpoint, as the runtime role, with no
 * Owner context and no boot assertion in front of it.
 *
 * The shipped client has no such door, on purpose: all access runs through
 * `withOwner`, and there is no `withoutOwner` beside it to reach for. A test
 * that needs to observe what the boundary does with **no** tenant set therefore
 * opens its own connection, which is honest about what it is doing - this is a
 * measurement apparatus rather than an application path.
 *
 * @param database The database to connect to.
 * @param fn The work to run on the connection.
 * @returns Whatever the work returned.
 */
export const onRuntimeConnection = async <T>(
  database: string,
  fn: (client: Client) => Promise<T>
): Promise<T> => {
  const client = new Client(runtimeUrl(database));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

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
export const createBypassRlsRole = async (role: string): Promise<void> => {
  await onDatabase(MAINTENANCE_DATABASE, async (client) => {
    try {
      await client.query(
        `create role "${role}" login nosuperuser bypassrls noinherit`
      );
    } catch (error) {
      // Cluster-wide and shared by every test file, so losing the race is the
      // expected outcome rather than a failure.
      // SAFETY: `code` is what node-postgres puts on a driver error; anything
      // without one is rethrown below.
      if ((error as { code?: string }).code !== DUPLICATE_OBJECT) {
        throw error;
      }
    }
  });
};

/** What a Postgres rejection says, once it has been dug out of its wrapper. */
export interface DriverFailure {
  readonly code: string | undefined;
  readonly message: string;
}

/**
 * The driver error a call rejected with. Drizzle wraps the original in a
 * `Failed query:` error, so the Postgres code lives on the cause rather than on
 * the message, and reading it here keeps that detail out of every assertion.
 *
 * @param work The call expected to reject.
 * @returns The code and message Postgres raised.
 */
export const driverFailure = async (
  work: Promise<unknown>
): Promise<DriverFailure> => {
  try {
    await work;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const raised = cause instanceof Error ? cause : error;
    // SAFETY: `code` is node-postgres's own field on a driver error; a rejection
    // from anywhere else simply reports it as undefined.
    return {
      code: (raised as { code?: string }).code,
      message: raised instanceof Error ? raised.message : String(raised),
    };
  }
  throw new Error("expected the call to reject, and it resolved");
};

/**
 * The refusal a boot rejected with.
 *
 * @param work The call expected to refuse.
 * @returns The refusal, with every check's outcome on it.
 */
export const bootRefusal = async (
  work: Promise<unknown>
): Promise<BootRefusalError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof BootRefusalError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a BootRefusalError, and the call resolved");
};
