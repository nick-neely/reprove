/**
 * Composition: the one call `apps/control-plane` makes, and the only way the
 * database reaches an HTTP route.
 *
 * [ADR 0010](../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids the app from depending on `drizzle-orm`, `pg` or `better-auth`, so
 * there is no arrangement in which it assembles a client and hands it to a
 * handler: nothing on this package's published surface may name a type from any
 * of them. What crosses instead is configuration in and behaviour out.
 *
 * That constraint is also what puts the boot assertion in front of every route
 * for free. `createRuntimeDb()` either returns a client that has proved the
 * tenant boundary is live or it throws, and it is the only path to one, so a
 * deployment whose runtime role is misconfigured has no control plane at all
 * rather than a working webhook over an unenforced boundary.
 *
 * **No value here is read from the environment.** The app parses deployment
 * configuration and passes it explicitly, which is the same rule
 * `createAuth()` and `createRuntimeDb()` already hold to.
 */
import { requireNonEmpty } from "./db/config.js";
import type { CheckOutcome } from "./db/refusal.js";
import { createRuntimeDb } from "./db/runtime.js";
import { recordDelivery } from "./github/ledger.js";
import { createGitHubWebhookHandler } from "./github/webhook.js";

/** The database connection, as configuration rather than as a client. */
export interface ControlPlaneDatabaseConfig {
  /**
   * The **pooled** endpoint, as the restricted runtime role. Never the admin
   * credential and never the direct endpoint.
   */
  readonly connectionString: string;
  /** Client connections the pool may hold open. */
  readonly poolSize?: number;
  /** Called when the pool's connection fails while idle. */
  readonly onConnectionError?: (error: Error) => void;
}

/** The App's webhook seam. */
export interface ControlPlaneGitHubConfig {
  /** The webhook secret the App was registered with. */
  readonly webhookSecret: string;
  /** The largest delivery body to accept, in bytes. */
  readonly maximumDeliveryBytes?: number;
}

/** Everything the control plane is composed over. */
export interface ControlPlaneConfig {
  readonly database: ControlPlaneDatabaseConfig;
  readonly github: ControlPlaneGitHubConfig;
}

/** The composed control plane, as the app holds it. */
export interface ControlPlane {
  /** Every boot check's outcome, kept so a deployment can log what it proved. */
  readonly checks: readonly CheckOutcome[];
  /** `POST /api/github/webhook`. */
  readonly handleGitHubWebhook: (request: Request) => Promise<Response>;
  /** Drains the connection pool. */
  readonly close: () => Promise<void>;
}

/**
 * Opens the runtime connection, proves the tenant boundary, and composes the
 * routes over it.
 *
 * The webhook's commit port is bound to a `withOwner` transaction here, and
 * that binding is what makes ADR 0013's ordering true end to end: the handler
 * awaits a call that resolves only once the transaction has committed, so the
 * acknowledgement cannot precede the row.
 *
 * @param config The pooled connection and the App's webhook secret.
 * @returns The composed control plane.
 * @throws {TypeError} Naming the field, when a required value is absent or empty.
 * @throws {import("./db/refusal.js").BootRefusalError} Naming every tenancy
 *   assertion that failed.
 */
export const createControlPlane = async (
  config: ControlPlaneConfig
): Promise<ControlPlane> => {
  const webhookSecret = requireNonEmpty(
    config.github?.webhookSecret,
    "ControlPlaneConfig.github.webhookSecret"
  );

  const runtime = await createRuntimeDb({
    connectionString: config.database?.connectionString,
    poolSize: config.database?.poolSize,
    onConnectionError: config.database?.onConnectionError,
  });

  const handleGitHubWebhook = createGitHubWebhookHandler({
    secret: webhookSecret,
    maximumBytes: config.github.maximumDeliveryBytes,
    commit: async (envelope) => {
      await runtime.withOwner(envelope.ownerId, (tx) =>
        recordDelivery(tx, envelope)
      );
    },
  });

  return {
    checks: runtime.checks,
    handleGitHubWebhook,
    close: runtime.close,
  };
};
