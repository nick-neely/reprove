import { protocolVersion } from "@reprove/protocol/v1";

export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";

/**
 * The persistence surface a consumer may hold, and deliberately no more.
 *
 * ADR 0010's matrix forbids `apps/control-plane` - the only consumer - from
 * depending on `drizzle-orm`, `pg` or any other Postgres driver, so nothing
 * exported here names a type from one. That is the same boundary ADR 0005 draws
 * against `@ai-sdk/*`, applied to the database: an upstream type leaks through
 * an exported signature even when the importer never names the package.
 *
 * The schema, the classification, `createRuntimeDb()` and its tenant transaction
 * therefore stay inside the package, reachable from `./db/index.js` by the
 * control-plane code that owns them. Composition reaches the app as
 * `createControlPlane(config)`, which is where the runtime client is built from
 * configuration the app parsed - not as a Drizzle handle the app assembles for
 * itself.
 */
export type {
  ControlPlane,
  ControlPlaneConfig,
  ControlPlaneDatabaseConfig,
  ControlPlaneGitHubConfig,
} from "./control-plane.js";
export { createControlPlane } from "./control-plane.js";
export type { BootstrapConfig } from "./db/bootstrap.js";
export { bootstrap } from "./db/bootstrap.js";
export type { MigrateConfig } from "./db/migrate.js";
export { migrate } from "./db/migrate.js";
export type { CommittedMigration } from "./db/migrations.js";
export { MIGRATIONS_FOLDER, readCommittedMigrations } from "./db/migrations.js";
export type { CheckName, CheckOutcome } from "./db/refusal.js";
export { BootRefusalError } from "./db/refusal.js";
export { RUNTIME_ROLE } from "./db/roles.js";
export type {
  GitHubAppManifest,
  ManifestOptions,
  ManifestPermission,
} from "./github/manifest.js";
export {
  APP_EVENTS,
  APP_PERMISSIONS,
  githubAppManifest,
  WEBHOOK_PATH,
} from "./github/manifest.js";
export { WEBHOOK_STATUS } from "./github/webhook.js";

export const packageName = "@reprove/control-plane" as const;

/**
 * Shell. The control plane validates every Worker submission against the same
 * authoritative schema the Worker emits with, because a hostile or buggy Worker
 * can skip its own code and POST arbitrary bytes (ADR 0010).
 */
export const accepts = {
  protocolVersion,
} as const;
