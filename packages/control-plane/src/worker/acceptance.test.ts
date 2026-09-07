/**
 * Acceptance against the real database, because every claim #55 makes is a
 * claim about Postgres.
 *
 * "At most one accepted terminal Result for the current Run state" is a
 * property of one conditional UPDATE under a row lock, and no double can state
 * it. Neither can a double state that another Owner's Run is **invisible**
 * rather than merely ineligible, which is
 * [ADR 0016](../../../../docs/adr/0016-phase-0-acceptance-scenario.md)'s reason
 * for removing `wrong_tenant` from the rejection set. So the whole path runs
 * here - the real authenticator over the real pooled runtime role, the real
 * endpoint, the real acceptance - with nothing substituted but the clock.
 *
 * It needs the local stack for the reason every test in this package does, and
 * fails with instructions rather than skipping when it is down.
 */
import type { Finding, Result } from "@reprove/protocol/v1";
import { protocolVersion } from "@reprove/protocol/v1";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../db/bootstrap.js";
import type { TestDatabase } from "../db/local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "../db/local-stack.test-support.js";
import { migrate } from "../db/migrate.js";
import type { RuntimeDb } from "../db/runtime.js";
import { createRuntimeDb } from "../db/runtime.js";
import * as schema from "../db/schema.js";
import { WORKER_RESULT_STATUS } from "./acceptance-outcome.js";
import type { AcceptanceConfig } from "./acceptance.js";
import { acceptResult, bucketKeyOf } from "./acceptance.js";
import { createWorkerAuthenticator } from "./authenticate.js";
import { hashWorkerSecret, mintWorkerCredential } from "./credential.js";
import { hashExecutionToken } from "./execution-token.js";
import { createWorkerResultHandler } from "./result-endpoint.js";

const DATABASE = "reprove_test_worker_acceptance";

const ACME = 1001;
const GLOBEX = 2002;
const INSTALLATION = 42;
const BUILD = "worker-0.0.0";

/** Fixed, so `acceptedAt` is a value a case can compare against. */
const NOW = new Date("2026-02-01T12:20:00.000Z");
const CLAIMED_AT = new Date("2026-02-01T12:00:00.000Z");
const CLAIMABLE_UNTIL = new Date("2026-02-01T12:05:00.000Z");
const EXECUTION_EXPIRES_AT = new Date("2026-02-01T12:10:00.000Z");

const TOKEN = "an-execution-token-handed-back-by-the-claim";
const OTHER_TOKEN = "a-token-that-was-rotated-out-from-under-it";

let database: TestDatabase;
let runtime: RuntimeDb;
let pullRequest = 0;
let head = 0;

const CONFIG: AcceptanceConfig = { now: () => NOW };

const FINDING: Finding = {
  title: "Session comparison leaks timing information",
  body: "The comparison exits at the first differing byte.",
  severity: "high",
  verification: "verified",
  location: { path: "src/session.ts", startLine: 41, endLine: 43 },
  anchoredText: "if (token === stored) return true",
  evidence: [
    {
      command: "pnpm test timing",
      exitCode: 0,
      durationMs: 4120,
      excerpt: "mean delta 1.9ms over 10k trials",
      truncated: false,
      originalByteLength: 34,
    },
  ],
};

const resultFor = (runId: string, overrides: Partial<Result> = {}): Result => ({
  runId,
  completeness: "complete",
  stoppedBy: null,
  summary: "Reviewed the change and verified one finding.",
  disprovedHypothesisCount: 2,
  findings: [FINDING],
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
      usage: { inputTokens: 180_000, outputTokens: 9400 },
    },
  ],
  usage: { inputTokens: 180_000, outputTokens: 9400 },
  protocolVersion,
  workerBuildVersion: "0.1.0",
  ...overrides,
});

/** One Owner, its grant, and one Repository under it. */
const seedOwner = (ownerId: number) =>
  runtime.withOwner(ownerId, async (tx) => {
    await tx
      .insert(schema.owner)
      .values({ id: ownerId, login: `owner-${ownerId}`, type: "organization" });
    await tx
      .insert(schema.installation)
      .values({ id: ownerId + INSTALLATION, ownerId });
    await tx.insert(schema.repository).values({
      id: ownerId * 10,
      ownerId,
      installationId: ownerId + INSTALLATION,
      nameWithOwner: `owner-${ownerId}/reprove`,
    });
  });

/** One enrolled Worker, with one credential row. */
const seedWorker = async (
  ownerId: number,
  secretHash: string
): Promise<string> =>
  await runtime.withOwner(ownerId, async (tx) => {
    const [worker] = await tx
      .insert(schema.worker)
      .values({ ownerId, protocolVersion, workerBuildVersion: BUILD })
      .returning({ id: schema.worker.id });
    const workerId = worker?.id ?? "";
    await tx
      .insert(schema.workerCredential)
      .values({ ownerId, workerId, secretHash });
    return workerId;
  });

/** One Run, claimed and Result-eligible unless a case says otherwise. */
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

    // The execution ownership a claim would have written.
    status: "claimed",
    claimedAt: CLAIMED_AT,
    executionTokenHash: hashExecutionToken(TOKEN),
    executionExpiresAt: EXECUTION_EXPIRES_AT,
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

const findingRows = (ownerId: number, runId: string) =>
  runtime.withOwner(ownerId, (tx) =>
    tx.select().from(schema.finding).where(eq(schema.finding.runId, runId))
  );

/** The real endpoint over the real database, and nothing else substituted. */
const handle = createWorkerResultHandler({
  authenticate: (authorization) =>
    createWorkerAuthenticator({
      withOwner: (ownerId, fn) => runtime.withOwner(ownerId, fn),
      now: () => NOW,
    })(authorization),
  accept: (submission) =>
    runtime.withOwner(submission.ownerId, (tx) =>
      acceptResult(tx, CONFIG, submission)
    ),
});

/**
 * The envelope, with every field optional and unknown, because several cases
 * below send shapes a Worker should not be able to send at all.
 */
interface SubmissionBody {
  readonly protocolVersion?: unknown;
  readonly executionToken?: unknown;
  readonly idempotencyKey?: unknown;
  readonly result?: unknown;
}

const submitting = (
  credential: string,
  runId: string,
  body: SubmissionBody
): [Request, string] => [
  new Request(`https://control.example/api/worker/runs/${runId}/result`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
    body: JSON.stringify(body),
  }),
  runId,
];

describe("accepting a Result", () => {
  let acmeCredential = mintWorkerCredential(ACME);

  const submit = (
    runId: string,
    overrides: SubmissionBody = {},
    result: Result = resultFor(runId)
  ) =>
    handle(
      ...submitting(acmeCredential.credential, runId, {
        protocolVersion,
        executionToken: TOKEN,
        result,
        ...overrides,
      })
    );

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
    await database.admin("delete from finding");
    await database.admin("delete from run");
    await database.admin("delete from worker_credential");
    await database.admin("delete from worker");
    await database.admin("delete from repository");
    await database.admin("delete from installation");
    await database.admin("delete from owner");

    acmeCredential = mintWorkerCredential(ACME);
    await seedOwner(ACME);
    await seedWorker(ACME, acmeCredential.secretHash);
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  describe("an eligible Result", () => {
    it("terminalizes its Run and records acceptedAt", async () => {
      const runId = await seedRun(ACME);

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_RESULT_STATUS.accepted,
        runStatus: "completed",
      });
      const row = await runRow(ACME, runId);
      expect(row?.status).toBe("completed");
      expect(row?.acceptedAt).toStrictEqual(NOW);
    });

    it("absorbs the Result into the Run, which has no table of its own", async () => {
      // ADR 0007: "`Result` has no table ... it is absorbed into the Run on
      // acceptance." So the summary, the usage and the passes are columns of
      // the Run the Result terminalized.
      const runId = await seedRun(ACME);
      const result = resultFor(runId);

      await submit(runId);

      const row = await runRow(ACME, runId);
      expect(row?.resultSummary).toBe(result.summary);
      expect(row?.resultStoppedBy).toBeNull();
      expect(row?.resultDisprovedHypothesisCount).toBe(2);
      expect(row?.resultUsage).toStrictEqual(result.usage);
      expect(row?.passes).toStrictEqual(result.passes);
    });

    it("ends a partial Result at `incomplete` rather than at `completed`", async () => {
      // ADR 0007 makes `incomplete` a status rather than a flag inside the
      // Result, because the Run's own status is what reports the outcome.
      const runId = await seedRun(ACME);

      const response = await submit(
        runId,
        {},
        {
          ...resultFor(runId),
          completeness: "partial",
          stoppedBy: "budget_exhausted",
        }
      );

      expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
      const row = await runRow(ACME, runId);
      expect(row?.status).toBe("incomplete");
      expect(row?.resultStoppedBy).toBe("budget_exhausted");
    });

    it("accepts a Result submitted while the Run is `executing`", async () => {
      const runId = await seedRun(ACME, { status: "executing" });

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
    });

    it("accepts one whose liveness window has passed, because Acceptance is not the watchdog", async () => {
      // ADR 0015 races two conditional updates over one window. Whichever wins
      // closes the other path, so an expired deadline that nothing has acted on
      // yet is not itself a rejection - the terminal transition is (#56).
      const runId = await seedRun(ACME, {
        executionExpiresAt: new Date("2026-02-01T12:10:00.000Z"),
      });

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
    });
  });

  describe("the Findings the accepted Result carried", () => {
    it("persists them as rows with owner_id denormalized", async () => {
      const runId = await seedRun(ACME);

      await submit(runId);

      const rows = await findingRows(ACME, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ownerId: ACME,
        runId,
        path: "src/session.ts",
        line: 41,
        endLine: 43,
        severity: "high",
        verification: "verified",
        title: FINDING.title,
        body: FINDING.body,
        anchoredText: FINDING.anchoredText,
        evidence: FINDING.evidence,
        patch: null,
      });
    });

    it("keys each one for Reconciliation without matching anything yet", async () => {
      // ADR 0007's bucket key is `path + normalized anchored-source hash`,
      // excluding line and severity on purpose. Matching inside a bucket is
      // Reconciliation and belongs to the phase that publishes a Review.
      const runId = await seedRun(ACME);

      await submit(runId);

      const [row] = await findingRows(ACME, runId);
      expect(row?.bucketKey).toBe(bucketKeyOf(FINDING));
      expect(row?.bucketKeyVersion).toBe(1);
      expect(row?.reconciliation).toBeNull();
      expect(row?.publicationDisposition).toBeNull();
    });

    it("writes none of them when the Result is rejected", async () => {
      const runId = await seedRun(ACME, { status: "failed" });

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.rejected);
      await expect(findingRows(ACME, runId)).resolves.toStrictEqual([]);
    });

    it("hides them from another Owner, because the row carries its own tenant", async () => {
      const runId = await seedRun(ACME);
      await submit(runId);

      const visible = await runtime.withOwner(GLOBEX, (tx) =>
        tx.select().from(schema.finding)
      );

      expect(visible).toStrictEqual([]);
    });
  });

  describe("a Run that cannot accept it", () => {
    it("rejects a Result for an already-terminal Run as not_eligible", async () => {
      const runId = await seedRun(ACME, { status: "failed" });

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.rejected);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_RESULT_STATUS.rejected,
        reason: "not_eligible",
      });
    });

    it("rejects a second Result for a Run that already accepted one", async () => {
      const runId = await seedRun(ACME);
      await submit(runId);

      const second = await submit(runId);

      expect(second.status).toBe(WORKER_RESULT_STATUS.rejected);
      await expect(second.json()).resolves.toMatchObject({
        reason: "not_eligible",
      });
      const row = await runRow(ACME, runId);
      expect(row?.acceptedAt).toStrictEqual(NOW);
      await expect(findingRows(ACME, runId)).resolves.toHaveLength(1);
    });

    it("rejects a Result for a Run that was never claimed", async () => {
      const runId = await seedRun(ACME, {
        status: "queued",
        claimedAt: null,
        executionTokenHash: null,
        executionExpiresAt: null,
      });

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.rejected);
      await expect(response.json()).resolves.toMatchObject({
        reason: "not_eligible",
      });
    });
  });

  describe("a token that is not the Run's current one", () => {
    it("rejects it as execution_mismatch while the Run is still active", async () => {
      const runId = await seedRun(ACME);

      const response = await submit(runId, { executionToken: OTHER_TOKEN });

      expect(response.status).toBe(WORKER_RESULT_STATUS.rejected);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_RESULT_STATUS.rejected,
        reason: "execution_mismatch",
      });
      const row = await runRow(ACME, runId);
      expect(row?.status).toBe("claimed");
      expect(row?.acceptedAt).toBeNull();
    });

    it("names terminal state before token identity, which is the whole ordering", async () => {
      // ADR 0016 found this stated but not implemented. A stale token against a
      // Run that a `worker_lost` transition already terminalized is
      // `not_eligible`, NOT `execution_mismatch`: ADR 0015 says the Run being
      // terminal "is a stronger and clearer fact than token rotation". Both
      // orders return a rejection and both look correct; only the name differs,
      // which is why nothing but a test that reads the name catches it.
      const runId = await seedRun(ACME, { status: "failed" });

      const response = await submit(runId, { executionToken: OTHER_TOKEN });

      await expect(response.json()).resolves.toMatchObject({
        reason: "not_eligible",
      });
    });

    it("names an already-accepted Run the same way, for the same reason", async () => {
      const runId = await seedRun(ACME);
      await submit(runId);

      const late = await submit(runId, { executionToken: OTHER_TOKEN });

      await expect(late.json()).resolves.toMatchObject({
        reason: "not_eligible",
      });
    });
  });

  describe("the tenant boundary in front of the Run", () => {
    it("hides another Owner's Run behind unknown_run", async () => {
      // ADR 0016: the re-probe runs inside `withOwner`, so another Owner's Run
      // is invisible rather than merely ineligible, and `wrong_tenant` is
      // unreachable by construction. The indistinguishability is the decision.
      await seedOwner(GLOBEX);
      const runId = await seedRun(GLOBEX);

      const response = await submit(runId);

      expect(response.status).toBe(WORKER_RESULT_STATUS.unknownRun);
      await expect(response.json()).resolves.toStrictEqual({
        status: WORKER_RESULT_STATUS.unknownRun,
        reason: "unknown_run",
      });
      const untouched = await runRow(GLOBEX, runId);
      expect(untouched?.status).toBe("claimed");
      expect(untouched?.acceptedAt).toBeNull();
    });

    it("gives a Run id this Owner does not hold the same answer", async () => {
      const response = await submit("33333333-3333-4333-8333-333333333333");

      expect(response.status).toBe(WORKER_RESULT_STATUS.unknownRun);
    });

    it("answers a Run id that is not a uuid as unknown, not as an outage", async () => {
      // A `uuid` column rejects the string rather than failing to match it, and
      // a rolled-back transaction reads as `503` - which would tell a Worker
      // the control plane is unavailable when it asked for a Run that cannot
      // exist. The shape is checked here, where the column is.
      const response = await handle(
        ...submitting(acmeCredential.credential, "not-a-uuid", {
          protocolVersion,
          executionToken: TOKEN,
          result: resultFor("not-a-uuid"),
        })
      );

      expect(response.status).toBe(WORKER_RESULT_STATUS.unknownRun);
    });
  });

  describe("a payload the Run's Autonomy forbids", () => {
    it("rejects a Patch under any Autonomy but fix, naming the Autonomy", async () => {
      // ADR 0007: "A `Patch` is rejected at acceptance under any Autonomy but
      // `fix`." It is a statement about the payload measured against the Run's
      // immutable spec, so it is a `422` beside the schema failures rather than
      // a seventh entry in ADR 0016's rejection set.
      const runId = await seedRun(ACME);

      const response = await submit(
        runId,
        {},
        {
          ...resultFor(runId),
          findings: [
            {
              ...FINDING,
              patch: {
                path: "src/session.ts",
                startLine: 41,
                endLine: 43,
                replacement: "if (timingSafeEqual(token, stored)) return true",
              },
            },
          ],
        }
      );

      expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
      await expect(response.json()).resolves.toMatchObject({
        reason: expect.stringContaining("autonomy=verify"),
      });
      const row = await runRow(ACME, runId);
      expect(row?.status).toBe("claimed");
      expect(row?.acceptedAt).toBeNull();
      await expect(findingRows(ACME, runId)).resolves.toStrictEqual([]);
    });

    it("accepts the same Patch under autonomy=fix", async () => {
      const runId = await seedRun(ACME, { autonomy: "fix" });
      const patch = {
        path: "src/session.ts",
        startLine: 41,
        endLine: 43,
        replacement: "if (timingSafeEqual(token, stored)) return true",
      };

      const response = await submit(
        runId,
        {},
        {
          ...resultFor(runId),
          findings: [{ ...FINDING, patch }],
        }
      );

      expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
      const [row] = await findingRows(ACME, runId);
      expect(row?.patch).toStrictEqual(patch);
    });
  });

  describe("a Result that fails protocol validation", () => {
    it("is rejected before it can affect Run state", async () => {
      const runId = await seedRun(ACME);

      const response = await submit(
        runId,
        {},
        {
          ...resultFor(runId),
          findings: [{ ...FINDING, verification: "verified", evidence: [] }],
        }
      );

      expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
      const row = await runRow(ACME, runId);
      expect(row?.status).toBe("claimed");
      expect(row?.acceptedAt).toBeNull();
      await expect(findingRows(ACME, runId)).resolves.toStrictEqual([]);
    });
  });

  describe("an unauthenticated submission", () => {
    it("changes nothing, whatever it carries", async () => {
      const runId = await seedRun(ACME);
      const forged = mintWorkerCredential(ACME);

      const response = await handle(
        ...submitting(forged.credential, runId, {
          protocolVersion,
          executionToken: TOKEN,
          result: resultFor(runId),
        })
      );

      expect(response.status).toBe(WORKER_RESULT_STATUS.unauthenticated);
      expect(hashWorkerSecret(forged.secret)).not.toBe(
        acmeCredential.secretHash
      );
      const row = await runRow(ACME, runId);
      expect(row?.acceptedAt).toBeNull();
    });
  });

  describe("two submissions that arrive at the same time", () => {
    it("accepts exactly one, and the statement is what decides", async () => {
      // Two sequential submissions would prove only that a terminal Run rejects
      // a Result, which the supersession case already covers. The invariant ADR
      // 0006 states - "at most one accepted terminal Result for the current Run
      // state" - is a property of one statement, and only a concurrent pair
      // tests it as one. Both reach the same conditional UPDATE at the same
      // row; Postgres serializes them on the row lock, one commits, and the
      // other re-evaluates its `WHERE` against the committed row.
      const runId = await seedRun(ACME);

      const [first, second] = await Promise.all([submit(runId), submit(runId)]);

      const statuses = [first.status, second.status].toSorted();
      expect(statuses).toStrictEqual([
        WORKER_RESULT_STATUS.accepted,
        WORKER_RESULT_STATUS.rejected,
      ]);
      const rejected =
        first.status === WORKER_RESULT_STATUS.accepted ? second : first;
      await expect(rejected.json()).resolves.toStrictEqual({
        status: WORKER_RESULT_STATUS.rejected,
        reason: "not_eligible",
      });

      // The two responses alone would pass against an implementation that
      // accepted twice and overwrote. The invariant is about the row.
      const row = await runRow(ACME, runId);
      expect(row?.status).toBe("completed");
      expect(row?.acceptedAt).toStrictEqual(NOW);
      await expect(findingRows(ACME, runId)).resolves.toHaveLength(1);
    });

    it("needs no idempotency key to do it", async () => {
      // ADR 0006: the key is "a convenience for network retry" and "must not"
      // be what enforces the invariant. Two submissions carrying **different**
      // keys still yield exactly one acceptance, because nothing reads them.
      const runId = await seedRun(ACME);

      const responses = await Promise.all([
        submit(runId, { idempotencyKey: "retry-0001" }),
        submit(runId, { idempotencyKey: "retry-0002" }),
      ]);

      expect(
        responses.filter(
          (response) => response.status === WORKER_RESULT_STATUS.accepted
        )
      ).toHaveLength(1);
    });
  });

  describe("the bucket key", () => {
    it("keys on path and normalized anchored source, and on nothing else", () => {
      // ADR 0007 excludes line numbers, because they move on any unrelated edit
      // above them, and severity, because the same defect rated `high` then
      // `medium` must not become a different Finding.
      const moved: Finding = {
        ...FINDING,
        severity: "low",
        location: { path: "src/session.ts", startLine: 512, endLine: 514 },
        anchoredText: "  if (token   ===\n stored) return true  ",
      };

      expect(bucketKeyOf(moved)).toBe(bucketKeyOf(FINDING));
    });

    it("separates two Findings that anchor at different source", () => {
      expect(
        bucketKeyOf({ ...FINDING, anchoredText: "return false" })
      ).not.toBe(bucketKeyOf(FINDING));
      expect(
        bucketKeyOf({
          ...FINDING,
          location: { ...FINDING.location, path: "src/other.ts" },
        })
      ).not.toBe(bucketKeyOf(FINDING));
    });
  });
});
