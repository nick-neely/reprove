/**
 * Bootstrap, migrate, boot - the path a clean deployment takes, end to end,
 * against real Postgres behind real PgBouncer in transaction mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import { CLASSIFICATION, tableNames } from "./classification.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  createTestDatabase,
  driverFailure,
  onRuntimeConnection,
  RUNTIME_PASSWORD,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import { readCommittedMigrations } from "./migrations.js";
import { RUNTIME_ROLE } from "./roles.js";
import type { RuntimeDb } from "./runtime.js";
import { createRuntimeDb } from "./runtime.js";

const DATABASE = "reprove_test_boot";

let database: TestDatabase;
let runtime: RuntimeDb;

describe("a database bootstrapped and migrated from clean", () => {
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

  it("returns a client only after all seven of rule 6's checks pass", () => {
    expect(runtime.checks.filter((check) => !check.ok)).toStrictEqual([]);
    expect(runtime.checks.map((check) => check.name)).toStrictEqual([
      "runtime-role-is-not-privileged",
      "runtime-role-reaches-only-the-managed-tables",
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

    // Asserted separately, because "applied nothing" is also what a migrate
    // that silently failed to detect an application would return.
    const ledger = await database.admin<{ n: string }>(
      "select count(*)::text as n from drizzle.__drizzle_migrations"
    );
    expect(ledger[0]?.n).toBe(String(readCommittedMigrations().length));
  });

  it("grants the runtime role exactly four verbs on the managed tables", async () => {
    const rows = await database.admin<{
      relname: string;
      privilege: string;
      held: boolean;
    }>(
      `select c.relname, p.privilege,
              has_table_privilege('${RUNTIME_ROLE}', c.oid, p.privilege) as held
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE',
                                 'TRUNCATE','REFERENCES','TRIGGER']) as p(privilege)
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname, p.privilege`
    );

    const held = new Set(
      rows.filter((row) => row.held).map((row) => row.privilege)
    );
    // Set equality across every managed table at once: four verbs held on all
    // fourteen, and the three that are never held on any.
    expect([...held].toSorted()).toStrictEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    expect(
      rows.filter((row) => row.privilege === "SELECT" && row.held)
    ).toHaveLength(tableNames(CLASSIFICATION.managed).length);
  });

  it("re-applies those grants on a migrate that applies nothing", async () => {
    // The grants moved out of `bootstrap` and into `migrate`, because they name
    // the managed tables one by one and only `migrate` knows those tables exist.
    // That has to leave an operator a repair, so a `migrate` with no pending
    // migration still brings the privileges back to what the code declares.
    await database.admin(`revoke select on run from ${RUNTIME_ROLE}`);
    await database.admin(`grant truncate on run to ${RUNTIME_ROLE}`);

    await expect(
      migrate({ connectionString: database.adminUrl })
    ).resolves.toStrictEqual([]);

    const rows = await database.admin<{ select: boolean; truncate: boolean }>(
      `select has_table_privilege('${RUNTIME_ROLE}', 'run', 'SELECT') as select,
              has_table_privilege('${RUNTIME_ROLE}', 'run', 'TRUNCATE') as truncate`
    );
    expect(rows[0]).toStrictEqual({ select: true, truncate: false });
  });

  it("refuses the runtime role a table of its own", async () => {
    // A table the runtime role created would be a table it owns, and an owner is
    // exempt from its own RLS unless FORCE is set. Bootstrap revokes CREATE on
    // the schema - from the role and from PUBLIC - so the route is closed rather
    // than merely unused.
    //
    // Attempted on a plain connection rather than through the client: the client
    // has one entry point, and it is `withOwner`.
    await expect(
      driverFailure(
        onRuntimeConnection(database.name, (client) =>
          client.query("create table smuggled (owner_id bigint)")
        )
      )
      // 42501 is insufficient_privilege.
    ).resolves.toStrictEqual({
      code: "42501",
      message: "permission denied for schema public",
    });
  });

  it("refuses the runtime role a temporary table, which would shadow one", async () => {
    // `pg_temp` resolves before `public`, so a temporary `run` would shadow the
    // managed one with a relation the role owns and is therefore exempt from the
    // policies on. The check that the role owns no relation looks in `public`
    // and would never see it, so the privilege is revoked instead.
    const failure = await driverFailure(
      onRuntimeConnection(database.name, (client) =>
        client.query("create temporary table run (owner_id bigint)")
      )
    );

    expect(failure.code).toBe("42501");
  });
});
