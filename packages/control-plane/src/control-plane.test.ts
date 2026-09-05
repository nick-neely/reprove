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
import { signDelivery } from "./github/signature.js";
import { WEBHOOK_STATUS } from "./github/webhook.js";

const DATABASE = "reprove_test_control_plane_ingress";

/** The Owner id `OPENED_PULL_REQUEST` carries. */
const ACME = 1001;

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
      github: { webhookSecret: WEBHOOK_SECRET },
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
      github: { webhookSecret: WEBHOOK_SECRET, maximumDeliveryBytes: 32 },
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
        github: { webhookSecret: "" },
      })
    ).rejects.toThrow("ControlPlaneConfig.github.webhookSecret");
  });
});
