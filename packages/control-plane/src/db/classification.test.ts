/**
 * The managed universe and the two declared sets over it.
 *
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)'s
 * whole argument is that the universe is enumerated from a source the
 * classification does not control, so a table added to the schema module and
 * left out of both sets fails. What each classified table then has to *declare*
 * is `declared.ts`'s to check, and `declared.test.ts` is where a malformed
 * declaration is shown to fail; this file is about the sets.
 */
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  MANAGED_TABLES,
  NON_TENANT_TABLES,
  TENANT_TABLES,
  tableName,
  tableNames,
} from "./classification.js";
import { tenantKey } from "./policy.js";
import * as schema from "./schema.js";

/** ADR 0008's ten Owner-scoped tables plus Better Auth's four adopted ones. */
const MANAGED_TABLE_COUNT = 14;

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

  it("enumerates the universe from the schema module, not from the two sets", () => {
    // Identity, not names, and in both directions. This is what stops "every
    // managed table is classified" from being the tautology ADR 0014 left
    // behind, and each direction refuses a different mistake: a managed table
    // the schema module never exported means the universe was written by hand,
    // and an exported table the universe omits means a table the classification
    // is never measured over.
    //
    // The second direction is unreachable while `MANAGED_TABLES` is a filter
    // over `Object.values(schema)`, which is exactly what it is here for: the
    // derivation is the property, and a hand-maintained list that happened to be
    // complete on the day it was written would pass every other test in this
    // file.
    // Widened to `unknown[]` first, the way `classification.ts` does it: the
    // namespace's own type is a union of fourteen specific table types, which a
    // `PgTable` predicate is not assignable to.
    const schemaExports: unknown[] = Object.values(schema);
    const exported = schemaExports.filter((entity): entity is PgTable =>
      is(entity, PgTable)
    );
    const managed = new Set<unknown>(MANAGED_TABLES);

    expect(
      MANAGED_TABLES.filter((table) => !exported.includes(table))
    ).toStrictEqual([]);
    expect(exported.filter((table) => !managed.has(table))).toStrictEqual([]);
  });
});
