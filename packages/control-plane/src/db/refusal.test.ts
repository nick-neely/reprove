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
  createInheritingRole,
  createMemberRole,
  createReplicationRole,
  createTestDatabase,
  onRuntimeConnection,
  RUNTIME_PASSWORD,
  runtimeUrl,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import type { BootRefusalError, CheckName } from "./refusal.js";
import { RUNTIME_ROLE } from "./roles.js";
import { createRuntimeDb } from "./runtime.js";
import { publication } from "./schema.js";

const BYPASSRLS_ROLE = "reprove_bypassrls";
const REPLICATION_ROLE = "reprove_replication";
const MEMBER_ROLE = "reprove_setrole_member";
const OWNER_ROLE = "reprove_test_owner";
const TRUNCATE_ROLE = "reprove_test_truncate";
const GROUP_ROLE = "reprove_test_group";
const INHERITOR_ROLE = "reprove_test_inheritor";

/** Creates a `nologin` role of the test's own, or leaves another file's alone. */
const defineGroup = (
  database: TestDatabase,
  role: string
): Promise<unknown[]> =>
  database.admin(
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${role}') then
         create role ${role} nologin;
       end if;
     end $$`
  );

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

  it("a role carrying REPLICATION, which never meets a policy at all", async () => {
    const database = await arrange("reprove_test_refusal_replication");
    // The flag that goes round the boundary rather than through it: a
    // replication connection streams the write-ahead log, and a base backup
    // copies the heap, so every Owner's rows arrive as bytes. Row-level security
    // is a planner rewrite and runs on neither path - no policy is ignored,
    // because none is consulted.
    await createReplicationRole(REPLICATION_ROLE);
    await database.admin(
      `grant connect on database "${database.name}" to "${REPLICATION_ROLE}"`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({
        connectionString: runtimeUrl(database.name, REPLICATION_ROLE),
      })
    );

    expect(failedChecks(refusal)).toContain("runtime-role-is-not-privileged");
    expect(detailOf(refusal, "runtime-role-is-not-privileged")).toContain(
      "REPLICATION"
    );
  });

  it("a role that carries nothing and is a member of three roles", async () => {
    const database = await arrange("reprove_test_refusal_set_role");
    // `NOINHERIT` does not stop `SET ROLE`. It stops the privileges arriving
    // implicitly, and the role below still holds everything every granted role
    // holds, for the asking - so a check that read only `current_user`'s own
    // flags would pass a connection one statement away from ignoring every
    // policy.
    //
    // Three arms at once, because they are refused for the same reason and only
    // one of them is visible to any other check. `reprove_bypassrls` carries the
    // attribute. `reprove_test_owner` carries none and simply owns `run`, which
    // is exemption from that table's own RLS unless FORCE is set and the right
    // to drop the policy either way. `reprove_test_truncate` carries nothing and
    // owns nothing: it holds one privilege on one managed table, which empties
    // another Owner's rows through a boundary that denies it every one of them -
    // and a rule that filtered these roles by elevation and ownership walked
    // straight past it, because the privilege queries read `current_user` alone.
    // Which is why the rule is now the membership itself.
    //
    // A role of the test's own on every end of every grant. A membership is
    // cluster-wide, and the other files in this folder are booting
    // `reprove_runtime` against the same cluster while this runs; the ownership
    // transfer and the TRUNCATE are confined to this test's database.
    await createBypassRlsRole(BYPASSRLS_ROLE);
    await defineGroup(database, OWNER_ROLE);
    await defineGroup(database, TRUNCATE_ROLE);
    await database.admin(`alter table run owner to ${OWNER_ROLE}`);
    await database.admin(`grant truncate on run to ${TRUNCATE_ROLE}`);
    await createMemberRole(MEMBER_ROLE, BYPASSRLS_ROLE);
    await createMemberRole(MEMBER_ROLE, OWNER_ROLE);
    await createMemberRole(MEMBER_ROLE, TRUNCATE_ROLE);
    await database.admin(
      `grant connect on database "${database.name}" to "${MEMBER_ROLE}"`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({
        connectionString: runtimeUrl(database.name, MEMBER_ROLE),
      })
    );

    expect(failedChecks(refusal)).toContain("runtime-role-is-not-privileged");
    // Spelled out whole, because what each name carries is the point: the two
    // roles something is known about are named with what is known, and
    // `reprove_test_truncate` is named with nothing after it and refused just
    // the same.
    expect(detailOf(refusal, "runtime-role-is-not-privileged")).toBe(
      `${MEMBER_ROLE} is a member of ${BYPASSRLS_ROLE} (BYPASSRLS), ` +
        `${OWNER_ROLE} (owns a managed table), ${TRUNCATE_ROLE}, and a ` +
        "membership is a SET ROLE path these checks cannot see through - " +
        "every privilege they read is current_user's own"
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
    // The other direction of the classification check: a table the schema module
    // manages that the database has never heard of.
    expect(detailOf(refusal, "every-managed-table-is-classified")).toContain(
      "managed but absent from the database: account"
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

  it("a policy the connected role reaches only through a group it inherits", async () => {
    const database = await arrange("reprove_test_refusal_inherited");
    // Role inheritance is a database fact with no representation in the schema
    // module, so only the catalog can see it. Postgres applies a policy through
    // an *inheritable* membership - measured, not assumed: the same grant made
    // `WITH INHERIT FALSE` leaves the policy inert, which is exactly what
    // `pg_has_role(..., 'usage')` reports.
    //
    // Measured on a login role of the test's own that inherits `reprove_runtime`
    // rather than on `reprove_runtime` itself, and the two are the same
    // connection as far as the policy check is concerned: it holds the runtime
    // role's grants and the canonical policies apply to it, through exactly the
    // membership under test. Granting the group to `reprove_runtime` would be a
    // cluster-wide change, and every boot the other files run beside this one
    // would refuse on the membership - which is now the point of check (a).
    await defineGroup(database, GROUP_ROLE);
    await createInheritingRole(INHERITOR_ROLE, [RUNTIME_ROLE, GROUP_ROLE]);
    await database.admin(
      `create policy run_group_open on run as permissive for all to ${GROUP_ROLE} using (true)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({
        connectionString: runtimeUrl(database.name, INHERITOR_ROLE),
      })
    );

    // Two refusals for two different reasons: the memberships themselves, and
    // the extra policy one of them carries in.
    expect(failedChecks(refusal)).toStrictEqual([
      "runtime-role-is-not-privileged",
      "tenant-policies-are-exactly-canonical",
    ]);
    expect(
      detailOf(refusal, "tenant-policies-are-exactly-canonical")
    ).toContain("run has 2 policies applying to this role");
  });

  it("a runtime role that owns a table, and is therefore exempt from its RLS", async () => {
    const database = await arrange("reprove_test_refusal_owned_table");
    // FORCE is what stops an owner being exempt from its own policies, and the
    // runtime role cannot create a table - but a table handed to it out of band
    // is still a table it owns.
    await database.admin("create table smuggled (owner_id bigint)");
    await database.admin(`alter table smuggled owner to ${RUNTIME_ROLE}`);

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "runtime-role-reaches-only-the-managed-tables",
    ]);
    expect(
      detailOf(refusal, "runtime-role-reaches-only-the-managed-tables")
    ).toContain("owns smuggled (relkind r) in public");
  });

  it("an admin-owned view over a tenant table, which reads every Owner", async () => {
    const database = await arrange("reprove_test_refusal_view");
    // The bypass every `relkind = 'r'` filter walked past. A view executes as
    // *its owner* unless it carries `security_invoker`, so this one reads `run`
    // as the admin - outside RLS entirely - and carries no policy of its own for
    // a policy check to find wrong.
    await database.admin(
      "insert into owner (id, login, type) values (1001, 'acme', 'organization')"
    );
    await database.admin(
      "insert into repository (id, owner_id, name_with_owner) values (10, 1001, 'acme/reprove')"
    );
    await database.admin(
      `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha,
                        provenance, provenance_basis, trigger, harness, model, strategy,
                        autonomy, placement, allow_hosted_fallback, resolved_config,
                        config_digest, claimable_until)
       values (1001, 10, 7, 'a', 'b', 'internal', '{}'::jsonb, 'automatic', 'codex',
               'gpt-5', 'single', 'verify', 'hosted', false, '{}'::jsonb, 'sha256:1',
               now())`
    );
    await database.admin("create view run_every_owner as select * from run");
    await database.admin(`grant select on run_every_owner to ${RUNTIME_ROLE}`);

    // Stated rather than assumed: with no Owner context at all, the view hands
    // the runtime role a row the tenant boundary denies it.
    const leaked = await onRuntimeConnection(database.name, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        "select count(*)::text as n from run_every_owner"
      );
      return rows[0]?.n;
    });
    expect(leaked).toBe("1");

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    // The only check that names it, which is the point: every other one ranges
    // over the managed tables and a view is not one of them.
    expect(failedChecks(refusal)).toStrictEqual([
      "runtime-role-reaches-only-the-managed-tables",
    ]);
    expect(
      detailOf(refusal, "runtime-role-reaches-only-the-managed-tables")
    ).toContain("reaches run_every_owner (relkind v) in public");
  });

  it("a runtime role granted TRUNCATE, which ignores row-level security", async () => {
    const database = await arrange("reprove_test_refusal_truncate");
    // No policy denies a TRUNCATE, because TRUNCATE is not a row operation. A
    // role holding it empties another Owner's table through a boundary that
    // denies it every individual row.
    await database.admin(`grant truncate on run to ${RUNTIME_ROLE}`);

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "runtime-role-reaches-only-the-managed-tables",
    ]);
    expect(
      detailOf(refusal, "runtime-role-reaches-only-the-managed-tables")
    ).toContain("holds TRUNCATE on run");
  });

  it("an unmanaged table in public the runtime role can read", async () => {
    const database = await arrange("reprove_test_refusal_unmanaged");
    // The same shape as a table added to the schema module and classified as
    // neither, reached through the real factory rather than through a doctored
    // classification: the boundary was never measured over this relation, so
    // whether it carries a tenant policy was never asked.
    await database.admin("create table stowaway (owner_id bigint)");
    await database.admin(`grant select on stowaway to ${RUNTIME_ROLE}`);

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "runtime-role-reaches-only-the-managed-tables",
    ]);
    expect(
      detailOf(refusal, "runtime-role-reaches-only-the-managed-tables")
    ).toContain("reaches stowaway (relkind r) in public");
  });

  it("a database ahead of the repository", async () => {
    const database = await arrange("reprove_test_refusal_ahead");
    await database.admin(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-the-future', 99999999999999)"
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "migrations-match-the-committed-files",
    ]);
    expect(detailOf(refusal, "migrations-match-the-committed-files")).toContain(
      "no journal entry, so the database is ahead of this build"
    );
  });

  it("a wide-open policy over a table that actually holds rows", async () => {
    const database = await arrange("reprove_test_refusal_open_policy");
    // The behavioural check is vacuous on an empty table, so this is the case
    // that shows it carries weight: a row exists, and no Owner context is set.
    await database.admin(
      "insert into owner (id, login, type) values (1001, 'acme', 'organization')"
    );
    await database.admin("drop policy owner_tenant on owner");
    await database.admin(
      `create policy owner_tenant on owner as permissive for all to ${RUNTIME_ROLE} using (true) with check (true)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toContain("no-owner-context-reads-empty");
    expect(detailOf(refusal, "no-owner-context-reads-empty")).toContain(
      "rows are visible with no tenant context in owner"
    );
  });

  it("a policy that guards a space instead of the empty string", async () => {
    const database = await arrange("reprove_test_refusal_space_guard");
    // `nullif(x, ' ')` is the bare cast wearing a disguise: a pooler's reset
    // leaves the GUC as the empty string, not a space, so the guard never fires
    // and `''::bigint` raises from inside the policy again.
    await database.admin("drop policy run_tenant on run");
    await database.admin(
      `create policy run_tenant on run as permissive for all to ${RUNTIME_ROLE}
         using (run.owner_id = nullif(current_setting('app.owner_id', true), ' ')::bigint)
         with check (run.owner_id = nullif(current_setting('app.owner_id', true), ' ')::bigint)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "tenant-policies-are-exactly-canonical",
    ]);
  });

  it("a policy reading a column that differs from the tenant key only in case", async () => {
    const database = await arrange("reprove_test_refusal_case_collision");
    // Postgres folds an unquoted identifier to lower case and leaves a quoted
    // one alone, so `"Owner_Id"` is a different column from `owner_id` - and a
    // policy comparing the wrong one is a tenant boundary over nothing.
    await database.admin('alter table run add column "Owner_Id" bigint');
    await database.admin("drop policy run_tenant on run");
    await database.admin(
      `create policy run_tenant on run as permissive for all to ${RUNTIME_ROLE}
         using ("Owner_Id" = nullif(current_setting('app.owner_id', true), '')::bigint)
         with check ("Owner_Id" = nullif(current_setting('app.owner_id', true), '')::bigint)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "tenant-policies-are-exactly-canonical",
    ]);
  });

  it("a policy predicate carrying a boolean connective", async () => {
    const database = await arrange("reprove_test_refusal_connective");
    // The normal form the comparison runs on drops parentheses, which is safe
    // only while no token binds across them. This predicate reads as the
    // canonical one plus a second escape hatch, and it is refused for carrying
    // the connective at all rather than for what this particular one does.
    await database.admin("drop policy run_tenant on run");
    await database.admin(
      `create policy run_tenant on run as permissive for all to ${RUNTIME_ROLE}
         using (run.owner_id = nullif(current_setting('app.owner_id', true), '')::bigint
                or current_setting('app.escape_hatch', true) = 'yes')
         with check (run.owner_id = nullif(current_setting('app.owner_id', true), '')::bigint)`
    );

    const refusal = await bootRefusal(
      createRuntimeDb({ connectionString: database.runtimeUrl })
    );

    expect(failedChecks(refusal)).toStrictEqual([
      "tenant-policies-are-exactly-canonical",
    ]);
    expect(
      detailOf(refusal, "tenant-policies-are-exactly-canonical")
    ).toContain("run's policy run_tenant has `or` in its using expression");
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

describe("boot serves", () => {
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((database) => database.drop()));
  });

  it("beside a neighbour's table the runtime role cannot reach", async () => {
    const database = await arrange("reprove_test_neighbour");
    // ADR 0010 permits Vercel Workflow to share this Postgres server, and ADR
    // 0017 keeps the assertion over Reprove's own boundary rather than over the
    // database. So the reach check is stated as reach and not as existence: a
    // relation beside Reprove's that the runtime role cannot touch is a
    // correctly-behaving neighbour, and refusing over it would be a production
    // refusal somebody else caused.
    //
    // It is also what proves the grants are manifest-scoped. Under the
    // `alter default privileges ... in schema public` this replaced, a table the
    // admin created after bootstrap arrived pre-granted to the runtime role, and
    // this case would refuse.
    await database.admin("create table neighbour_workload (id bigint)");

    const runtime = await createRuntimeDb({
      connectionString: database.runtimeUrl,
    });
    try {
      expect(runtime.checks.filter((check) => !check.ok)).toStrictEqual([]);
    } finally {
      await runtime.close();
    }
  });
});
