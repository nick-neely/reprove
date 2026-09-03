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
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import type { TestDatabase } from "./local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "./local-stack.test-support.js";
import { RUNTIME_ROLE } from "./roles.js";

const FIRST_DATABASE = "reprove_test_bootstrap_first";
const SECOND_DATABASE = "reprove_test_bootstrap_second";

/** The negative flags {@link bootstrap} spells out, as `pg_roles` reports them. */
interface RoleFlags {
  readonly rolcanlogin: boolean;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolinherit: boolean;
}

let first: TestDatabase;
let second: TestDatabase;

const provision = (database: TestDatabase): Promise<void> =>
  bootstrap({
    connectionString: database.adminUrl,
    runtimePassword: RUNTIME_PASSWORD,
  });

const runtimeRoleFlags = async (): Promise<RoleFlags | undefined> => {
  const rows = await first.admin<RoleFlags>(
    `select rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
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
      rolsuper: false,
    });
  });
});
