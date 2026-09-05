/**
 * One policy, in the form the two layers of
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md) can
 * compare.
 *
 * The property splits across two layers - the schema module's declared policies
 * and `pg_policies` - and neither half is sufficient. Both nonetheless answer
 * the same question, "is this exactly the canonical tenant policy", so the
 * reduction to a comparable value lives here rather than twice: a second
 * spelling would agree on the day it was written and stop agreeing the day one
 * of them changed.
 *
 * There is no database here, which is what lets the authoring-time check in
 * `declared.ts` use it with no Postgres to run against.
 */
import { is } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn, PgPolicyToOption, PgTable } from "drizzle-orm/pg-core";
import { getTableConfig, PgDialect, PgRole } from "drizzle-orm/pg-core";

import { tableName } from "./classification.js";
import { normalizePredicate } from "./predicate.js";
import { RUNTIME_ROLE } from "./roles.js";
import { tenantPolicy } from "./schema.js";

const DIALECT = new PgDialect();

/**
 * One side of a policy as the pinned dialect renders it. An absent expression
 * reads as the empty string rather than throwing, because "declares no using
 * expression" is a comparison this module reports on rather than a crash.
 */
const render = (expression: SQL | undefined): string =>
  expression === undefined ? "" : DIALECT.sqlToQuery(expression).sql;

/** A policy as either the schema module declares it or the catalog holds it. */
export interface Policy {
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  readonly roles: readonly string[];
  readonly using: string;
  readonly withCheck: string;
}

export const describePolicy = (policy: Policy): string =>
  `${policy.name} ${policy.permissive ? "permissive" : "restrictive"} for ${policy.command} to ${[...policy.roles].toSorted().join(",")} using ${policy.using} with check ${policy.withCheck}`;

export const samePolicy = (a: Policy, b: Policy): boolean =>
  describePolicy(a) === describePolicy(b);

/** Everything about a policy except the two predicates, which are reduced. */
type RawPolicy = Omit<Policy, "using" | "withCheck"> & {
  readonly using: string;
  readonly withCheck: string;
};

/**
 * One policy with both predicates reduced to comparable form, or the reason
 * neither side can be compared.
 *
 * Every policy that reaches {@link samePolicy}, declared or live, is built here,
 * which is what makes the connective refusal unskippable: the comparison has no
 * other way to obtain a `Policy`.
 *
 * @param table The SQL name of the table the policy is attached to.
 * @param raw The policy as its own side spells it.
 * @returns The comparable policy, or the connective that refused it.
 */
export const comparablePolicy = (
  table: string,
  raw: RawPolicy
): { policy: Policy } | { problem: string } => {
  const refused = (side: string, connective: string) => ({
    problem: `${table}'s policy ${raw.name} has \`${connective}\` in its ${side} expression; a predicate the boot assertion can compare carries no boolean connective, because the comparison drops parentheses and grouping changes what a connective means`,
  });

  const using = normalizePredicate(raw.using, table);
  if ("connective" in using) {
    return refused("using", using.connective);
  }
  const withCheck = normalizePredicate(raw.withCheck, table);
  if ("connective" in withCheck) {
    return refused("with-check", withCheck.connective);
  }
  return {
    policy: {
      ...raw,
      using: using.normalized,
      withCheck: withCheck.normalized,
    },
  };
};

/**
 * The role names a declared policy applies to. Drizzle accepts a role object, a
 * role name, or a nested list of either, so all of them are flattened here
 * rather than at the one call site that cares.
 */
const declaredRoles = (to: PgPolicyToOption | undefined): string[] => {
  if (to === undefined) {
    return [];
  }
  if (Array.isArray(to)) {
    return to.flatMap((entry) => declaredRoles(entry));
  }
  return [is(to, PgRole) ? to.name : to];
};

/**
 * The column carrying the tenant key. It is `owner_id` on every Owner-scoped
 * table except `owner` itself, whose own primary key *is* GitHub's numeric Owner
 * id - which is why there is no second identifier beside it.
 *
 * @param table A tenant table.
 * @returns The column the canonical policy compares.
 * @throws {Error} If the table carries neither, which no tenant table may.
 */
export const tenantKey = (table: PgTable): PgColumn => {
  const { columns, name } = getTableConfig(table);
  const key =
    columns.find((column) => column.name === "owner_id") ??
    columns.find((column) => column.primary);
  if (key === undefined) {
    throw new Error(`${name} carries neither owner_id nor a primary key`);
  }
  return key;
};

/**
 * The single policy a tenant table declares, or the reason there is not exactly
 * one of it.
 *
 * @param table A tenant table.
 * @returns The declared policy in comparable form, or the problem.
 */
export const declaredPolicy = (
  table: PgTable
): { policy: Policy } | { problem: string } => {
  const name = tableName(table);
  const [policy, ...extra] = getTableConfig(table).policies;
  if (policy === undefined || extra.length > 0) {
    return {
      problem: `${name} declares ${extra.length + (policy ? 1 : 0)} policies; a tenant table declares exactly the canonical one`,
    };
  }
  if (!(policy.using && policy.withCheck)) {
    return {
      problem: `${name}'s policy declares no using or with-check expression`,
    };
  }
  const roles = declaredRoles(policy.to);
  const [role, ...otherRoles] = roles;
  if (role !== RUNTIME_ROLE || otherRoles.length > 0) {
    return {
      problem: `${name}'s policy applies to ${roles.join(", ") || "no role"} rather than to ${RUNTIME_ROLE} alone`,
    };
  }
  return comparablePolicy(name, {
    name: policy.name,
    permissive: (policy.as ?? "permissive") === "permissive",
    command: (policy.for ?? "all").toLowerCase(),
    roles,
    using: DIALECT.sqlToQuery(policy.using).sql,
    withCheck: DIALECT.sqlToQuery(policy.withCheck).sql,
  });
};

/**
 * The canonical policy a tenant table must carry, rendered by the pinned dialect
 * rather than compared against a frozen SQL literal.
 *
 * That is what preserves ADR 0008's hardest-won fix - `nullif(...)` rather than
 * the bare cast, which is correct on every unpooled connection and an outage
 * behind PgBouncer after a reset - without fossilising its spelling. A
 * hand-rolled policy carrying that exact bug fails against this, where a "has a
 * policy on the runtime role" check would pass it.
 *
 * What is still declared here is the convention around the predicate: the
 * policy's name, and which column is the tenant key.
 *
 * @param table A tenant table.
 * @returns The policy the table is required to declare, in comparable form.
 * @throws {Error} If the canonical policy itself cannot be reduced, which would
 *   mean `tenantPolicy()` had grown a boolean connective.
 */
export const canonicalPolicy = (table: PgTable): Policy => {
  const name = tableName(table);
  const policy = tenantPolicy(`${name}_tenant`, tenantKey(table));
  const built = comparablePolicy(name, {
    name: `${name}_tenant`,
    permissive: true,
    command: "all",
    roles: [RUNTIME_ROLE],
    using: render(policy.using),
    withCheck: render(policy.withCheck),
  });
  if ("problem" in built) {
    throw new Error(
      `the canonical tenant policy is not comparable: ${built.problem}`
    );
  }
  return built.policy;
};
