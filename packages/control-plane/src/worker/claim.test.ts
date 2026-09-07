/**
 * The claim against the real database, because every claim #54 makes is a claim
 * about Postgres.
 *
 * "A Run cannot be actively held twice" is a property of one conditional UPDATE
 * under a row lock, and no double can state it. Neither can a double state that
 * a forged Owner locator reaches nothing, which is
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)'s
 * whole safety argument and is enforced by row-level security rather than by the
 * query. So the whole path runs here - the real authenticator over the real
 * pooled runtime role, the real endpoint, the real claim - with nothing
 * substituted but the clock and the token mint.
 *
 * It needs the local stack for the reason every test in this package does, and
 * fails with instructions rather than skipping when it is down.
 */
import { claimSchemas } from "@reprove/protocol/v1";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../db/bootstrap.js";
import type { TestDatabase } from "../db/local-stack.test-support.js";
import {
  createTestDatabase,
  onRuntimeConnection,
  RUNTIME_PASSWORD,
} from "../db/local-stack.test-support.js";
import { migrate } from "../db/migrate.js";
import type { RuntimeDb } from "../db/runtime.js";
import { createRuntimeDb } from "../db/runtime.js";
import * as schema from "../db/schema.js";
import { PHASE_0_LIVENESS_FOR_MS } from "../github/profile.js";
import { createWorkerAuthenticator } from "./authenticate.js";
import type { ClaimOutcome } from "./claim-outcome.js";
import { WORKER_CLAIM_STATUS } from "./claim-outcome.js";
import type { ClaimConfig } from "./claim.js";
import { claimRun } from "./claim.js";
import { WORKER_PROTOCOL_SUPPORT } from "./compatibility.js";
import { hashWorkerSecret, mintWorkerCredential } from "./credential.js";
import { createWorkerClaimHandler } from "./endpoint.js";
import { hashExecutionToken } from "./execution-token.js";

const DATABASE = "reprove_test_worker_claim";

const ACME = 1001;
const GLOBEX = 2002;
const INSTALLATION = 42;
const BUILD = "worker-0.0.0";

/** Fixed, so `claimedAt + livenessFor` is a value a case can compute. */
const NOW = new Date("2026-02-01T12:00:00.000Z");
const CLAIMABLE_UNTIL = new Date("2026-02-01T12:05:00.000Z");
const TOKEN = "an-execution-token-minted-for-this-test";

let database: TestDatabase;
let runtime: RuntimeDb;
let pullRequest = 0;
let head = 0;

const CONFIG: ClaimConfig = {
  livenessForMs: PHASE_0_LIVENESS_FOR_MS,
  now: () => NOW,
  mintToken: () => TOKEN,
};

/** One Owner, its grant, and one Repository under it. */
const seedOwner = (ownerId: number, installationId: number | null) =>
  runtime.withOwner(ownerId, async (tx) => {
    await tx
      .insert(schema.owner)
      .values({ id: ownerId, login: `owner-${ownerId}`, type: "organization" });
    if (installationId !== null) {
      await tx
        .insert(schema.installation)
        .values({ id: installationId, ownerId });
    }
    await tx.insert(schema.repository).values({
      id: ownerId * 10,
      ownerId,
      installationId,
      nameWithOwner: `owner-${ownerId}/reprove`,
    });
  });

/** One enrolled Worker, with one credential row. */
const seedWorker = async (
  ownerId: number,
  credential: { readonly secretHash: string; readonly expiresAt?: Date }
): Promise<string> =>
  await runtime.withOwner(ownerId, async (tx) => {
    const [worker] = await tx
      .insert(schema.worker)
      .values({ ownerId, protocolVersion: 1, workerBuildVersion: BUILD })
      .returning({ id: schema.worker.id });
    const workerId = worker?.id ?? "";
    await tx.insert(schema.workerCredential).values({
      ownerId,
      workerId,
      secretHash: credential.secretHash,
      expiresAt: credential.expiresAt ?? null,
    });
    return workerId;
  });

/** One Run, claimable unless a case says otherwise. */
const seedRun = async (
  ownerId: number,
  overrides: Partial<typeof schema.run.$inferInsert> = {}
): Promise<string> => {
  pullRequest += 1;
  head += 1;
  const values = {
    ownerId,
    repositoryId: ownerId * 10,
    pullRequestNumber: pullRequest,
    baseSha: "a".repeat(40),
    headSha: head.toString(16).padStart(40, "0"),
    provenance: "internal",
    provenanceBasis: {
      ruleVersion: 1,
      baseRepositoryId: ownerId * 10,
      headRepositoryId: ownerId * 10,
      authorAssociation: "MEMBER",
      authorId: 5005,
      matchedSameRepository: true,
      matchedAssociation: true,
    },
    trigger: "automatic",
    harness: "codex",
    model: "gpt-5.6-sol",
    strategy: "standard",
    autonomy: "verify",
    placement: "self_hosted",
    allowHostedFallback: false,
    resolvedConfig: {
      schemaVersion: 1,
      review: {
        enabled: true,
        strategy: "standard",
        event: "COMMENT",
        threshold: { severity: "medium", verification: "any" },
        ignore: [],
        baseConventions: true,
        harnessOptions: {},
        overrides: [],
      },
      security: {
        maxExposure: "account",
        allowExternalProvenance: false,
        installScripts: "deny",
        allowHostedFallback: false,
        egress: [],
      },
    },
    configDigest: "sha256:abc",
    claimableUntil: CLAIMABLE_UNTIL,
    createdAt: new Date("2026-02-01T11:00:00.000Z"),
    ...overrides,
  };
  const created = await runtime.withOwner(ownerId, (tx) =>
    tx.insert(schema.run).values(values).returning({ id: schema.run.id })
  );
  return created[0]?.id ?? "";
};

const runRow = async (ownerId: number, runId: string) => {
  const [row] = await runtime.withOwner(ownerId, (tx) =>
    tx.select().from(schema.run).where(eq(schema.run.id, runId))
  );
  return row;
};

/** The real endpoint over the real database, and nothing else substituted. */
const handle = createWorkerClaimHandler({
  authenticate: (authorization) =>
    createWorkerAuthenticator({
      withOwner: (ownerId, fn) => runtime.withOwner(ownerId, fn),
      now: () => NOW,
    })(authorization),
  claim: (request) =>
    runtime.withOwner(request.ownerId, (tx) =>
      claimRun(tx, CONFIG, {
        ownerId: request.ownerId,
        runId: request.runId,
        worker: request.worker,
      })
    ),
});

/** The hosted placement's way in: the same claim, with no Worker behind it. */
const claimHosted = (ownerId: number, runId: string): Promise<ClaimOutcome> =>
  runtime.withOwner(ownerId, (tx) =>
    claimRun(tx, CONFIG, { ownerId, runId, worker: null })
  );

const claiming = (
  credential: string,
  body: Readonly<Record<string, number | string>>
): Request =>
  new Request("https://control.example/api/worker/runs/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  });

describe("claiming a Run", () => {
  let acmeCredential = mintWorkerCredential(ACME);
  let acmeWorker = "";

  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
  });

  beforeEach(async () => {
    await database.admin("delete from run");
    await database.admin("delete from worker_credential");
    await database.admin("delete from worker");
    await database.admin("delete from repository");
    await database.admin("delete from installation");
    await database.admin("delete from owner");

    acmeCredential = mintWorkerCredential(ACME);
    await seedOwner(ACME, INSTALLATION);
    acmeWorker = await seedWorker(ACME, {
      secretHash: acmeCredential.secretHash,
    });
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  describe("a granted claim", () => {
    it("returns a valid RunSpec for a queued, claimable Run", async () => {
      const runId = await seedRun(ACME);

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.granted);
      const grant = claimSchemas.grant.parse(await response.json());
      expect(grant.runSpec).toMatchObject({
        runId,
        ownerId: String(ACME),
        repositoryId: String(ACME * 10),
        installationId: String(INSTALLATION),
        placement: "self_hosted",
        harness: "codex",
      });
    });

    it("takes execution ownership on the row, readable under withOwner", async () => {
      const runId = await seedRun(ACME);

      await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      await expect(runRow(ACME, runId)).resolves.toMatchObject({
        status: "claimed",
        claimedAt: NOW,
        executionTokenHash: hashExecutionToken(TOKEN),
        workerId: acmeWorker,
        workerProtocolVersion: WORKER_PROTOCOL_SUPPORT.current,
        workerBuildVersion: BUILD,
      });
    });

    it("keeps no plaintext of the execution token anywhere in the row", async () => {
      // The grant is the token's one and only appearance. A database read or a
      // backup that yielded it would yield a bearer capability good against
      // this Run until `executionExpiresAt`, so the row holds the digest and
      // the whole row is searched rather than only the column that should
      // hold it.
      const runId = await seedRun(ACME);

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      const grant = claimSchemas.grant.parse(await response.json());
      expect(grant.executionToken).toBe(TOKEN);
      const stored = await database.admin<{ execution_token_hash: string }>(
        `select * from run where id = '${runId}'`
      );
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).toContain(hashExecutionToken(TOKEN));
    });

    it("measures the liveness boundary from claimedAt and from nothing else", async () => {
      // ADR 0015: "`executionExpiresAt = claimedAt + livenessFor`. Not from Run
      // creation, not from `claimableUntil`, and not from whenever
      // `markExecuting` happens to succeed." The seeded Run's `createdAt` and
      // `claimableUntil` are both away from `NOW`, so each wrong origin
      // produces a different timestamp and the assertion can tell them apart.
      const runId = await seedRun(ACME);

      await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      const row = await runRow(ACME, runId);
      const createdAt = row?.createdAt ?? NOW;
      expect(row?.executionExpiresAt).toStrictEqual(
        new Date(NOW.getTime() + PHASE_0_LIVENESS_FOR_MS)
      );
      expect(row?.executionExpiresAt).not.toStrictEqual(
        new Date(createdAt.getTime() + PHASE_0_LIVENESS_FOR_MS)
      );
      expect(row?.executionExpiresAt).not.toStrictEqual(
        new Date(CLAIMABLE_UNTIL.getTime() + PHASE_0_LIVENESS_FOR_MS)
      );
    });

    it("carries the same execution ownership for the hosted placement", async () => {
      // ADR 0015 makes the token and the deadline placement-neutral, and #57
      // composes hosted dispatch on top of exactly this call. A hosted Worker
      // holds no durable identity, so `worker_id` stays null - which is the
      // difference, and the only one.
      const runId = await seedRun(ACME, { placement: "hosted" });

      const outcome = await claimHosted(ACME, runId);

      expect(outcome.kind).toBe("granted");
      // Placement-neutral in both halves: hosted dispatch is handed the
      // plaintext token the same way a self-hosted Worker is, and the row keeps
      // only the digest either way.
      expect(
        outcome.kind === "granted" ? outcome.grant.executionToken : null
      ).toBe(TOKEN);
      await expect(runRow(ACME, runId)).resolves.toMatchObject({
        status: "claimed",
        claimedAt: NOW,
        executionTokenHash: hashExecutionToken(TOKEN),
        executionExpiresAt: new Date(NOW.getTime() + PHASE_0_LIVENESS_FOR_MS),
        workerId: null,
        workerProtocolVersion: null,
        workerBuildVersion: null,
      });
    });
  });

  describe("a second claim", () => {
    const claimSameRun = (runId: string) =>
      handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

    it("is refused by name, with the first execution untouched", async () => {
      const runId = await seedRun(ACME);
      await claimSameRun(runId);

      const second = await claimSameRun(runId);

      expect(second.status).toBe(WORKER_CLAIM_STATUS.refused);
      await expect(second.json()).resolves.toStrictEqual({
        status: WORKER_CLAIM_STATUS.refused,
        reason: "already_claimed",
      });
      const held = await runRow(ACME, runId);
      expect(held?.executionTokenHash).toBe(hashExecutionToken(TOKEN));
    });

    it("loses the race exactly once when both arrive at the same time", async () => {
      // Sequential refusal proves only that a claimed Run refuses a claim. The
      // invariant is a property of one statement under a row lock, and only a
      // concurrent pair tests it as one.
      const runId = await seedRun(ACME);

      const [first, second] = await Promise.all([
        claimSameRun(runId),
        claimSameRun(runId),
      ]);

      const statuses = [first.status, second.status].toSorted();
      expect(statuses).toStrictEqual([
        WORKER_CLAIM_STATUS.granted,
        WORKER_CLAIM_STATUS.refused,
      ]);
    });
  });

  describe("a claim window that has closed", () => {
    it("is refused by name, and the Run is left exactly as it was", async () => {
      const runId = await seedRun(ACME, {
        claimableUntil: new Date(NOW.getTime() - 1000),
      });

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.refused);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_CLAIM_STATUS.refused,
        reason: "claim_window_closed",
      });
      // Still `queued`, because closing the window is the lifecycle's
      // transition to make and not the claim's (ADR 0014).
      await expect(runRow(ACME, runId)).resolves.toMatchObject({
        status: "queued",
        claimedAt: null,
        executionTokenHash: null,
        executionExpiresAt: null,
      });
    });
  });

  describe("a Run that cannot be claimed for another reason", () => {
    it("names a terminal Run rather than calling it already claimed", async () => {
      const runId = await seedRun(ACME, { status: "unscheduled" });

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      await expect(response.json()).resolves.toMatchObject({
        reason: "not_claimable",
      });
    });

    it("refuses a hosted Run to a self-hosted Worker, by name", async () => {
      // The poll has always filtered `placement`; a targeted claim did not, so
      // the guard was only on the path that does not name a Run. The two
      // placements are dispatched by different mechanisms, and a Run taken by
      // the wrong one is a Run dispatched twice.
      const runId = await seedRun(ACME, { placement: "hosted" });

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.refused);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_CLAIM_STATUS.refused,
        reason: "placement_mismatch",
      });
      await expect(runRow(ACME, runId)).resolves.toMatchObject({
        status: "queued",
        claimedAt: null,
        executionTokenHash: null,
        executionExpiresAt: null,
        workerId: null,
      });
    });

    it("refuses a self-hosted Run to the hosted placement, by the same name", async () => {
      const runId = await seedRun(ACME);

      await expect(claimHosted(ACME, runId)).resolves.toStrictEqual({
        kind: "refused",
        reason: "placement_mismatch",
      });
      const untouched = await runRow(ACME, runId);
      expect(untouched?.status).toBe("queued");
    });

    it("answers a Run id that is not a uuid as unknown, not as an outage", async () => {
      // The column is `uuid`, so an id of the wrong shape is rejected by
      // Postgres rather than failing to match: `22P02` rolls the transaction
      // back and the endpoint reads that as `503`, telling a Worker the control
      // plane is down when it asked for a Run that cannot exist.
      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId: "not-a-uuid",
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.unknownRun);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_CLAIM_STATUS.unknownRun,
        reason: "unknown_run",
      });
    });

    it("names a Repository with no live grant, and claims nothing", async () => {
      await seedOwner(GLOBEX, null);
      const globexCredential = mintWorkerCredential(GLOBEX);
      await seedWorker(GLOBEX, { secretHash: globexCredential.secretHash });
      const runId = await seedRun(GLOBEX);

      const response = await handle(
        claiming(globexCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.refused);
      await expect(response.json()).resolves.toMatchObject({
        reason: "installation_unavailable",
      });
      const runIdRow = await runRow(GLOBEX, runId);
      expect(runIdRow?.status).toBe("queued");
    });
  });

  describe("an incompatible protocol version", () => {
    it("is refused by name, and no RunSpec is served", async () => {
      const runId = await seedRun(ACME);

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current + 1,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.incompatible);
      await expect(response.json()).resolves.toMatchObject({
        reason: "unsupported_protocol_version",
        minimum: WORKER_PROTOCOL_SUPPORT.minimum,
        current: WORKER_PROTOCOL_SUPPORT.current,
      });
      await expect(runRow(ACME, runId)).resolves.toMatchObject({
        status: "queued",
        executionTokenHash: null,
      });
    });
  });

  describe("the tenant boundary in front of the credential", () => {
    it("refuses a forged Owner locator, and reaches nothing under it", async () => {
      // ADR 0008's safety argument end to end: ACME's secret presented under
      // GLOBEX's locator opens GLOBEX's tenant, where no row matches. Nothing
      // about ACME is reachable from there, and the answer is the same `401`
      // every other credential failure gets.
      await seedOwner(GLOBEX, INSTALLATION + 1);
      const runId = await seedRun(GLOBEX);

      const response = await handle(
        claiming(`rpw1.${GLOBEX}.${acmeCredential.secret}`, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.unauthenticated);
      const runIdRow = await runRow(GLOBEX, runId);
      expect(runIdRow?.status).toBe("queued");
    });

    it("hides a Run of another Owner behind unknown_run", async () => {
      // Not `wrong_tenant`. The probe runs inside `withOwner`, so GLOBEX's Run
      // is invisible rather than ineligible, and ADR 0016 makes that
      // indistinguishability the decision: the response stops confirming that a
      // Run exists under an Owner the caller cannot see.
      await seedOwner(GLOBEX, INSTALLATION + 1);
      const foreign = await seedRun(GLOBEX);

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId: foreign,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.unknownRun);
      await expect(response.json()).resolves.toMatchObject({
        reason: "unknown_run",
      });
      const foreignRow = await runRow(GLOBEX, foreign);
      expect(foreignRow?.status).toBe("queued");
    });

    it("denies a credential read taken under the wrong Owner context", async () => {
      // The policy answering rather than the query: a raw pooled connection as
      // the runtime role, with GLOBEX's tenant context, sees none of ACME's
      // credential rows even though the hash it holds is ACME's.
      const seen = await onRuntimeConnection(DATABASE, async (client) => {
        await client.query("begin");
        try {
          await client.query("select set_config('app.owner_id', $1, true)", [
            String(GLOBEX),
          ]);
          const { rows } = await client.query(
            "select id from worker_credential where secret_hash = $1",
            [acmeCredential.secretHash]
          );
          return rows;
        } finally {
          await client.query("rollback");
        }
      });

      expect(seen).toStrictEqual([]);
      const all = await database.admin<{ n: string }>(
        "select count(*)::text as n from worker_credential"
      );
      expect(all[0]?.n).toBe("1");
    });
  });

  describe("credentials as rows", () => {
    it("keeps no plaintext of the secret anywhere in the row", async () => {
      const rows = await database.admin<{ secret_hash: string }>(
        "select * from worker_credential"
      );
      const serialized = JSON.stringify(rows);

      expect(serialized).not.toContain(acmeCredential.secret);
      expect(serialized).toContain(acmeCredential.secretHash);
    });

    it("authenticates predecessor and successor together during rotation", async () => {
      // ADR 0006 requires "a short overlap during which the predecessor remains
      // valid, so rotation cannot brick a Worker mid-Run", and ADR 0008 makes
      // that an ordinary row lifetime: the predecessor takes
      // `expiresAt = graceEnd` and both rows satisfy the same predicate until
      // it passes. Nothing here is a current-and-previous column.
      const graceEnd = new Date(NOW.getTime() + 60_000);
      const successor = mintWorkerCredential(ACME);
      await runtime.withOwner(ACME, async (tx) => {
        await tx
          .update(schema.workerCredential)
          .set({ expiresAt: graceEnd })
          .where(
            eq(schema.workerCredential.secretHash, acmeCredential.secretHash)
          );
        await tx.insert(schema.workerCredential).values({
          ownerId: ACME,
          workerId: acmeWorker,
          secretHash: successor.secretHash,
        });
      });

      const runs = await Promise.all([seedRun(ACME), seedRun(ACME)]);
      const responses = await Promise.all(
        [acmeCredential, successor].map((credential, at) =>
          handle(
            claiming(credential.credential, {
              protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
              workerBuildVersion: BUILD,
              runId: runs[at] ?? "",
            })
          )
        )
      );

      expect(responses.map((response) => response.status)).toStrictEqual([
        WORKER_CLAIM_STATUS.granted,
        WORKER_CLAIM_STATUS.granted,
      ]);
    });

    it.each([
      ["expired", { expiresAt: new Date(NOW.getTime() - 1000) }],
      ["revoked", { revokedAt: new Date(NOW.getTime() - 1000) }],
    ])("refuses a credential that is %s", async (_label, ending) => {
      await runtime.withOwner(ACME, (tx) =>
        tx
          .update(schema.workerCredential)
          .set(ending)
          .where(
            eq(schema.workerCredential.secretHash, acmeCredential.secretHash)
          )
      );
      const runId = await seedRun(ACME);

      const response = await handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
          runId,
        })
      );

      expect(response.status).toBe(WORKER_CLAIM_STATUS.unauthenticated);
      const runIdRow = await runRow(ACME, runId);
      expect(runIdRow?.status).toBe("queued");
    });

    it("stores the hash the parser computes, and not the credential", async () => {
      const [row] = await database.admin<{ secret_hash: string }>(
        "select secret_hash from worker_credential"
      );

      expect(row?.secret_hash).toBe(hashWorkerSecret(acmeCredential.secret));
      expect(row?.secret_hash).not.toBe(acmeCredential.credential);
    });
  });

  describe("a poll", () => {
    const poll = () =>
      handle(
        claiming(acmeCredential.credential, {
          protocolVersion: WORKER_PROTOCOL_SUPPORT.current,
          workerBuildVersion: BUILD,
        })
      );

    it("answers 204 when this Owner has nothing claimable", async () => {
      const response = await poll();

      expect(response.status).toBe(WORKER_CLAIM_STATUS.noRunAvailable);
    });

    it("takes the oldest claimable self-hosted Run first", async () => {
      const older = await seedRun(ACME, {
        createdAt: new Date("2026-02-01T10:00:00.000Z"),
      });
      await seedRun(ACME, {
        createdAt: new Date("2026-02-01T11:30:00.000Z"),
      });

      const response = await poll();
      const grant = claimSchemas.grant.parse(await response.json());

      expect(grant.runSpec.runId).toBe(older);
    });

    it("never reaches a hosted Run, which is dispatched rather than polled", async () => {
      await seedRun(ACME, { placement: "hosted" });
      const response = await poll();

      expect(response.status).toBe(WORKER_CLAIM_STATUS.noRunAvailable);
    });

    it("never reaches another Owner's Run", async () => {
      await seedOwner(GLOBEX, INSTALLATION + 1);
      const foreign = await seedRun(GLOBEX);

      const response = await poll();

      expect(response.status).toBe(WORKER_CLAIM_STATUS.noRunAvailable);
      const untouched = await runRow(GLOBEX, foreign);
      expect(untouched?.status).toBe("queued");
    });

    it("refreshes Worker liveness even when there is nothing to claim", async () => {
      // ADR 0006: "Idle polling is the heartbeat when a Worker is idle", and
      // there is no separate heartbeat message. So the empty poll is the case
      // that matters: written only after a grant, a Worker with nothing to do
      // would look offline, which is the reading the three signals exist to
      // prevent.
      const response = await poll();

      expect(response.status).toBe(WORKER_CLAIM_STATUS.noRunAvailable);
      const [worker] = await runtime.withOwner(ACME, (tx) =>
        tx.select().from(schema.worker)
      );
      expect(worker?.lastSeenAt).toStrictEqual(NOW);
    });

    it("gives two concurrent Workers two different Runs", async () => {
      // `for update skip locked` is what makes this true: the second poll steps
      // past the row the first is holding rather than blocking on it.
      await seedRun(ACME);
      await seedRun(ACME);

      const [first, second] = await Promise.all([poll(), poll()]);

      expect([first.status, second.status]).toStrictEqual([
        WORKER_CLAIM_STATUS.granted,
        WORKER_CLAIM_STATUS.granted,
      ]);
      const claimed = await runtime.withOwner(ACME, (tx) =>
        tx.select({ id: schema.run.id }).from(schema.run)
      );
      const grants = await Promise.all([first.json(), second.json()]);
      const taken = new Set(
        grants.map((grant) => claimSchemas.grant.parse(grant).runSpec.runId)
      );
      expect(taken.size).toBe(2);
      expect(claimed).toHaveLength(2);
    });
  });
});
