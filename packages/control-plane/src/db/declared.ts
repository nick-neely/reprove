/**
 * The authoring-time half of the tenant boundary, measured against the schema
 * module alone.
 *
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)
 * splits the property across two layers and says neither half is sufficient:
 * this one sees the declared policies and proves the committed schema *intends*
 * the boundary, and the boot assertion sees `pg_policies` and proves what
 * actually deployed. There is no database here on purpose, which is what lets it
 * fail on the pull request that introduced an unclassified or unpolicied table
 * rather than in a deployment.
 *
 * It is a function over a {@link Classification} rather than a set of assertions
 * over the real one, because "a malformed classification fails" is the property
 * and a test can only measure it by presenting one.
 */
import type { PgTable } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";

import type { Classification } from "./classification.js";
import { CLASSIFICATION, tableName, tableNames } from "./classification.js";
import {
  canonicalPolicy,
  declaredPolicy,
  describePolicy,
  samePolicy,
} from "./policy.js";

/**
 * The set arithmetic ADR 0017 states, and nothing else:
 *
 * ```text
 * MANAGED_TABLES == TENANT_TABLES ∪ NON_TENANT_TABLES
 * TENANT_TABLES  ∩  NON_TENANT_TABLES == ∅
 * ```
 *
 * The managed set is enumerated from the schema module's `pgTable` exports, so
 * a table added there and left out of both declared sets is a problem here
 * rather than a table sitting silently outside the tenant boundary.
 *
 * Shared with the boot assertion, which adds the one clause that needs a
 * database to answer.
 *
 * @param classification The classification to measure.
 * @returns One message per broken clause, empty when the three hold.
 */
export const classificationProblems = (
  classification: Classification
): string[] => {
  const managed = tableNames(classification.managed);
  const tenant = new Set(tableNames(classification.tenant));
  const nonTenant = new Set(tableNames(classification.nonTenant));

  const unclassified = managed.filter(
    (name) => !(tenant.has(name) || nonTenant.has(name))
  );
  const both = managed.filter(
    (name) => tenant.has(name) && nonTenant.has(name)
  );
  const unmanaged = [...tenant, ...nonTenant].filter(
    (name) => !managed.includes(name)
  );

  return [
    unclassified.length > 0
      ? `managed but classified as neither tenant nor non-tenant: ${unclassified.join(", ")}`
      : null,
    both.length > 0 ? `classified as both: ${both.join(", ")}` : null,
    unmanaged.length > 0
      ? `classified but not managed by the schema module: ${unmanaged.join(", ")}`
      : null,
  ].filter((problem) => problem !== null);
};

/**
 * Set equality, not membership, for one tenant table's declared policies.
 *
 * Postgres combines permissive policies by OR, so a second permissive policy
 * sitting *beside* a correct tenant policy is a full tenant bypass that every
 * presence check passes. The comparison is against what the pinned dialect
 * renders for `tenantPolicy()` rather than against a frozen SQL literal, so a
 * hand-rolled policy carrying ADR 0008's bare `::bigint` cast fails here.
 */
const tenantPolicyProblem = (table: PgTable): string | null => {
  const name = tableName(table);
  const declared = declaredPolicy(table);
  if ("problem" in declared) {
    return declared.problem;
  }
  return samePolicy(declared.policy, canonicalPolicy(table))
    ? null
    : `${name} declares ${describePolicy(declared.policy)} where the canonical tenant policy is ${describePolicy(canonicalPolicy(table))}`;
};

/**
 * Everything the schema module alone can be held to.
 *
 * @param classification The classification to measure. Defaults to the real one,
 *   which is what the test asserting the repository holds passes.
 * @returns One message per problem, empty when the committed schema intends the
 *   boundary.
 */
export const checkDeclaredTenancy = (
  classification: Classification = CLASSIFICATION
): string[] => {
  const problems = classificationProblems(classification);

  for (const table of classification.tenant) {
    const problem = tenantPolicyProblem(table);
    if (problem !== null) {
      problems.push(problem);
    }
  }

  for (const table of classification.nonTenant) {
    const { policies } = getTableConfig(table);
    if (policies.length > 0) {
      problems.push(
        `${tableName(table)} is non-tenant and must declare no policy, but declares ${policies.map((policy) => policy.name).join(", ")}`
      );
    }
  }

  return problems;
};
