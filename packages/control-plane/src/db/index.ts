/**
 * Persistence: the schema, the two database paths, and the boot assertion
 * between them.
 *
 * ```text
 * bootstrap()        -> admin connection, explicit operator command, SQL only
 * migrate()          -> admin connection, explicit operator command
 * createRuntimeDb()  -> restricted runtime connection
 *                    -> rule 6's seven checks must pass
 *                    -> otherwise refuse to return a client
 * ```
 *
 * `bootstrap` and `migrate` are **ordered**, not interchangeable: a policy names
 * the role it applies to, so the role has to exist before the first migration
 * runs.
 *
 * This is the **package-internal** barrel and reaches everything, Drizzle types
 * included. `src/index.ts` publishes a strict subset: ADR 0010 forbids
 * `apps/control-plane` from depending on `drizzle-orm` or a Postgres driver, so
 * a published signature naming either would hand the only consumer a type it is
 * not allowed to import.
 *
 * The tables are deliberately absent: `./schema.js` is imported directly by the
 * code that queries them, because re-exporting the namespace from here would
 * pull Drizzle's whole module graph through one barrel.
 */
export type { BootstrapConfig } from "./bootstrap.js";
export { bootstrap } from "./bootstrap.js";
export { assertTenantBoundary, runBootChecks } from "./checks.js";
export type { Classification } from "./classification.js";
export {
  CLASSIFICATION,
  MANAGED_TABLES,
  NON_TENANT_TABLES,
  tableName,
  tableNames,
  TENANT_TABLES,
} from "./classification.js";
export type { MigrateConfig } from "./migrate.js";
export { migrate } from "./migrate.js";
export type { CommittedMigration } from "./migrations.js";
export { MIGRATIONS_FOLDER, readCommittedMigrations } from "./migrations.js";
export type { CheckName, CheckOutcome } from "./refusal.js";
export { BootRefusalError } from "./refusal.js";
export { RUNTIME_ROLE } from "./roles.js";
export type {
  RuntimeDb,
  RuntimeDbConfig,
  TenantTransaction,
} from "./runtime.js";
export { createRuntimeDb } from "./runtime.js";
