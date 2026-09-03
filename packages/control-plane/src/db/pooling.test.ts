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
  PINNED_DATABASE,
  RUNTIME_PASSWORD,
  runtimeUrl,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import { createRuntimeDb } from "./runtime.js";
import { ownerContext } from "./schema.js";

const OWNER = 4242;
const SMUGGLED_OWNER = "77";

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
