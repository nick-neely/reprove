/**
 * `bootstrap()` with another `bootstrap()` running against the same cluster.
 *
 * It is not a hypothetical: the runtime role is a cluster-wide object, so every
 * deployment instance that boots at once and every test file in this folder -
 * each with a database of its own, run in parallel - provisions the same role.
 * Both shapes are here, because they fail differently. Two bootstraps in one
 * database queue on the advisory lock; two in different databases cannot, since
 * an advisory lock is per database, and the one that loses re-runs instead.
 *
 * Written the other way round first, against the previous implementation, where
 * both cases raise `tuple concurrently updated` - and the collision the create
 * was said to absorb turns out to arrive as a unique violation on `pg_authid`
 * rather than as a duplicate object.
 *
 * The repair half of the same command is here too: what `bootstrap` takes away
 * from a role it finds already provisioned. The flags are measured above; the
 * memberships are measured below, on roles of this file's own, because the boot
 * assertion refuses a membership outright and the runtime role is shared with
 * every file booting beside this one.
 */
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "./local-stack.test-support.js";
import { revokeMemberships } from "./privileges.js";
import { RUNTIME_ROLE } from "./roles.js";

const FIRST_DATABASE = "reprove_test_bootstrap_first";
const SECOND_DATABASE = "reprove_test_bootstrap_second";
const REPAIR_DATABASE = "reprove_test_bootstrap_repair";

/** A `nologin` role of this file's own, standing in for the runtime role. */
const STRAY_MEMBER = "reprove_test_stray_member";
/** What somebody granted it out of band. */
const STRAY_GROUP = "reprove_test_stray_group";

/** The negative flags {@link bootstrap} spells out, as `pg_roles` reports them. */
interface RoleFlags {
  readonly rolcanlogin: boolean;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolreplication: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
}

let first: TestDatabase;
let second: TestDatabase;
let repair: TestDatabase;

/** The roles a role is a direct member of, which is what the repair removes. */
const membershipsOf = async (member: string): Promise<string[]> => {
  const rows = await repair.admin<{ granted: string }>(
    `select g.rolname as granted
       from pg_auth_members m
       join pg_roles g on g.oid = m.roleid
       join pg_roles r on r.oid = m.member
      where r.rolname = '${member}'
      order by g.rolname`
  );
  return rows.map(({ granted }) => granted);
};

/**
 * One admin client, because that is what the repair takes: in production it runs
 * inside `bootstrap`'s transaction rather than opening a connection of its own.
 */
const onAdminClient = async <T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const pool = new Pool({ connectionString: repair.adminUrl, max: 1 });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
};

const provision = (database: TestDatabase): Promise<void> =>
  bootstrap({
    connectionString: database.adminUrl,
    runtimePassword: RUNTIME_PASSWORD,
  });

const runtimeRoleFlags = async (): Promise<RoleFlags | undefined> => {
  const rows = await first.admin<RoleFlags>(
    `select rolcanlogin, rolsuper, rolbypassrls, rolreplication,
            rolcreatedb, rolcreaterole, rolinherit
       from pg_roles where rolname = '${RUNTIME_ROLE}'`
  );
  return rows[0];
};

describe("two bootstraps started together", () => {
  beforeAll(async () => {
    first = await createTestDatabase(FIRST_DATABASE);
    second = await createTestDatabase(SECOND_DATABASE);
  });

  afterAll(async () => {
    await first?.drop();
    await second?.drop();
  });

  it("both settle, against two databases in one cluster", async () => {
    await expect(
      Promise.all([provision(first), provision(second)])
    ).resolves.toStrictEqual([undefined, undefined]);
  });

  it("both settle, against one database", async () => {
    await expect(
      Promise.all([provision(first), provision(first)])
    ).resolves.toStrictEqual([undefined, undefined]);
  });

  it("leave the runtime role exactly as one of them would", async () => {
    await provision(first);
    const alone = await runtimeRoleFlags();

    await Promise.all([provision(first), provision(second)]);

    await expect(runtimeRoleFlags()).resolves.toStrictEqual(alone);
    expect(alone).toStrictEqual({
      rolbypassrls: false,
      rolcanlogin: true,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolsuper: false,
    });
  });
});

describe("the membership repair", () => {
  beforeAll(async () => {
    repair = await createTestDatabase(REPAIR_DATABASE);
  });

  afterAll(async () => {
    await repair?.drop();
  });

  it("revokes every membership the role holds, and re-runs to no effect", async () => {
    // Measured against roles of this file's own rather than against
    // `reprove_runtime`, which is what the parameter on `revokeMemberships`
    // exists for. A membership is a cluster-wide object and the boot assertion
    // now refuses one outright, so granting one to the runtime role would refuse
    // every boot the other files in this folder run in parallel with this line.
    await repair.admin(`do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${STRAY_MEMBER}') then
         create role ${STRAY_MEMBER} nologin noinherit;
       end if;
       if not exists (select 1 from pg_roles where rolname = '${STRAY_GROUP}') then
         create role ${STRAY_GROUP} nologin;
       end if;
     end $$`);
    await repair.admin(`grant ${STRAY_GROUP} to ${STRAY_MEMBER}`);
    await expect(membershipsOf(STRAY_MEMBER)).resolves.toStrictEqual([
      STRAY_GROUP,
    ]);

    // `NOINHERIT` is deliberate on the member: the grant confers nothing
    // implicitly, and it is still the `SET ROLE` path the repair exists to
    // remove.
    const revoked = await onAdminClient((client) =>
      revokeMemberships(client, STRAY_MEMBER)
    );
    expect(revoked).toStrictEqual([STRAY_GROUP]);
    await expect(membershipsOf(STRAY_MEMBER)).resolves.toStrictEqual([]);

    // Re-running `bootstrap` is how an operator repairs one, so the second run
    // has to be a no-op rather than an error.
    await expect(
      onAdminClient((client) => revokeMemberships(client, STRAY_MEMBER))
    ).resolves.toStrictEqual([]);
  });
});
