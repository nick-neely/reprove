/**
 * The whole ingress path end to end: an HTTP `Request` in, a committed row out,
 * against real Postgres behind real PgBouncer.
 *
 * The unit tests above prove each seam in isolation, and one thing only a test
 * at this level can say: that a rejected delivery **never reaches persistence**.
 * A handler measured against a stub commit proves the port was not called; this
 * proves the table is empty, which is the claim ADR 0013's acceptance actually
 * makes.
 *
 * It needs the local stack for the reason every database test in this package
 * does, and fails with instructions rather than skipping when it is down.
 */
import { generateKeyPairSync } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ControlPlane } from "./control-plane.js";
import { createControlPlane } from "./control-plane.js";
import { bootstrap } from "./db/bootstrap.js";
import type { TestDatabase } from "./db/local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "./db/local-stack.test-support.js";
import { migrate } from "./db/migrate.js";
import {
  openedPullRequestBytes,
  signedDelivery,
  WEBHOOK_SECRET,
} from "./github/delivery.test-support.js";
import { PHASE_0_RUN_PROFILE } from "./github/profile.js";
import { signDelivery } from "./github/signature.js";
import { WEBHOOK_STATUS } from "./github/webhook.js";

const DATABASE = "reprove_test_control_plane_ingress";

/** The Owner id `OPENED_PULL_REQUEST` carries. */
const ACME = 1001;

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

const BASE = "a".repeat(40);
/** The head `OPENED_PULL_REQUEST` names, so the fixture and GitHub agree. */
const HEAD = "b".repeat(40);

/**
 * GitHub, substituted at the transport and nowhere else (ADR 0016). The App
 * JWT, the installation-token exchange, the request shape and the response
 * parse all run for real; only the two bodies are canned.
 */
const cannedGitHub = (request: Request): Promise<Response> =>
  Promise.resolve(
    request.url.includes("/access_tokens")
      ? Response.json(
          { token: "ghs_a_token", expires_at: "2026-02-01T13:00:00Z" },
          { status: 201 }
        )
      : Response.json({
          number: 7,
          state: "open",
          draft: false,
          head: { sha: HEAD, repo: { id: 3001 } },
          base: { sha: BASE, repo: { id: 3001 } },
          user: { id: 5005 },
          author_association: "MEMBER",
        })
  );

const githubConfig = {
  webhookSecret: WEBHOOK_SECRET,
  appId: "1234",
  privateKey: PRIVATE_KEY,
  runProfile: PHASE_0_RUN_PROFILE,
  fetch: cannedGitHub,
};

let database: TestDatabase;
let controlPlane: ControlPlane;

/** Every ledger row, read as the admin role so no tenant context filters it. */
const ledger = () =>
  database.admin<{ delivery_guid: string; state: string }>(
    "select delivery_guid, state from ingress_delivery order by received_at"
  );

describe("the control plane's GitHub webhook, end to end", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    controlPlane = await createControlPlane({
      database: { connectionString: database.runtimeUrl },
      github: githubConfig,
    });
  });

  afterAll(async () => {
    await controlPlane?.close();
    await database?.drop();
  });

  it("has proved the tenant boundary before it serves a route", () => {
    // `createRuntimeDb()` is the only path to a client and refuses rather than
    // returning one, so a control plane that exists has already passed all
    // seven of ADR 0008 rule 6's checks.
    expect(controlPlane.checks).not.toHaveLength(0);
    expect(controlPlane.checks.every((check) => check.ok)).toBeTruthy();
  });

  it("commits the envelope and only then acknowledges", async () => {
    const response = await controlPlane.handleGitHubWebhook(
      signedDelivery({ deliveryGuid: "committed-then-acknowledged" })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
    // Read after the response resolved, with no wait in between: if the commit
    // were kicked off rather than awaited, this is where it would be missing.
    await expect(ledger()).resolves.toStrictEqual([
      { delivery_guid: "committed-then-acknowledged", state: "received" },
    ]);
  });

  it("writes the Owner the delivery located, and nothing of anyone else", async () => {
    const owners = await database.admin<{ id: string; login: string }>(
      "select id, login from owner"
    );

    expect(owners).toStrictEqual([{ id: String(ACME), login: "acme" }]);
  });

  it("leaves a tampered delivery out of the database entirely", async () => {
    const before = await ledger();

    const response = await controlPlane.handleGitHubWebhook(
      signedDelivery({
        deliveryGuid: "tampered",
        body: openedPullRequestBytes(),
        signature: signDelivery(WEBHOOK_SECRET, new TextEncoder().encode("{}")),
      })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.unsigned);
    await expect(ledger()).resolves.toStrictEqual(before);
  });

  it("leaves an oversized delivery out of the database entirely", async () => {
    const before = await ledger();
    const bounded = await createControlPlane({
      database: { connectionString: database.runtimeUrl },
      github: { ...githubConfig, maximumDeliveryBytes: 32 },
    });

    try {
      const response = await bounded.handleGitHubWebhook(
        signedDelivery({ deliveryGuid: "oversized" })
      );

      expect(response.status).toBe(WEBHOOK_STATUS.oversized);
      await expect(ledger()).resolves.toStrictEqual(before);
    } finally {
      await bounded.close();
    }
  });

  it("records a manual redelivery beside the first rather than swallowing it", async () => {
    const guid = "redelivered-through-http";
    await controlPlane.handleGitHubWebhook(
      signedDelivery({ deliveryGuid: guid })
    );
    await controlPlane.handleGitHubWebhook(
      signedDelivery({ deliveryGuid: guid })
    );

    const rows = await database.admin<{ count: string }>(
      `select count(*)::text as count from ingress_delivery where delivery_guid = '${guid}'`
    );
    expect(rows[0]?.count).toBe("2");
  });

  it("refuses a composition with no webhook secret", async () => {
    await expect(
      createControlPlane({
        database: { connectionString: database.runtimeUrl },
        github: { ...githubConfig, webhookSecret: "" },
      })
    ).rejects.toThrow("ControlPlaneConfig.github.webhookSecret");
  });

  it("refuses a composition with no Run profile, because there is no default", async () => {
    await expect(
      createControlPlane({
        database: { connectionString: database.runtimeUrl },
        // SAFETY: the assertion is the case. `runProfile` has no default, and
        // this is a deployment that failed to pass one - which TypeScript
        // forbids and a JavaScript caller can still do.
        github: { ...githubConfig, runProfile: undefined as never },
      })
    ).rejects.toThrow("ControlPlaneConfig.github.runProfile");
  });

  it("refuses a composition that could not read GitHub back", async () => {
    await expect(
      createControlPlane({
        database: { connectionString: database.runtimeUrl },
        github: { ...githubConfig, privateKey: "" },
      })
    ).rejects.toThrow("ControlPlaneConfig.github.privateKey");
  });

  it("produces exactly one Run at the canonical base and head", async () => {
    const guid = "delivery-that-becomes-a-run";
    const acknowledged = await controlPlane.handleGitHubWebhook(
      signedDelivery({ deliveryGuid: guid })
    );
    expect(acknowledged.status).toBe(WEBHOOK_STATUS.acknowledged);

    const [committed] = await database.admin<{ id: string }>(
      `select id from ingress_delivery where delivery_guid = '${guid}'`
    );
    const processed = await controlPlane.processDelivery({
      deliveryId: committed?.id ?? "",
      envelope: {
        deliveryGuid: guid,
        event: "pull_request",
        action: "opened",
        ownerId: ACME,
        ownerLogin: "acme",
        ownerType: "organization",
        installationId: 42,
        repositoryId: 3001,
        repositoryNameWithOwner: "acme/reprove",
        pullRequestNumber: 7,
      },
    });

    // `done` or `duplicate_head`: the fire-and-forget kick from the
    // acknowledgement above may have created the Run already, and either answer
    // means exactly one Run exists at the canonical head - which is the claim.
    expect(["done", "discarded"]).toContain(processed.outcome.state);
    const created = await database.admin<{
      base_sha: string;
      head_sha: string;
      trigger: string;
    }>(
      "select base_sha, head_sha, trigger from run where pull_request_number = 7"
    );
    expect(created).toStrictEqual([
      { base_sha: BASE, head_sha: HEAD, trigger: "automatic" },
    ]);
  });
});
