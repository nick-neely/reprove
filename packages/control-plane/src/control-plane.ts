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
import type { GitHubFetch } from "./github/client.js";
import { createGitHubClient } from "./github/client.js";
import type {
  DeliveryToProcess,
  ProcessedDelivery,
} from "./github/delivery.js";
import { recordDelivery } from "./github/ledger.js";
import { createDeliveryProcessor } from "./github/processing.js";
import { normalizeRunProfile } from "./github/profile.js";
import type { Phase0RunProfile } from "./github/profile.js";
import type { KickProcessing } from "./github/webhook.js";
import { createGitHubWebhookHandler } from "./github/webhook.js";
import {
  expireUnclaimed,
  readSchedule,
  recordLifecycle,
} from "./run/lifecycle.js";
import type { RunLifecyclePort } from "./run/schedule.js";
import { createWorkerAuthenticator } from "./worker/authenticate.js";
import type {
  ClaimOutcome,
  HostedClaimRequest,
} from "./worker/claim-outcome.js";
import { claimRun } from "./worker/claim.js";
import { createWorkerClaimHandler } from "./worker/endpoint.js";

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

/** The App's webhook seam, and the authority it reads GitHub back with. */
export interface ControlPlaneGitHubConfig {
  /** The webhook secret the App was registered with. */
  readonly webhookSecret: string;
  /** GitHub's numeric App id, which is the App JWT's issuer. */
  readonly appId: string;
  /** The App's private key, PEM-encoded, in either PKCS#1 or PKCS#8. */
  readonly privateKey: string;
  /**
   * ADR 0013's injected profile: the half of a Run's immutable spec no pull
   * request can influence. There is deliberately no default - a value the
   * package chose silently is exactly the "prototype wiring becoming product
   * selection policy" the ADR built the profile to prevent - so the composition
   * root passes `PHASE_0_RUN_PROFILE` or something of its own.
   */
  readonly runProfile: Phase0RunProfile;
  /** The largest delivery body to accept, in bytes. */
  readonly maximumDeliveryBytes?: number;
  /**
   * The transport. Defaults to the global `fetch`, and exists as configuration
   * because ADR 0016's acceptance scenario substitutes GitHub "only at the
   * transport" - so the JWT, the exchange, the request shape and the response
   * parsing all execute for real against a canned body.
   */
  readonly fetch?: GitHubFetch;
  /**
   * The REST root. Defaults to `https://api.github.com`; a GitHub Enterprise
   * Server deployment names its own.
   *
   * It must be `https:`, or `http:` on loopback (`127.0.0.1`, `localhost`,
   * `::1`), because every request under it carries the App JWT or an
   * installation token. Anything else is refused here, at composition, the way
   * a missing field is.
   */
  readonly apiUrl?: string;
}

/** Everything the control plane is composed over. */
export interface ControlPlaneConfig {
  readonly database: ControlPlaneDatabaseConfig;
  readonly github: ControlPlaneGitHubConfig;
  /**
   * What the webhook hands a committed delivery to, after the acknowledgement
   * and without awaiting it.
   *
   * ADR 0014 makes the durable spine the mechanism: the composition that owns
   * Workflow passes the function that starts the ingress workflow, and the
   * platform's step retry is then the re-drive of `contended` and `transient`
   * dispositions. Left unset, the delivery is processed **in this process**,
   * once, with the ledger row as the only recovery - which is ADR 0013's
   * minimum and what a composition with no durable runtime, such as a test,
   * gets. It is not what a deployment should run.
   */
  readonly kick?: KickProcessing;
}

/** The composed control plane, as the app holds it. */
export interface ControlPlane {
  /** Every boot check's outcome, kept so a deployment can log what it proved. */
  readonly checks: readonly CheckOutcome[];
  /** `POST /api/github/webhook`. */
  readonly handleGitHubWebhook: (request: Request) => Promise<Response>;
  /**
   * `POST /api/worker/runs/claim`, which is how work reaches a **self-hosted**
   * Worker: it is always the HTTP client, so there is no inbound port on it and
   * the control plane never learns its address (ADR 0006).
   */
  readonly handleWorkerClaim: (request: Request) => Promise<Response>;
  /**
   * The same claim, taken by the hosted placement, which has no Worker and no
   * HTTP hop.
   *
   * [ADR 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
   * makes `executionToken` and `executionExpiresAt` placement-neutral, so this
   * is the same conditional UPDATE the endpoint reaches rather than a second
   * one beside it - which is what stops the hosted path (#57) from growing an
   * execution-ownership story of its own. ADR 0006 keeps hosted out of the
   * scheduling half of the protocol, so it names its Run and never polls.
   */
  readonly claimRun: (request: HostedClaimRequest) => Promise<ClaimOutcome>;
  /**
   * Turns one committed delivery into its Run, or into the conclusion that
   * there is none.
   *
   * The webhook kicks this and does not await it, which is ADR 0013's order.
   * It is **also** exposed here on purpose: the ADR makes an automatic re-drive
   * of `contended` and `transient` dispositions a Phase 0 exit condition, and
   * [ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md) makes
   * that re-drive the platform's own step retry, so the durable scheduler in
   * `@reprove/control-plane-workflow` needs a way in that is not a webhook
   * request. Calling it twice
   * for one delivery is safe: the second attempt settles nothing, because
   * `done` and `discarded` are terminal.
   */
  readonly processDelivery: (
    delivery: DeliveryToProcess
  ) => Promise<ProcessedDelivery>;
  /**
   * The lifecycle's reach into a Run: record which durable run schedules it,
   * read what to do next, and close the unclaimed window (ADR 0014). Every
   * write is conditional on the writer being the recorded lifecycle.
   */
  readonly lifecycle: RunLifecyclePort;
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
  const appId = requireNonEmpty(
    config.github?.appId,
    "ControlPlaneConfig.github.appId"
  );
  const privateKey = requireNonEmpty(
    config.github?.privateKey,
    "ControlPlaneConfig.github.privateKey"
  );
  // Required rather than defaulted, for the reason above the field: a Run whose
  // harness this package picked would be a product decision made by a fallback.
  const runProfile = config.github?.runProfile;
  if (!runProfile) {
    throw new TypeError(
      "ControlPlaneConfig.github.runProfile is required; there is no default, because a Phase 0 fixture chosen silently becomes product selection policy (ADR 0013)"
    );
  }

  const resolvedRunProfile = normalizeRunProfile(runProfile);

  const runtime = await createRuntimeDb({
    connectionString: config.database?.connectionString,
    poolSize: config.database?.poolSize,
    onConnectionError: config.database?.onConnectionError,
  });

  const github = createGitHubClient({
    appId,
    privateKey,
    fetch: config.github.fetch ?? ((request) => fetch(request)),
    apiUrl: config.github.apiUrl,
  });

  const processDelivery = createDeliveryProcessor({
    withOwner: runtime.withOwner,
    canonicalPullRequest: github.canonicalPullRequest,
    profile: resolvedRunProfile,
  });

  // The in-process fallback. Started and not awaited, so the acknowledgement
  // is not held behind the advisory lock and the canonical fetch. A rejection
  // is swallowed rather than crashing the process on an unhandled rejection:
  // the envelope is durable and the ledger row is still `received`, which is
  // the state a re-drive picks up - and, with no durable spine composed, the
  // state a manual redelivery finds it in.
  const processInProcess: KickProcessing = (delivery) => {
    void (async () => {
      try {
        await processDelivery(delivery);
      } catch {
        // Nothing to do, and nothing to log with: this package holds no
        // logger.
      }
    })();
  };

  const handleGitHubWebhook = createGitHubWebhookHandler({
    secret: webhookSecret,
    maximumBytes: config.github.maximumDeliveryBytes,
    commit: (envelope) =>
      runtime.withOwner(envelope.ownerId, (tx) => recordDelivery(tx, envelope)),
    kick: config.kick ?? processInProcess,
  });

  // Two transactions, in this order, and never one. ADR 0008 restricts the
  // pre-authentication transaction to verifying the credential, so the claim is
  // a separate `withOwner` that opens only once authentication has answered.
  const authenticate = createWorkerAuthenticator({
    withOwner: runtime.withOwner,
  });
  const claimConfig = {
    livenessForMs: resolvedRunProfile.livenessForMs,
    now: () => new Date(),
  };
  const handleWorkerClaim = createWorkerClaimHandler({
    authenticate,
    claim: (request) =>
      runtime.withOwner(request.ownerId, (tx) =>
        claimRun(tx, claimConfig, {
          ownerId: request.ownerId,
          runId: request.runId,
          worker: request.worker,
        })
      ),
  });

  const lifecycle: RunLifecyclePort = {
    record: (ownerId, runId, workflowRunId) =>
      runtime.withOwner(ownerId, (tx) =>
        recordLifecycle(tx, runId, workflowRunId)
      ),
    schedule: (ownerId, runId) =>
      runtime.withOwner(ownerId, (tx) => readSchedule(tx, runId)),
    expireUnclaimed: (ownerId, runId, workflowRunId) =>
      runtime.withOwner(ownerId, (tx) =>
        expireUnclaimed(tx, runId, workflowRunId)
      ),
  };

  return {
    checks: runtime.checks,
    handleGitHubWebhook,
    handleWorkerClaim,
    claimRun: (request) =>
      runtime.withOwner(request.ownerId, (tx) =>
        claimRun(tx, claimConfig, {
          ownerId: request.ownerId,
          runId: request.runId,
          worker: null,
        })
      ),
    processDelivery,
    lifecycle,
    close: runtime.close,
  };
};
