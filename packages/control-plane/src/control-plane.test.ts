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
import { setTimeout } from "node:timers/promises";

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
  deliveryBytes,
  OPENED_PULL_REQUEST,
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
          // Echoed from the path, so the canned body answers the request that
          // was actually issued rather than a fixed one.
          number: Number(request.url.split("/").at(-1)),
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

/** The Runs for one pull request, as the admin role sees them. */
const runsFor = (number: number) =>
  database.admin<{ base_sha: string; head_sha: string; trigger: string }>(
    `select base_sha, head_sha, trigger from run where pull_request_number = ${number}`
  );

/**
 * Waits for the fire-and-forget kick to land.
 *
 * The route answers before processing finishes - that is ADR 0013's order and
 * the point of the case - so the row is what says the work is done. Recursive
 * rather than a loop, and bounded, so a kick that never lands fails here
 * instead of hanging.
 */
const untilRunExists = async (
  number: number,
  attemptsLeft = 100
): Promise<void> => {
  const existing = await runsFor(number);
  if (existing.length > 0) {
    return;
  }
  if (attemptsLeft === 0) {
    throw new Error(`no Run appeared for pull request ${number}`);
  }
  await setTimeout(20);
  await untilRunExists(number, attemptsLeft - 1);
};

/**
 * Every ledger row's GUID, read as the admin role so no tenant context filters
 * it.
 *
 * The GUID and not the state, because the state is what the fire-and-forget
 * kick moves: a case asserting that a rejected delivery reached no row would
 * otherwise be measuring how far an unrelated delivery's processing had got.
 */
const ledgerGuids = () =>
  database.admin<{ delivery_guid: string }>(
    "select delivery_guid from ingress_delivery order by received_at"
  );

/** Ledger rows no processing attempt has counted itself against yet. */
const unattempted = async (): Promise<number> => {
  const [row] = await database.admin<{ count: string }>(
    "select count(*)::text as count from ingress_delivery where attempt_count = 0"
  );
  return Number(row?.count ?? "0");
};

/**
 * Waits for every kick this file started to finish.
 *
 * The route answers before processing finishes - that is ADR 0013's order and
 * the point of several cases below - so nothing about a `200` says the
 * transaction behind it has committed. Left unawaited, those kicks outlive the
 * case that started them: they move rows a later case is asserting about, and
 * they are still holding connections when `afterAll` drops the database.
 *
 * The attempt count rather than a terminal state, because a delivery may
 * legitimately settle back to `received` - `contended` is the expected answer
 * when two kicks race for one pull request - and waiting for terminality would
 * hang on exactly the case ADR 0013 designed for.
 */
const untilKicksLand = async (attemptsLeft = 100): Promise<void> => {
  const outstanding = await unattempted();
  if (outstanding === 0) {
    return;
  }
  if (attemptsLeft === 0) {
    throw new Error(`${outstanding} deliveries were never processed`);
  }
  await setTimeout(20);
  await untilKicksLand(attemptsLeft - 1);
};

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
    // Before the pool is drained and the database dropped, or a kick still in
    // flight runs its transaction against neither.
    await untilKicksLand();
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
    await expect(ledgerGuids()).resolves.toStrictEqual([
      { delivery_guid: "committed-then-acknowledged" },
    ]);

    await untilKicksLand();
  });

  it("writes the Owner the delivery located, and nothing of anyone else", async () => {
    const owners = await database.admin<{ id: string; login: string }>(
      "select id, login from owner"
    );

    expect(owners).toStrictEqual([{ id: String(ACME), login: "acme" }]);
  });

  it("leaves a tampered delivery out of the database entirely", async () => {
    const before = await ledgerGuids();

    const response = await controlPlane.handleGitHubWebhook(
      signedDelivery({
        deliveryGuid: "tampered",
        body: openedPullRequestBytes(),
        signature: signDelivery(WEBHOOK_SECRET, new TextEncoder().encode("{}")),
      })
    );

    expect(response.status).toBe(WEBHOOK_STATUS.unsigned);
    await expect(ledgerGuids()).resolves.toStrictEqual(before);
  });

  it("leaves an oversized delivery out of the database entirely", async () => {
    const before = await ledgerGuids();
    const bounded = await createControlPlane({
      database: { connectionString: database.runtimeUrl },
      github: { ...githubConfig, maximumDeliveryBytes: 32 },
    });

    try {
      const response = await bounded.handleGitHubWebhook(
        signedDelivery({ deliveryGuid: "oversized" })
      );

      expect(response.status).toBe(WEBHOOK_STATUS.oversized);
      await expect(ledgerGuids()).resolves.toStrictEqual(before);
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

    await untilKicksLand();

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
    // A pull request of this test's own. Every other case in this file posts
    // `OPENED_PULL_REQUEST`, and each of those acknowledgements kicked
    // processing for it; sharing the number would measure the interleaving of
    // those kicks rather than what one delivery does.
    const number = 11;
    const guid = "delivery-that-becomes-a-run";
    const payload = {
      ...OPENED_PULL_REQUEST,
      number,
      pull_request: { number },
    };
    const body = deliveryBytes(payload);

    const acknowledged = await controlPlane.handleGitHubWebhook(
      signedDelivery({ deliveryGuid: guid, body })
    );
    expect(acknowledged.status).toBe(WEBHOOK_STATUS.acknowledged);

    // The Run existing is what says the kick's transaction committed, which is
    // also what says its advisory lock is released.
    await untilRunExists(number);

    const [committed] = await database.admin<{ id: string }>(
      `select id from ingress_delivery where delivery_guid = '${guid}'`
    );
    if (!committed) {
      throw new Error(`no ledger row for delivery ${guid}`);
    }
    // The same delivery again, through the exposed entry point #38's re-drive
    // uses. The kick above already ran it to a terminal state, so this settles
    // nothing - which is the stateful GUID rule holding.
    const processed = await controlPlane.processDelivery({
      deliveryId: committed.id,
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
        pullRequestNumber: number,
      },
    });
    expect(processed.settled).toBeFalsy();

    await expect(runsFor(number)).resolves.toStrictEqual([
      { base_sha: BASE, head_sha: HEAD, trigger: "automatic" },
    ]);
  });
});
