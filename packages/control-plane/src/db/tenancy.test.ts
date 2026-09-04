/**
 * Two Owners, one code path, and what Postgres does about it.
 *
 * The point of [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s first
 * decision is that a forgotten `WHERE owner_id` returns another Owner's Findings
 * under application scoping alone, and returns zero rows under RLS. Every query
 * below is deliberately written without a tenant predicate, so what it returns
 * is the boundary's answer rather than the query's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  createTestDatabase,
  driverFailure,
  onRuntimeConnection,
  RUNTIME_PASSWORD,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import type { RuntimeDb, TenantTransaction } from "./runtime.js";
import { createRuntimeDb } from "./runtime.js";
import * as schema from "./schema.js";

const DATABASE = "reprove_test_tenancy";

/** GitHub numeric Owner ids, which are the tenant keys themselves. */
const ACME = 1001;
const GLOBEX = 2002;
const SEEDED_RUNS = "2";

let database: TestDatabase;
let runtime: RuntimeDb;

/** One Owner with one Repository and one queued Run, all through `withOwner`. */
const seed = async (tx: TenantTransaction, ownerId: number): Promise<void> => {
  await tx
    .insert(schema.owner)
    .values({ id: ownerId, login: `owner-${ownerId}`, type: "organization" });
  await tx.insert(schema.repository).values({
    id: ownerId * 10,
    ownerId,
    nameWithOwner: `owner-${ownerId}/reprove`,
  });
  await tx.insert(schema.run).values({
    ownerId,
    repositoryId: ownerId * 10,
    pullRequestNumber: 7,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    provenance: "internal",
    provenanceBasis: { authorAssociation: "MEMBER" },
    trigger: "automatic",
    harness: "codex",
    model: "gpt-5",
    strategy: "single",
    autonomy: "verify",
    placement: "hosted",
    configDigest: `sha256:${ownerId}`,
  });
};

describe("two Owners through withOwner", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });

    await runtime.withOwner(ACME, (tx) => seed(tx, ACME));
    await runtime.withOwner(GLOBEX, (tx) => seed(tx, GLOBEX));
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  it("shows each Owner only its own rows, with no WHERE clause anywhere", async () => {
    const forAcme = await runtime.withOwner(ACME, (tx) =>
      tx.select().from(schema.run)
    );
    const forGlobex = await runtime.withOwner(GLOBEX, (tx) =>
      tx.select().from(schema.run)
    );

    expect(forAcme.map((row) => row.ownerId)).toStrictEqual([ACME]);
    expect(forGlobex.map((row) => row.ownerId)).toStrictEqual([GLOBEX]);

    // The admin connection, which is outside the boundary, holds both. So the
    // two reads above are the policy answering, not an empty database.
    const all = await database.admin<{ n: string }>(
      "select count(*)::text as n from run"
    );
    expect(all[0]?.n).toBe(SEEDED_RUNS);
  });

  it("rejects an insert carrying another Owner's id", async () => {
    // 42501 again, but raised by `WITH CHECK` rather than by a grant: the write
    // is refused for being outside the tenant, not for being unprivileged.
    await expect(
      driverFailure(
        runtime.withOwner(ACME, (tx) =>
          tx.insert(schema.finding).values({
            ownerId: GLOBEX,
            runId: crypto.randomUUID(),
            path: "src/index.ts",
            severity: "high",
            verification: "static",
            bucketKey: "smuggled",
            bucketKeyVersion: 1,
          })
        )
      )
    ).resolves.toStrictEqual({
      code: "42501",
      message: 'new row violates row-level security policy for table "finding"',
    });
  });

  it("refuses a Finding bound to another Owner's Run, which exists", async () => {
    // The row is impeccable from the tenant policy's side: it carries ACME's
    // `owner_id`, so `WITH CHECK` passes. What it points at is GLOBEX's Run, and
    // a single-column `run_id` reference would have accepted it - a foreign key
    // is checked as the *referenced* table's owner with row security off, so the
    // check sees a Run this Owner can never select and is satisfied. It is the
    // composite `(owner_id, run_id)` reference that makes the two facts one.
    //
    // The consequence is not only a stale row. Deleting GLOBEX's Run would then
    // cascade into ACME's Finding, across a boundary neither Owner can observe.
    const [foreign] = await database.admin<{ id: string }>(
      `select id from run where owner_id = ${GLOBEX}`
    );
    expect(foreign?.id).toBeDefined();

    const failure = await driverFailure(
      runtime.withOwner(ACME, (tx) =>
        tx.insert(schema.finding).values({
          ownerId: ACME,
          runId: foreign?.id ?? "",
          path: "src/index.ts",
          severity: "high",
          verification: "static",
          bucketKey: "cross-tenant",
          bucketKeyVersion: 1,
        })
      )
    );

    // 23503 is foreign_key_violation.
    expect(failure.code).toBe("23503");
    expect(failure.message).toContain("finding_run_owner_scoped_fk");
  });

  it("returns zero rows with no tenant context, rather than erroring", async () => {
    // The predicate is `nullif(current_setting(...), '')::bigint`, so an unset
    // GUC compares as NULL and the policy denies. The bare cast this replaced
    // raised `invalid input syntax for type bigint: ""` from inside the policy
    // once a pooler's reset had left an empty string behind, which turns a
    // deniable table into an unqueryable one.
    //
    // On a plain connection, because the client has no no-context transaction to
    // offer: ADR 0008 puts all access through `withOwner`, so what proves the
    // boundary denies is a measurement apparatus rather than an application
    // path. The rows exist - the admin count below says so.
    const rows = await onRuntimeConnection(DATABASE, async (client) => {
      await client.query("begin");
      try {
        const { rows: seen } = await client.query("select * from run");
        return seen;
      } finally {
        await client.query("rollback");
      }
    });

    expect(rows).toStrictEqual([]);
    const all = await database.admin<{ n: string }>(
      "select count(*)::text as n from run"
    );
    expect(all[0]?.n).toBe(SEEDED_RUNS);
  });

  it.each([
    ["not a number", Number.NaN],
    ["past the safe integer range", Number.MAX_SAFE_INTEGER + 2],
    ["fractional", 1.5],
    ["zero", 0],
    ["negative", -1001],
  ])("refuses an Owner id that is %s", async (_label, ownerId) => {
    // Every GitHub numeric id is a positive integer inside the safe range. A
    // value outside it either reaches the GUC as something Postgres reads as a
    // different tenant, or is a well-formed bigint naming no Owner - which would
    // be a query that quietly returns nothing rather than a call that fails.
    await expect(
      runtime.withOwner(ownerId, () => Promise.resolve(null))
    ).rejects.toThrow(TypeError);
  });
});
