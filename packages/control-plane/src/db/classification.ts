/**
 * Which tables carry Owner tenancy, and which deliberately do not.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)
 * rejected an allowlist of RLS-exempt tables because "an allowlist is precisely
 * the thing that grows quietly". What makes this one safe is the third set:
 *
 * ```text
 * MANAGED_TABLES  = every pgTable the schema module exports
 * MANAGED_TABLES == TENANT_TABLES ∪ NON_TENANT_TABLES
 * TENANT_TABLES  ∩  NON_TENANT_TABLES == ∅
 * ```
 *
 * The universe is enumerated from a source the classification does not control,
 * so a table added to the schema module and left out of both sets **refuses
 * boot** rather than landing silently outside the tenant boundary
 * ([ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)).
 *
 * Classification is a human security decision and stays a reviewable
 * declaration. Deriving it from policy presence would make "new Owner-scoped
 * table, tenant policy forgotten" indistinguishable from "deliberately
 * non-tenant", turning the most dangerous authoring mistake in this design into
 * the safe case.
 *
 * The sets name **table objects**, never string literals, with SQL names derived
 * through `getTableConfig()`. A rename in the schema module cannot drift from
 * the classification, because there is no second spelling to update.
 */
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "./schema.js";

/**
 * A table's SQL name, which is the only form the catalog and `pg_policies`
 * speak.
 *
 * @param table Any table from the schema module.
 * @returns The unqualified table name as Postgres holds it.
 */
export const tableName = (table: PgTable): string => getTableConfig(table).name;

/**
 * The SQL names of a set of tables, sorted, for a message a reader can scan.
 *
 * @param tables Any set of tables.
 * @returns Their SQL names in lexical order.
 */
export const tableNames = (tables: readonly PgTable[]): string[] =>
  tables.map(tableName).toSorted();

/** Every Owner-scoped table. Each carries the Owner id denormalized. */
export const TENANT_TABLES: readonly PgTable[] = [
  schema.owner,
  schema.installation,
  schema.repository,
  schema.worker,
  schema.workerCredential,
  schema.enrollmentCode,
  schema.ingressDelivery,
  schema.run,
  schema.finding,
  schema.publication,
];

/**
 * Better Auth's four, adopted into Reprove's migration history and deliberately
 * outside Owner RLS: a User can legitimately reach several Owners.
 */
export const NON_TENANT_TABLES: readonly PgTable[] = [
  schema.user,
  schema.session,
  schema.account,
  schema.verification,
];

/**
 * Every table Reprove's migrations manage, enumerated from the schema module
 * rather than from the two sets above. This is what stops "every managed table
 * is classified" from being a tautology.
 *
 * It is deliberately **not** every table in the database: ADR 0010 permits
 * Vercel Workflow to share the same Postgres server, and Reprove must refuse
 * over its own malformed boundary rather than because a neighbour legitimately
 * placed a table beside it.
 */
const schemaExports: unknown[] = Object.values(schema);

export const MANAGED_TABLES: readonly PgTable[] = schemaExports
  .filter((entity): entity is PgTable => is(entity, PgTable))
  .toSorted((a, b) => (tableName(a) < tableName(b) ? -1 : 1));

/** The classification the boot assertion reads. */
export interface Classification {
  readonly managed: readonly PgTable[];
  readonly tenant: readonly PgTable[];
  readonly nonTenant: readonly PgTable[];
}

/** The real classification, and the default every check is measured against. */
export const CLASSIFICATION: Classification = {
  managed: MANAGED_TABLES,
  tenant: TENANT_TABLES,
  nonTenant: NON_TENANT_TABLES,
};
