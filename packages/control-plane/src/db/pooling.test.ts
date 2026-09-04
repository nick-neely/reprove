/**
 * The pooled-endpoint leak, reproduced, and the shipped path shown not to have
 * it.
 *
 * This is the reason [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md) has a
 * rule 2 at all. PgBouncer in transaction mode - the arrangement Neon fronts its
 * pooled endpoint with - hands one server connection to one client per
 * transaction and takes it back afterwards **without scrubbing session state**.
 * A bare `SET` therefore outlives the client that issued it, and the next client
 * inherits a tenant it never asked for, with no error, warning or notice raised
 * anywhere.
 *
 * The database is the one PgBouncer serves through a pool of exactly one server
 * connection, so reuse is deterministic rather than load-dependent.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  adminUrl,
  createTestDatabase,
  driverFailure,
  onRuntimeConnection,
  PINNED_DATABASE,
  RUNTIME_PASSWORD,
  runtimeUrl,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import { RUNTIME_ROLE } from "./roles.js";
import { createRuntimeDb } from "./runtime.js";
import { ownerContext } from "./schema.js";

const OWNER = 4242;
const SMUGGLED_OWNER = "77";

/** A database for the reset cases, and one whose policy carries the bare cast. */
const RESET_DATABASE = "reprove_test_reset";
const BARE_CAST_DATABASE = "reprove_test_reset_bare_cast";

/** A seeded Owner, so a read that returns nothing returns nothing on purpose. */
const SEEDED_OWNER = 1001;

/**
 * The GUC as Postgres actually holds it, deliberately *not* through the guard.
 * What these cases are about is the value the guard exists to absorb, so reading
 * it through the guard would read the answer rather than the question.
 */
const RAW_OWNER_CONTEXT = "current_setting('app.owner_id', true)";

/**
 * The policies' own Owner-context fragment, rendered. Spelling it again here
 * would let this file and the boundary drift apart while both still passed:
 * an observation that disagrees with the policy about what "no context" means
 * is measuring something the boundary does not depend on.
 */
const OWNER_CONTEXT = new PgDialect().sqlToQuery(ownerContext).sql;

let database: TestDatabase;

/** One client, one look at whatever tenant context the server connection holds. */
const readTenantContext = async (): Promise<string | null> => {
  const client = new Client(runtimeUrl(PINNED_DATABASE));
  await client.connect();
  try {
    const { rows } = await client.query<{ owner: string | null }>(
      `select ${OWNER_CONTEXT} as owner`
    );
    return rows[0]?.owner ?? null;
  } finally {
    await client.end();
  }
};

// Ordered, and the order is load-bearing: the leak leaves the single server
// connection dirty, so the clean case has to be measured first. A test that
// scrubbed the connection in between would be scrubbing away the thing under
// test.
describe.sequential("one server connection, handed to client after client", () => {
  beforeAll(async () => {
    database = await createTestDatabase(PINNED_DATABASE);
    await bootstrap({
      connectionString: adminUrl(PINNED_DATABASE),
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: adminUrl(PINNED_DATABASE) });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it("leaves no tenant context behind after withOwner", async () => {
    const runtime = await createRuntimeDb({
      connectionString: runtimeUrl(PINNED_DATABASE),
      poolSize: 1,
    });
    try {
      await runtime.withOwner(OWNER, async (tx) => {
        const { rows } = await tx.execute<{ owner: string | null }>(
          `select ${OWNER_CONTEXT} as owner`
        );
        // Inside the transaction the context is set, so the next assertion is
        // about it being released rather than about it never existing.
        expect(rows[0]?.owner).toBe(String(OWNER));
      });
    } finally {
      await runtime.close();
    }

    // `set_config(..., is_local => true)` is scoped to the transaction and
    // cannot outlive it, so the next client to be handed this exact server
    // connection sees nothing.
    await expect(readTenantContext()).resolves.toBeNull();
  });

  it("carries a bare SET to whoever gets that connection next", async () => {
    const leaker = new Client(runtimeUrl(PINNED_DATABASE));
    await leaker.connect();
    // No transaction, no `LOCAL`: exactly the statement ADR 0008 originally
    // specified, and the one the ADR was corrected away from.
    await leaker.query(`set app.owner_id = '${SMUGGLED_OWNER}'`);
    await leaker.end();

    // A different client, which set nothing, on a connection it never touched.
    await expect(readTenantContext()).resolves.toBe(SMUGGLED_OWNER);
  });
});

/**
 * Three ways a connection arrives at `app.owner_id = ''`, which is not the same
 * state as never having set it.
 *
 * The first is the one that matters most, and it is the shipped path: a
 * transaction-local `set_config` - exactly what `withOwner` issues - leaves the
 * empty string behind on the session once its transaction ends. Measured, and
 * on the direct endpoint as much as this one. The other two are what a pooler
 * does between clients, `DISCARD ALL` being PgBouncer's `server_reset_query`
 * where it is enabled.
 */
const SET_SESSION = `select set_config('app.owner_id', '${SEEDED_OWNER}', false)`;
const SET_LOCAL = `select set_config('app.owner_id', '${SEEDED_OWNER}', true)`;

/** One arrangement: whatever it takes to leave the GUC as the empty string. */
type Clear = (client: Client) => Promise<void>;

const setThenResetAll: Clear = async (client) => {
  await client.query(SET_SESSION);
  await client.query("reset all");
};

const CLEARED: [string, Clear][] = [
  [
    "a committed transaction-local set_config, which is what withOwner issues",
    async (client) => {
      await client.query("begin");
      await client.query(SET_LOCAL);
      await client.query("commit");
    },
  ],
  ["RESET ALL", setThenResetAll],
  [
    "DISCARD ALL",
    async (client) => {
      await client.query(SET_SESSION);
      await client.query("discard all");
    },
  ],
];

/** Runs the arrangement, then reports the GUC and what a tenant read returns. */
const afterClearing = async (
  db: string,
  clear: Clear
): Promise<{ guc: string | null; rows: unknown[] }> =>
  await onRuntimeConnection(db, async (client) => {
    await clear(client);
    const { rows: setting } = await client.query<{ guc: string | null }>(
      `select ${RAW_OWNER_CONTEXT} as guc`
    );

    // A fresh transaction, because that is the shape the next unit of work
    // takes and the shape the policy is evaluated in.
    await client.query("begin");
    try {
      const { rows } = await client.query("select * from owner");
      return { guc: setting[0]?.guc ?? null, rows };
    } finally {
      await client.query("rollback");
    }
  });

/** A database bootstrapped and migrated, in the order the two commands take. */
const provision = async (db: string): Promise<void> => {
  await bootstrap({
    connectionString: adminUrl(db),
    runtimePassword: RUNTIME_PASSWORD,
  });
  await migrate({ connectionString: adminUrl(db) });
};

describe("a tenant read after the Owner context was cleared", () => {
  let reset: TestDatabase;
  let bareCast: TestDatabase;

  beforeAll(async () => {
    reset = await createTestDatabase(RESET_DATABASE);
    bareCast = await createTestDatabase(BARE_CAST_DATABASE);

    // Together, which `bootstrap` serializes for itself: it provisions a
    // cluster-wide role, and two of them meeting on it is what `bootstrap.test.ts`
    // measures.
    await Promise.all([
      provision(RESET_DATABASE),
      provision(BARE_CAST_DATABASE),
    ]);

    // A row on both, so "zero rows" is the policy answering rather than an
    // empty table, and so the bare cast has something to raise over.
    const seed = `insert into owner (id, login, type) values (${SEEDED_OWNER}, 'acme', 'organization')`;
    await reset.admin(seed);
    await bareCast.admin(seed);

    // The bare `::bigint` cast, which is correct on every direct connection and
    // is what ADR 0008 was corrected away from.
    await bareCast.admin("drop policy owner_tenant on owner");
    await bareCast.admin(
      `create policy owner_tenant on owner as permissive for all to ${RUNTIME_ROLE}
         using (owner.id = current_setting('app.owner_id', true)::bigint)
         with check (owner.id = current_setting('app.owner_id', true)::bigint)`
    );
  });

  afterAll(async () => {
    await Promise.all([reset?.drop(), bareCast?.drop()]);
  });

  it.each(CLEARED)(
    "reads empty, and does not raise, after %s",
    async (_label, clear) => {
      const { guc, rows } = await afterClearing(RESET_DATABASE, clear);

      // The empty string, not NULL. A custom GUC that was ever set is not
      // removed by any of these; it is set to `''`.
      expect(guc).toBe("");
      // Which the `nullif` absorbs, so the policy denies rather than raising.
      expect(rows).toStrictEqual([]);
    }
  );

  it("raises from inside a policy carrying the bare cast, on the same input", async () => {
    // The counterfactual, and the reason the predicate is not the obvious one.
    // `''::bigint` is not a denial: the table stops being deniable and becomes
    // unqueryable, so the failure mode is an outage rather than a leak - and it
    // arrives only after something cleared the context, which on a direct
    // connection during development is nothing.
    // Deliberately the same arrangement the honest policy absorbed above, so the
    // only difference between passing and raising is the predicate.
    const failure = await driverFailure(
      afterClearing(BARE_CAST_DATABASE, setThenResetAll)
    );

    // 22P02 is invalid_text_representation.
    expect(failure).toStrictEqual({
      code: "22P02",
      message: 'invalid input syntax for type bigint: ""',
    });
  });
});
