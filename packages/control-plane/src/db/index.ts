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
 */
export type {
  Classification} from "./classification.js";
export {
  CLASSIFICATION,
  MANAGED_TABLES,
  NON_TENANT_TABLES,
  tableName,
  tableNames,
  TENANT_TABLES,
} from "./classification.js";
export type { CheckName, CheckResult } from "./checks.js";
export { BootRefusal } from "./checks.js";
export type { BootstrapConfig } from "./bootstrap.js";
export { bootstrap } from "./bootstrap.js";
export type { CommittedMigration } from "./migrations.js";
export { MIGRATIONS_FOLDER, readCommittedMigrations } from "./migrations.js";
export type { MigrateConfig } from "./migrate.js";
export { migrate } from "./migrate.js";
export type {
  RuntimeDb,
  RuntimeDbConfig,
  TenantTransaction,
} from "./runtime.js";
export { createRuntimeDb } from "./runtime.js";
export * as schema from "./schema.js";
export { RUNTIME_ROLE } from "./schema.js";
