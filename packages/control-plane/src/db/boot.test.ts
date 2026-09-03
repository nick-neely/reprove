/**
 * Bootstrap, migrate, boot - the path a clean deployment takes, end to end,
 * against real Postgres behind real PgBouncer in transaction mode.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import { CLASSIFICATION, tableNames } from "./classification.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
  type TestDatabase,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import { createRuntimeDb, type RuntimeDb } from "./runtime.js";

const DATABASE = "reprove_test_boot";

let database: TestDatabase;
let runtime: RuntimeDb;

beforeAll(async () => {
  database = await createTestDatabase(DATABASE);
  await bootstrap({
    connectionString: database.adminUrl,
    runtimePassword: RUNTIME_PASSWORD,
  });
  await migrate({ connectionString: database.adminUrl });
  runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
});

afterAll(async () => {
  await runtime?.close();
  await database?.drop();
});

describe("a database bootstrapped and migrated from clean", () => {
  it("returns a client only after all seven of rule 6's checks pass", () => {
    expect(runtime.checks.filter((check) => !check.ok)).toStrictEqual([]);
    expect(runtime.checks.map((check) => check.name)).toStrictEqual([
      "runtime-role-is-not-privileged",
      "runtime-role-owns-no-table",
      "every-managed-table-is-classified",
      "tenant-tables-are-forced",
      "tenant-policies-are-exactly-canonical",
      "migrations-match-the-committed-files",
      "no-owner-context-reads-empty",
    ]);
  });

  it("creates all fourteen tables, with RLS enabled and forced on the ten", async () => {
    const rows = await database.admin<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`
    );

    expect(rows.map((row) => row.relname)).toStrictEqual(
      tableNames(CLASSIFICATION.managed)
    );
    expect(
      rows
        .filter((row) => row.relrowsecurity && row.relforcerowsecurity)
        .map((row) => row.relname)
    ).toStrictEqual(tableNames(CLASSIFICATION.tenant));
  });

  it("leaves nothing pending, so a second migrate applies nothing", async () => {
    await expect(
      migrate({ connectionString: database.adminUrl })
    ).resolves.toStrictEqual([]);
  });

  it("refuses the runtime role a table of its own", async () => {
    // A table the runtime role created would be a table it owns, and an owner
    // is exempt from its own RLS unless FORCE is set. Bootstrap revokes CREATE
    // on the schema - from the role and from PUBLIC - so the route is closed
    // rather than merely unused.
    const failure = await runtime
      .withoutOwner((tx) =>
        tx.execute(sql`create table smuggled (owner_id bigint)`)
      )
      .then(() => null, (error: unknown) => error);

    // Drizzle wraps the driver error, so the Postgres code - 42501,
    // insufficient_privilege - is on the cause rather than on the message.
    expect((failure as { cause?: unknown } | null)?.cause).toMatchObject({
      code: "42501",
      message: "permission denied for schema public",
    });
  });
});
