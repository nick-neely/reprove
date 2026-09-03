/**
 * The runtime half of [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md), and the
 * place [ADR 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * put the boot assertion: "inside the connection factory rather than in
 * application startup makes it unskippable by construction: there is no path to
 * a client that bypasses it."
 *
 * So `createRuntimeDb()` either returns a client that has proved the tenant
 * boundary is live, or it throws. There is no third outcome and no flag.
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { assertTenantBoundary } from "./checks.js";
import type { CheckResult } from "./refusal.js";
import * as schema from "./schema.js";

/** What the runtime connects with. No value here is read from the environment. */
export interface RuntimeDbConfig {
  /**
   * The **pooled** endpoint, as the restricted runtime role. Never the admin
   * credential and never the direct endpoint: ADR 0008 keeps migrations and
   * application traffic on two connections that are never crossed.
   */
  readonly connectionString: string;
  /** Client connections the pool may hold open. Defaults to 8. */
  readonly poolSize?: number;
}

type Database = NodePgDatabase<typeof schema>;

/**
 * A Drizzle transaction with an Owner context already set on it. Every
 * Owner-scoped query belongs inside one.
 */
export type TenantTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** Work to run inside a transaction, tenant-scoped or not. */
type InTransaction<T> = (tx: TenantTransaction) => Promise<T>;

/** A client that has passed all seven of rule 6's checks. */
export interface RuntimeDb {
  /** Every check's verdict, kept so a deployment can log what it proved. */
  readonly checks: readonly CheckResult[];

  /**
   * The single Owner-scoped entry point. A tenant-scoped query written outside
   * one of these is difficult to write by accident rather than merely forbidden
   * by convention.
   *
   * The first argument is GitHub's durable numeric Owner id, which is the
   * tenant key itself.
   */
  readonly withOwner: <T>(ownerId: number, fn: InTransaction<T>) => Promise<T>;

  /**
   * A transaction with **no Owner context**, and therefore no tenant. Every
   * policy denies, so an Owner-scoped table reads zero rows here rather than
   * erroring.
   *
   * It exists to be the deliberately named exception: the only legitimate uses
   * are non-tenant work (Better Auth's tables) and proving that the boundary
   * denies. Reaching for it to "just read one row" is the mistake `withOwner`
   * exists to make hard.
   */
  readonly withoutOwner: <T>(fn: InTransaction<T>) => Promise<T>;

  /** Drains the pool. */
  readonly close: () => Promise<void>;
}

const DEFAULT_POOL_SIZE = 8;

/**
 * Opens the runtime connection, proves the tenant boundary, and returns a client
 * only if every check passed.
 *
 * @param config The pooled runtime connection and its pool size.
 * @returns A client whose tenant boundary has been measured, not assumed.
 * @throws {import("./refusal.js").BootRefusalError} Naming every check that
 *   failed. The pool is drained first, so a refused boot leaves no connection
 *   behind.
 */
export const createRuntimeDb = async (
  config: RuntimeDbConfig
): Promise<RuntimeDb> => {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolSize ?? DEFAULT_POOL_SIZE,
  });

  let checks: CheckResult[];
  try {
    checks = await assertTenantBoundary(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }

  const db = drizzle(pool, { schema });

  const withOwner = <T>(ownerId: number, fn: InTransaction<T>): Promise<T> => {
    if (!Number.isSafeInteger(ownerId)) {
      throw new TypeError(
        `an Owner id must be GitHub's durable numeric id, not ${String(ownerId)}`
      );
    }
    return db.transaction(async (tx) => {
      // ADR 0008 rule 2, and the reason it is `set_config` rather than the
      // literal `SET LOCAL`: Postgres will not bind a parameter into a `SET`,
      // so that statement form forces string interpolation of a value that
      // arrives from a webhook payload. This is the parameterized equivalent,
      // with identical transaction scoping - and transaction scoping is the
      // whole point, because a bare `SET` outlives the client that issued it
      // behind a pooler in transaction mode.
      await tx.execute(
        sql`select set_config('app.owner_id', ${String(ownerId)}, true)`
      );
      return await fn(tx);
    });
  };

  return {
    checks,
    withOwner,
    withoutOwner: (fn) => db.transaction((tx) => fn(tx)),
    close: () => pool.end(),
  };
};
