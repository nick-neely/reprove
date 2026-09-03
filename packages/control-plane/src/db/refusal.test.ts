/**
 * Every shape of drift that must refuse to serve.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s
 * rule 6 is what makes the other five falsifiable, and rule 4 in particular
 * fails **silently** - connect as a role carrying `BYPASSRLS` and every policy is
 * ignored with no error, warning or notice raised anywhere. So each case here
 * breaks the boundary in one specific way and asserts which check names it.
 *
 * Each case gets a database of its own, because the arrangements are destructive
 * and a repair between them would be one more thing to get wrong.
 */
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import { assertTenantBoundary } from "./checks.js";
import { CLASSIFICATION, tableName } from "./classification.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  bootRefusal,
  createBypassRlsRole,
  createTestDatabase,
  RUNTIME_PASSWORD,
  runtimeUrl,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import type { BootRefusalError, CheckName } from "./refusal.js";
import { RUNTIME_ROLE } from "./roles.js";
import { createRuntimeDb } from "./runtime.js";
import { publication } from "./schema.js";

const BYPASSRLS_ROLE = "reprove_bypassrls";

const opened: TestDatabase[] = [];

/** A database of one case's own, bootstrapped and optionally migrated. */
const arrange = async (
  name: string,
  { migrated = true } = {}
): Promise<TestDatabase> => {
  const database = await createTestDatabase(name);
  opened.push(database);
  await bootstrap({
    connectionString: database.adminUrl,
    runtimePassword: RUNTIME_PASSWORD,
  });
  if (migrated) {
    await migrate({ connectionString: database.adminUrl });
  }
  return database;
};

const failedChecks = (refusal: BootRefusalError): CheckName[] =>
  refusal.checks.filter((check) => !check.ok).map((check) => check.name);

const detailOf = (refusal: BootRefusalError, name: CheckName): string =>
  refusal.checks.find((check) => check.name === name)?.detail ?? "";

describe("boot refuses to serve", () => {
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((database) => database.drop()));
  });

  it("a role carrying BYPASSRLS, which would ignore every policy silently", async () => {
    const database = await arrange("reprove_test_refusal_bypassrls");
    await createBypassRlsRole(BYPASSRLS_ROLE);
    await database.admin(
      `grant connect on database "${database.name}" to "${BYPASSRLS_ROLE}"`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({
        connectionString: runtimeUrl(database.name, BYPASSRLS_ROLE),
      })
    );

    expect(failedChecks(refusal)).toContain("runtime-role-is-not-privileged");
    expect(detailOf(refusal, "runtime-role-is-not-privileged")).toContain(
      "BYPASSRLS"
    );
  });

  it("a tenant table whose FORCE was removed out of band", async () => {
    const database = await arrange("reprove_test_refusal_unforced");
    await database.admin("alter table run no force row level security");

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual(["tenant-tables-are-forced"]);
    expect(detailOf(refusal, "tenant-tables-are-forced")).toContain(
      "run (not FORCEd)"
    );
  });

  it("a managed table nobody classified", async () => {
    const database = await arrange("reprove_test_refusal_unclassified");

    // The production classification has no seam a test could reach through, by
    // design: `createRuntimeDb` never takes one. What a developer would actually
    // do wrong is add a `pgTable` to the schema module and leave it out of both
    // sets, so that is what is presented here - the same managed universe, with
    // one table classified as neither.
    const unclassified = {
      ...CLASSIFICATION,
      tenant: CLASSIFICATION.tenant.filter(
        (table) => tableName(table) !== tableName(publication)
      ),
    };

    const pool = new Pool({ connectionString: database.runtimeUrl, max: 1 });
    try {
      const refusal = await bootRefusal(
        assertTenantBoundary(pool, unclassified)
      );

      expect(failedChecks(refusal)).toStrictEqual([
        "every-managed-table-is-classified",
      ]);
      expect(detailOf(refusal, "every-managed-table-is-classified")).toContain(
        "classified as neither tenant nor non-tenant: publication"
      );
    } finally {
      await pool.end();
    }
  });

  it("a deployment behind its migration journal, naming what is pending", async () => {
    const database = await arrange("reprove_test_refusal_pending", {
      migrated: false,
    });

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toContain(
      "migrations-match-the-committed-files"
    );
    expect(detailOf(refusal, "migrations-match-the-committed-files")).toContain(
      "0000_initial_schema, 0001_force_row_level_security"
    );
  });

  it("an applied migration whose committed file changed underneath it", async () => {
    const database = await arrange("reprove_test_refusal_edited");
    await database.admin(
      "update drizzle.__drizzle_migrations set hash = 'edited' where created_at = (select min(created_at) from drizzle.__drizzle_migrations)"
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "migrations-match-the-committed-files",
    ]);
    expect(detailOf(refusal, "migrations-match-the-committed-files")).toContain(
      "no longer matching the committed file: 0000_initial_schema"
    );
  });

  it("a hand-rolled policy carrying the bare ::bigint cast", async () => {
    const database = await arrange("reprove_test_refusal_bare_cast");
    // Correct on every direct connection, and an outage behind a pooler once a
    // reset has left the GUC as the empty string. A "has a policy on the runtime
    // role" check would pass this; set equality against what the pinned dialect
    // renders does not.
    await database.admin("drop policy run_tenant on run");
    await database.admin(
      `create policy run_tenant on run as permissive for all to ${RUNTIME_ROLE}
         using (run.owner_id = current_setting('app.owner_id', true)::bigint)
         with check (run.owner_id = current_setting('app.owner_id', true)::bigint)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "tenant-policies-are-exactly-canonical",
    ]);
    expect(
      detailOf(refusal, "tenant-policies-are-exactly-canonical")
    ).toContain("run carries run_tenant");
  });

  it("a second permissive policy beside a correct one", async () => {
    const database = await arrange("reprove_test_refusal_second_policy");
    // Postgres combines permissive policies by OR, so this is a full tenant
    // bypass that every presence check passes.
    await database.admin(
      `create policy run_open on run as permissive for all to ${RUNTIME_ROLE} using (true)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "tenant-policies-are-exactly-canonical",
    ]);
    expect(
      detailOf(refusal, "tenant-policies-are-exactly-canonical")
    ).toContain("run has 2 policies applying to this role");
  });
});
