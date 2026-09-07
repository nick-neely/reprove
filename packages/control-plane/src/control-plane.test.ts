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
import { WORKER_RESULT_STATUS } from "./worker/acceptance-outcome.js";
import { WORKER_CLAIM_STATUS } from "./worker/claim-outcome.js";

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

  it("hands a committed delivery to the kick it was composed with, and processes nothing itself", async () => {
    // The composition that owns the durable spine passes the function that
    // starts the ingress workflow (ADR 0014); this stands in for it and holds
    // what it was handed.
    const handed: { deliveryId: string; guid: string }[] = [];
    const guid = "handed-to-the-spine";
    const spined = await createControlPlane({
      database: { connectionString: database.runtimeUrl },
      github: githubConfig,
      kick: (delivery) => {
        handed.push({
          deliveryId: delivery.deliveryId,
          guid: delivery.envelope.deliveryGuid,
        });
      },
    });

    try {
      const response = await spined.handleGitHubWebhook(
        signedDelivery({
          deliveryGuid: guid,
          body: deliveryBytes({
            ...OPENED_PULL_REQUEST,
            number: 13,
            pull_request: { number: 13 },
          }),
        })
      );

      expect(response.status).toBe(WEBHOOK_STATUS.acknowledged);
      const [row] = await database.admin<{
        id: string;
        state: string;
        attempt_count: number;
      }>(
        `select id, state, attempt_count from ingress_delivery where delivery_guid = '${guid}'`
      );
      expect(handed).toStrictEqual([{ deliveryId: row?.id, guid }]);
      // Nothing in this process took the delivery further: the row is exactly
      // as the commit left it, which is the state the spine picks up.
      expect(row).toMatchObject({ state: "received", attempt_count: 0 });
      await expect(runsFor(13)).resolves.toStrictEqual([]);
      // `untilKicksLand()` in `afterAll` waits for every row to be attempted,
      // so drive this one through the exposed entry point the spine uses.
      await spined.processDelivery({
        deliveryId: row?.id ?? "",
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
          pullRequestNumber: 13,
        },
      });
    } finally {
      await spined.close();
    }
  });

  it("exposes the lifecycle's reach into a Run, scoped to the Owner", async () => {
    // Composed over `withOwner`, so the three operations see exactly what the
    // tenant sees. The conditional statements themselves are measured in
    // `run/lifecycle.test.ts`; this is the composition edge.
    await untilRunExists(OPENED_PULL_REQUEST.number);
    const [created] = await database.admin<{ id: string }>(
      `select id from run where pull_request_number = ${OPENED_PULL_REQUEST.number}`
    );
    const runId = created?.id ?? "";

    await expect(
      controlPlane.lifecycle.schedule(9999, runId)
    ).resolves.toBeNull();
    await expect(
      controlPlane.lifecycle.record(ACME, runId, "wrun_composed")
    ).resolves.toBeTruthy();
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "queued",
      workflowRunId: "wrun_composed",
    });
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

  it.each(["gpt-5", "unknown-model"])(
    "refuses unsupported Codex Model/effort %s/max at composition",
    async (model) => {
      await expect(
        createControlPlane({
          database: { connectionString: database.runtimeUrl },
          github: {
            ...githubConfig,
            runProfile: {
              ...PHASE_0_RUN_PROFILE,
              model,
              resolvedConfig: {
                ...PHASE_0_RUN_PROFILE.resolvedConfig,
                review: {
                  ...PHASE_0_RUN_PROFILE.resolvedConfig.review,
                  harnessOptions: { codex: { reasoningEffort: "max" } },
                },
              },
            },
          },
        })
      ).rejects.toThrow(/Model.*reasoning effort/u);
    }
  );

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

  it("takes execution ownership through the hosted placement", async () => {
    // The Phase 0 profile's placement is `hosted`, which holds no durable
    // identity and no HTTP hop - so this is ADR 0015's placement-neutral half:
    // the same conditional UPDATE the Worker endpoint reaches, writing the same
    // token and the same deadline, with `worker_id` left null.
    const number = 12;
    await controlPlane.handleGitHubWebhook(
      signedDelivery({
        deliveryGuid: "delivery-that-becomes-a-claimed-run",
        body: deliveryBytes({
          ...OPENED_PULL_REQUEST,
          number,
          pull_request: { number },
        }),
      })
    );
    await untilRunExists(number);
    const [created] = await database.admin<{ id: string }>(
      `select id from run where pull_request_number = ${number}`
    );

    const outcome = await controlPlane.claimRun({
      ownerId: ACME,
      runId: created?.id ?? "",
    });

    expect(outcome.kind).toBe("granted");
    const [claimed] = await database.admin<{
      execution_expires_at: Date;
      claimed_at: Date;
      status: string;
      worker_id: string | null;
    }>(
      `select status, claimed_at, execution_expires_at, worker_id from run where pull_request_number = ${number}`
    );
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.worker_id).toBeNull();
    // The window comes from the injected profile rather than from a literal in
    // the claim path, which is the whole reason ADR 0016 placed it there.
    expect(
      (claimed?.execution_expires_at.getTime() ?? 0) -
        (claimed?.claimed_at.getTime() ?? 0)
    ).toBe(PHASE_0_RUN_PROFILE.livenessForMs);
  });

  it("serves the Worker claim endpoint, and refuses one with no credential", async () => {
    // The composition edge only: every named refusal is measured against the
    // real database in `worker/claim.test.ts`. What this says is that the route
    // has something to call, and that the thing it calls does not serve a
    // `RunSpec` to a stranger.
    const response = await controlPlane.handleWorkerClaim(
      new Request("https://control.example/api/worker/runs/claim", {
        method: "POST",
        body: JSON.stringify({
          protocolVersion: 1,
          workerBuildVersion: "0.0.0",
        }),
      })
    );

    expect(response.status).toBe(WORKER_CLAIM_STATUS.unauthenticated);
  });

  it("serves the Worker result endpoint, and refuses one with no credential", async () => {
    // The composition edge only: every named rejection is measured against the
    // real database in `worker/acceptance.test.ts`. What this says is that the
    // route has something to call, and that the thing it calls does not
    // terminalize a Run for a stranger.
    const response = await controlPlane.handleWorkerResult(
      new Request(
        "https://control.example/api/worker/runs/00000000-0000-4000-8000-000000000000/result",
        { method: "POST", body: JSON.stringify({}) }
      ),
      "00000000-0000-4000-8000-000000000000"
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.unauthenticated);
  });

  it("accepts a Result for the execution the hosted claim created", async () => {
    // The hosted placement's whole round trip through the composition: it
    // claims, it is handed an execution token, and it submits against that
    // token with no Worker and no HTTP hop. ADR 0015 makes both halves
    // placement-neutral, so this is the same UPDATE the endpoint reaches.
    const number = 13;
    await controlPlane.handleGitHubWebhook(
      signedDelivery({
        deliveryGuid: "delivery-that-becomes-an-accepted-run",
        body: deliveryBytes({
          ...OPENED_PULL_REQUEST,
          number,
          pull_request: { number },
        }),
      })
    );
    await untilRunExists(number);
    const [created] = await database.admin<{ id: string }>(
      `select id from run where pull_request_number = ${number}`
    );
    const runId = created?.id ?? "";
    const claim = await controlPlane.claimRun({ ownerId: ACME, runId });
    const executionToken =
      claim.kind === "granted" ? claim.grant.executionToken : "";

    const outcome = await controlPlane.acceptResult({
      ownerId: ACME,
      runId,
      executionToken,
      result: {
        runId,
        completeness: "complete",
        stoppedBy: null,
        summary: "Nothing to report.",
        disprovedHypothesisCount: 0,
        findings: [],
        passes: [
          {
            passId: "pass_01",
            harness: "codex",
            pinnedModel: "gpt-5.6",
            resolvedModel: null,
            startedAt: "2026-02-01T12:01:00Z",
            endedAt: "2026-02-01T12:18:00Z",
            outcome: "completed",
            failureReason: null,
            repairTurnUsed: false,
            usage: { inputTokens: 10, outputTokens: 20 },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 20 },
        protocolVersion: 1,
        workerBuildVersion: "0.0.0",
      },
    });

    expect(outcome).toStrictEqual({ kind: "accepted", runStatus: "completed" });
    const [accepted] = await database.admin<{
      status: string;
      accepted_at: Date | null;
    }>(
      `select status, accepted_at from run where pull_request_number = ${number}`
    );
    expect(accepted?.status).toBe("completed");
    expect(accepted?.accepted_at).not.toBeNull();
  });
});
