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
import type { PgColumn, PgPolicy, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  MANAGED_TABLES,
  NON_TENANT_TABLES,
  TENANT_TABLES,
  tableName,
  tableNames,
} from "./classification.js";
import { RUNTIME_ROLE } from "./roles.js";
import { tenantPolicy } from "./schema.js";

const dialect = new PgDialect();

/** ADR 0008's ten Owner-scoped tables plus Better Auth's four adopted ones. */
const MANAGED_TABLE_COUNT = 14;

/**
 * The column carrying the tenant key. It is `owner_id` on every Owner-scoped
 * table except `owner` itself, whose own primary key *is* GitHub's numeric
 * Owner id - which is why there is no second identifier beside it.
 */
const tenantKey = (table: PgTable): PgColumn => {
  const { columns, name } = getTableConfig(table);
  const key =
    columns.find((column) => column.name === "owner_id") ??
    columns.find((column) => column.primary);
  if (key === undefined) {
    throw new Error(`${name} carries neither owner_id nor a primary key`);
  }
  return key;
};

/** Whether an index or a primary key covers a column, leading with it. */
const isIndexed = (table: PgTable, column: string): boolean => {
  const config = getTableConfig(table);
  const primary = config.columns.some(
    (candidate) => candidate.name === column && candidate.primary
  );
  const indexed = config.indexes.some((index) => {
    const [leading] = index.config.columns;
    // SAFETY: an index column is either a column, which carries a name, or a
    // raw SQL expression, which does not. Only the first form can match a
    // column name, and the second reads as undefined.
    const named = leading as { name?: string } | undefined;
    return named?.name === column;
  });
  return primary || indexed;
};

/**
 * A declared policy reduced to the facts a comparison is about, with both
 * predicates rendered by the pinned dialect.
 */
const render = (policy: PgPolicy | undefined) => ({
  name: policy?.name,
  as: policy?.as ?? "permissive",
  for: policy?.for,
  // SAFETY: every policy compared here is declared with `to: runtimeRole`, so
  // the value is the role object rather than one of the string forms Drizzle
  // also accepts. A different spelling reads as undefined and fails.
  to: (policy?.to as { name?: string } | undefined)?.name,
  using: policy?.using && dialect.sqlToQuery(policy.using).sql,
  withCheck: policy?.withCheck && dialect.sqlToQuery(policy.withCheck).sql,
});

describe("the tenancy classification", () => {
  it("classifies every table the schema module manages, exactly once", () => {
    const managed = tableNames(MANAGED_TABLES);
    const tenant = tableNames(TENANT_TABLES);
    const nonTenant = tableNames(NON_TENANT_TABLES);

    expect(managed).toHaveLength(MANAGED_TABLE_COUNT);
    expect([...tenant, ...nonTenant].toSorted()).toStrictEqual(managed);
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
      (table) => !isIndexed(table, tenantKey(table).name)
    ).map((table) => `${tableName(table)}.${tenantKey(table).name}`);

    expect(unindexed).toStrictEqual([]);
  });

  it("declares exactly the canonical tenant policy on every tenant table", () => {
    for (const table of TENANT_TABLES) {
      const name = tableName(table);
      const { policies } = getTableConfig(table);

      // Set equality, not membership. Postgres combines permissive policies by
      // OR, so a second one sitting beside a correct tenant policy is a full
      // tenant bypass that every presence check passes.
      expect(policies).toHaveLength(1);

      // The comparison is against what the pinned dialect renders for
      // `tenantPolicy()`, not against a SQL literal frozen into this file
      // (ADR 0017). That is what preserves ADR 0008's hardest-won fix - the
      // `nullif` rather than a bare `::bigint` cast, correct on every direct
      // connection and an outage behind a pooler after a reset - without
      // fossilising its spelling. What this file still declares is the
      // convention around it: the policy's name, and which column is the
      // tenant key.
      expect(render(policies[0])).toStrictEqual(
        render(tenantPolicy(`${name}_tenant`, tenantKey(table)))
      );
    }
  });

  it("applies that policy to the restricted runtime role and to no other", () => {
    // Asserted against the constant rather than against `tenantPolicy()`, which
    // is where the role comes from: comparing the helper to itself would say
    // nothing about which role the boundary is granted to.
    const to = TENANT_TABLES.map(
      (table) => render(getTableConfig(table).policies[0]).to
    );

    expect([...new Set(to)]).toStrictEqual([RUNTIME_ROLE]);
  });

  it("declares no policy on a non-tenant table", () => {
    const withPolicies = NON_TENANT_TABLES.filter(
      (table) => getTableConfig(table).policies.length > 0
    ).map(tableName);

    expect(withPolicies).toStrictEqual([]);
  });
});
