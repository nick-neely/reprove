/**
 * Two Owners, one code path, and what Postgres does about it.
 *
 * The point of [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s first
 * decision is that a forgotten `WHERE owner_id` returns another Owner's
 * Findings under application scoping alone, and returns zero rows under RLS.
 * Every query below is deliberately written without a tenant predicate, so what
 * it returns is the boundary's answer rather than the query's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
  type TestDatabase,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import { createRuntimeDb, type RuntimeDb } from "./runtime.js";
import * as schema from "./schema.js";
import type { TenantTransaction } from "./runtime.js";

const DATABASE = "reprove_test_tenancy";

/** GitHub numeric Owner ids, which are the tenant keys themselves. */
const ACME = 1_001;
const GLOBEX = 2_002;

let database: TestDatabase;
let runtime: RuntimeDb;

/** One Owner with one Repository and one queued Run, all through `withOwner`. */
async function seed(tx: TenantTransaction, ownerId: number): Promise<void> {
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
}

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

describe("two Owners through withOwner", () => {
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
    expect(all[0]?.n).toBe("2");
  });

  it("rejects an insert carrying another Owner's id", async () => {
    const failure = await runtime
      .withOwner(ACME, (tx) =>
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
      .then(
        () => null,
        (error: unknown) => error
      );

    // 42501, but raised by `WITH CHECK` rather than by a grant: the write is
    // refused for being outside the tenant, not for being unprivileged.
    expect((failure as { cause?: unknown } | null)?.cause).toMatchObject({
      code: "42501",
      message: 'new row violates row-level security policy for table "finding"',
    });
  });

  it("returns zero rows with no tenant context, rather than erroring", async () => {
    // The predicate is `nullif(current_setting(...), '')::bigint`, so an unset
    // GUC compares as NULL and the policy denies. The bare cast this replaced
    // raised `invalid input syntax for type bigint: ""` from inside the policy
    // once a pooler's reset had left an empty string behind, which turns a
    // deniable table into an unqueryable one.
    const rows = await runtime.withoutOwner((tx) =>
      tx.select().from(schema.run)
    );
    expect(rows).toStrictEqual([]);
  });

  it("refuses an Owner id that is not one of GitHub's", () => {
    expect(() =>
      runtime.withOwner(Number.NaN, () => Promise.resolve(null))
    ).toThrow(TypeError);
  });
});
