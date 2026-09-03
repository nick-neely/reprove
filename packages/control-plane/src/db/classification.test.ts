/**
 * The authoring-time half of the tenant boundary, measured against the schema
 * module alone.
 *
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)
 * splits the property across two layers and says neither half is sufficient:
 * this one sees the declared policies and proves the committed schema *intends*
 * the boundary, and the boot assertion sees `pg_policies` and proves what
 * actually deployed. There is no database here on purpose.
 */
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  MANAGED_TABLES,
  NON_TENANT_TABLES,
  TENANT_TABLES,
  tableName,
  tableNames,
} from "./classification.js";
import { RUNTIME_ROLE } from "./schema.js";

const dialect = new PgDialect();

/** ADR 0008's ten Owner-scoped tables plus Better Auth's four adopted ones. */
const MANAGED_TABLE_COUNT = 14;

/**
 * The column carrying the tenant key. It is `owner_id` on every Owner-scoped
 * table except `owner` itself, whose own primary key *is* GitHub's numeric
 * Owner id - which is why there is no second identifier beside it.
 */
const tenantKey = (table: PgTable): string =>
  getTableConfig(table).columns.some((column) => column.name === "owner_id")
    ? "owner_id"
    : "id";

/** Whether an index or a primary key covers a column, leading with it. */
const isIndexed = (table: PgTable, column: string): boolean => {
  const config = getTableConfig(table);
  const primary = config.columns.some(
    (candidate) => candidate.name === column && candidate.primary
  );
  const indexed = config.indexes.some(
    (index) =>
      (index.config.columns[0] as { name?: string } | undefined)?.name === column
  );
  return primary || indexed;
};

describe("the tenancy classification", () => {
  it("classifies every table the schema module manages, exactly once", () => {
    const managed = tableNames(MANAGED_TABLES);
    const tenant = tableNames(TENANT_TABLES);
    const nonTenant = tableNames(NON_TENANT_TABLES);

    expect(managed).toHaveLength(MANAGED_TABLE_COUNT);
    expect([...tenant, ...nonTenant].sort()).toStrictEqual(managed);
    expect(tenant.filter((name) => nonTenant.includes(name))).toStrictEqual([]);
  });

  it("holds ADR 0008's ten Owner-scoped tables and Better Auth's four", () => {
    expect(tableNames(TENANT_TABLES)).toStrictEqual([
      "enrollment_code",
      "finding",
      "ingress_delivery",
      "installation",
      "owner",
      "publication",
      "repository",
      "run",
      "worker",
      "worker_credential",
    ]);
    expect(tableNames(NON_TENANT_TABLES)).toStrictEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
  });

  it("indexes the tenant key on every Owner-scoped table", () => {
    const unindexed = TENANT_TABLES.filter(
      (table) => !isIndexed(table, tenantKey(table))
    ).map((table) => `${tableName(table)}.${tenantKey(table)}`);

    expect(unindexed).toStrictEqual([]);
  });

  it("declares exactly the canonical tenant policy on every tenant table", () => {
    for (const table of TENANT_TABLES) {
      const name = tableName(table);
      const policies = getTableConfig(table).policies;

      // Set equality, not membership. Postgres combines permissive policies by
      // OR, so a second one sitting beside a correct tenant policy is a full
      // tenant bypass that every presence check passes.
      expect(policies).toHaveLength(1);
      const policy = policies[0];
      const predicate = `"${name}"."${tenantKey(table)}" = nullif(current_setting('app.owner_id', true), '')::bigint`;

      expect({
        name: policy?.name,
        as: policy?.as ?? "permissive",
        for: policy?.for,
        to: (policy?.to as { name?: string } | undefined)?.name,
        using: policy?.using && dialect.sqlToQuery(policy.using).sql,
        withCheck: policy?.withCheck && dialect.sqlToQuery(policy.withCheck).sql,
      }).toStrictEqual({
        name: `${name}_tenant`,
        as: "permissive",
        for: "all",
        to: RUNTIME_ROLE,
        // The `nullif` is the whole point. A bare `::bigint` cast is correct on
        // every direct connection and raises `invalid input syntax for type
        // bigint: ""` from inside the policy once a pooler's reset has left the
        // GUC as the empty string, which turns a deniable table into an
        // unqueryable one.
        using: predicate,
        withCheck: predicate,
      });
    }
  });

  it("declares no policy on a non-tenant table", () => {
    const withPolicies = NON_TENANT_TABLES.filter(
      (table) => getTableConfig(table).policies.length > 0
    ).map(tableName);

    expect(withPolicies).toStrictEqual([]);
  });
});
