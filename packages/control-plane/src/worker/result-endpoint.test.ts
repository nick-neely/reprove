/**
 * The result endpoint's order, measured through doubles.
 *
 * Every status this endpoint can answer with is reachable here, and the
 * negatives are the point of the file. #55 requires that "a Result failing
 * `@reprove/protocol` validation is rejected **before it can affect Run
 * state**", and a test that asserted only the status code would pass against a
 * handler that opened the acceptance transaction and then threw its answer
 * away. So the acceptance port is a double that records every call, and an
 * oversized, unauthenticated, incompatible or malformed request must leave it
 * empty.
 */
import type { Result } from "@reprove/protocol/v1";
import { protocolLimits, protocolVersion } from "@reprove/protocol/v1";
import { describe, expect, it } from "vitest";

import type { AcceptanceOutcome, SubmittedResult } from "./acceptance-outcome.js";
import { WORKER_RESULT_STATUS } from "./acceptance-outcome.js";
import type { WorkerIdentity } from "./authenticate.js";
import {
  createWorkerResultHandler,
  MAXIMUM_SUBMISSION_BYTES,
} from "./result-endpoint.js";

const ACME = 1001;
const WORKER = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const TOKEN = "an-execution-token-handed-back-by-the-claim";

const IDENTITY: WorkerIdentity = { ownerId: ACME, workerId: WORKER };

const RESULT: Result = {
  runId: RUN,
  completeness: "complete",
  stoppedBy: null,
  summary: "Reviewed the change and verified one finding.",
  disprovedHypothesisCount: 2,
  findings: [
    {
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
    },
  ],
  passes: [
    {
      passId: "pass_01",
      harness: "codex",
      pinnedModel: "gpt-5.6",
      resolvedModel: null,
      startedAt: "2026-09-03T12:01:00Z",
      endedAt: "2026-09-03T12:18:00Z",
      outcome: "completed",
      failureReason: null,
      repairTurnUsed: false,
      usage: { inputTokens: 180_000, outputTokens: 9400 },
    },
  ],
  usage: { inputTokens: 180_000, outputTokens: 9400 },
  protocolVersion,
  workerBuildVersion: "0.1.0",
};

interface HandlerOptions {
  readonly identity?: WorkerIdentity | null;
  readonly authenticateThrows?: boolean;
  readonly acceptThrows?: boolean;
  readonly outcome?: AcceptanceOutcome;
}

/** The handler over doubles, and the list of submissions that reached the port. */
const handlerOver = (options: HandlerOptions) => {
  const submissions: SubmittedResult[] = [];
  const handle = createWorkerResultHandler({
    authenticate: () => {
      if (options.authenticateThrows) {
        return Promise.reject(new Error("no connection"));
      }
      return Promise.resolve(
        options.identity === undefined ? IDENTITY : options.identity
      );
    },
    accept: (submission) => {
      submissions.push(submission);
      if (options.acceptThrows) {
        return Promise.reject(new Error("rolled back"));
      }
      return Promise.resolve(
        options.outcome ?? { kind: "accepted", runStatus: "completed" }
      );
    },
  });
  return { handle, submissions };
};

const CREDENTIALLED = { authorization: `Bearer rpw1.${ACME}.a-secret` };

const submissionRequest = (
  body: string,
  headers: Readonly<Record<string, string>>
): Request =>
  new Request(`https://control.example/api/worker/runs/${RUN}/result`, {
    method: "POST",
    headers,
    body,
  });

/** The envelope, including the shapes a Worker should not be able to send. */
type SubmissionBody = Readonly<Record<string, unknown>>;

const ENVELOPE = {
  protocolVersion,
  executionToken: TOKEN,
  result: RESULT,
} satisfies SubmissionBody;

/** A submission from a Worker whose credential verifies. */
const sending = (body: SubmissionBody): Request =>
  submissionRequest(JSON.stringify(body), CREDENTIALLED);

/** A submission whose body is whatever bytes the case needs it to be. */
const sendingRaw = (body: string): Request =>
  submissionRequest(body, CREDENTIALLED);

/** A submission carrying no credential at all. */
const anonymous = (): Request =>
  submissionRequest(JSON.stringify(ENVELOPE), {});

describe("an accepted Result", () => {
  it("answers 200 and names the terminal status it wrote", async () => {
    const { handle, submissions } = handlerOver({});

    const response = await handle(sending(ENVELOPE), RUN);

    expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
    await expect(response.json()).resolves.toStrictEqual({
      status: WORKER_RESULT_STATUS.accepted,
      runStatus: "completed",
    });
    expect(submissions).toStrictEqual([
      {
        ownerId: ACME,
        runId: RUN,
        executionToken: TOKEN,
        result: RESULT,
      },
    ]);
  });

  it("names `incomplete` for a partial Result, because the status is the outcome", async () => {
    const { handle } = handlerOver({
      outcome: { kind: "accepted", runStatus: "incomplete" },
    });

    const response = await handle(sending(ENVELOPE), RUN);

    await expect(response.json()).resolves.toMatchObject({
      runStatus: "incomplete",
    });
  });

  it("takes the Run from the path rather than from the payload", async () => {
    // The path is the request's own subject and the body is the Worker's
    // account of itself. They must agree, and where they do it is the path the
    // acceptance transaction is told about.
    const { handle, submissions } = handlerOver({});

    await handle(sending(ENVELOPE), RUN);

    expect(submissions[0]?.runId).toBe(RUN);
  });

  it("carries an idempotency key that changes nothing", async () => {
    // ADR 0006: the key is "a convenience for network retry" and "must not" be
    // what enforces at most one accepted terminal Result. It is parsed, bounded
    // and then not passed on, because nothing downstream may read it.
    const { handle, submissions } = handlerOver({});

    const response = await handle(
      sending({ ...ENVELOPE, idempotencyKey: "retry-0001" }),
      RUN
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.accepted);
    expect(submissions[0]).not.toHaveProperty("idempotencyKey");
  });
});

describe("a rejected Result", () => {
  it.each([
    ["unknown_run", WORKER_RESULT_STATUS.unknownRun],
    ["execution_mismatch", WORKER_RESULT_STATUS.rejected],
    ["not_eligible", WORKER_RESULT_STATUS.rejected],
  ] as const)("answers %s by name", async (reason, status) => {
    const { handle } = handlerOver({ outcome: { kind: "rejected", reason } });

    const response = await handle(sending(ENVELOPE), RUN);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toStrictEqual({ status, reason });
  });

  it("reports a payload the Run's Autonomy forbids as malformed", async () => {
    // ADR 0007 rejects a Patch at acceptance under any Autonomy but `fix`. It
    // is a statement about the payload measured against the Run's immutable
    // spec, so it is a `422` rather than a seventh rejection name: ADR 0016
    // fixes the rejection set, and the endpoint does not get to extend it.
    const { handle } = handlerOver({
      outcome: {
        kind: "malformed",
        reason: "findings.0.patch is not accepted under autonomy=verify",
      },
    });

    const response = await handle(sending(ENVELOPE), RUN);

    expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
    await expect(response.json()).resolves.toMatchObject({
      reason: expect.stringContaining("autonomy=verify"),
    });
  });
});

describe("what never reaches Acceptance", () => {
  it("refuses an unauthenticated submission without opening a transaction", async () => {
    const { handle, submissions } = handlerOver({ identity: null });

    const response = await handle(anonymous(), RUN);

    expect(response.status).toBe(WORKER_RESULT_STATUS.unauthenticated);
    expect(submissions).toStrictEqual([]);
  });

  it("gives one answer for every way a credential can fail", async () => {
    const { handle } = handlerOver({ identity: null });

    const response = await handle(sending(ENVELOPE), RUN);

    await expect(response.json()).resolves.toStrictEqual({
      status: WORKER_RESULT_STATUS.unauthenticated,
      reason: "no valid Worker credential",
    });
  });

  it("refuses a body over the cap before reading a header for meaning", async () => {
    const { handle, submissions } = handlerOver({});

    const response = await handle(
      sending({
        ...ENVELOPE,
        result: {
          ...RESULT,
          summary: "x".repeat(MAXIMUM_SUBMISSION_BYTES),
        },
      }),
      RUN
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.oversized);
    expect(submissions).toStrictEqual([]);
  });

  it("caps the envelope above the Result bound rather than at it", async () => {
    // ADR 0006 bounds the Result. The envelope around it carries a token, an
    // optional key and a version, so capping the whole body at the Result's
    // own figure would refuse a Result that is exactly within its bound.
    expect(MAXIMUM_SUBMISSION_BYTES).toBeGreaterThan(protocolLimits.resultBytes);
  });

  it("refuses a version this control plane does not serve, and accepts nothing", async () => {
    const { handle, submissions } = handlerOver({});

    const response = await handle(
      sending({ ...ENVELOPE, protocolVersion: protocolVersion + 1 }),
      RUN
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.incompatible);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unsupported_protocol_version",
      minimum: protocolVersion,
      current: protocolVersion,
    });
    expect(submissions).toStrictEqual([]);
  });

  it("checks the window before the Result, and says so rather than malformed", async () => {
    // `resultSchema.protocolVersion` is a literal, so a Worker outside the
    // window carries a Result this schema cannot read either. Parsing the
    // Result first would report that Worker as malformed and lose ADR 0006's
    // one actionable instruction. The envelope's plain integer is read first,
    // which this case measures by making the Result fail on its own account.
    const { handle, submissions } = handlerOver({});

    const response = await handle(
      sending({
        ...ENVELOPE,
        protocolVersion: protocolVersion + 1,
        result: { ...RESULT, protocolVersion: protocolVersion + 1, summary: "" },
      }),
      RUN
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.incompatible);
    expect(submissions).toStrictEqual([]);
  });

  it("reads a version of zero as malformed rather than as an old Worker", async () => {
    // Zero is not a version any Worker ever advertised, so it is a broken
    // request rather than one this control plane has stopped serving. There is
    // no upgrade to name for it.
    const { handle, submissions } = handlerOver({});

    const response = await handle(
      sending({ ...ENVELOPE, protocolVersion: 0 }),
      RUN
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
    await expect(response.json()).resolves.toMatchObject({
      reason: expect.stringContaining("protocolVersion"),
    });
    expect(submissions).toStrictEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", JSON.stringify(42)],
  ])("refuses a body that is %s", async (_label, body) => {
    const { handle, submissions } = handlerOver({});

    const response = await handle(sendingRaw(body), RUN);

    expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
    expect(submissions).toStrictEqual([]);
  });

  it.each([
    ["executionToken", { protocolVersion, result: RESULT }],
    ["protocolVersion", { executionToken: TOKEN, result: RESULT }],
    ["executionToken", { ...ENVELOPE, executionToken: "" }],
    ["idempotencyKey", { ...ENVELOPE, idempotencyKey: "k".repeat(129) }],
  ] as const)(
    "names the envelope's %s field when it could not read it",
    async (field, body) => {
      const { handle, submissions } = handlerOver({});

      const response = await handle(sending(body), RUN);

      expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
      await expect(response.json()).resolves.toMatchObject({
        reason: expect.stringContaining(field),
      });
      expect(submissions).toStrictEqual([]);
    }
  );

  it.each([
    [
      "stoppedBy",
      { ...RESULT, completeness: "partial" as const, stoppedBy: null },
    ],
    ["summary", { ...RESULT, summary: "" }],
    [
      "evidence",
      {
        ...RESULT,
        findings: RESULT.findings.map((finding) => ({
          ...finding,
          verification: "verified" as const,
          evidence: [],
        })),
      },
    ],
  ] as const)(
    "names the Result's %s field, and accepts nothing",
    async (field, result) => {
      // The control plane validates every submission against the same
      // authoritative schema the Worker emits with, because a hostile Worker
      // can skip its own code and POST arbitrary bytes (ADR 0010).
      const { handle, submissions } = handlerOver({});

      const response = await handle(sending({ ...ENVELOPE, result }), RUN);

      expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
      await expect(response.json()).resolves.toMatchObject({
        reason: expect.stringContaining(field),
      });
      expect(submissions).toStrictEqual([]);
    }
  );

  it("refuses a Result naming a Run other than the one it was posted to", async () => {
    const { handle, submissions } = handlerOver({});

    const response = await handle(
      sending({
        ...ENVELOPE,
        result: { ...RESULT, runId: "33333333-3333-4333-8333-333333333333" },
      }),
      RUN
    );

    expect(response.status).toBe(WORKER_RESULT_STATUS.malformed);
    await expect(response.json()).resolves.toMatchObject({
      reason: expect.stringContaining("runId"),
    });
    expect(submissions).toStrictEqual([]);
  });
});

describe("what the endpoint says when it could not decide", () => {
  it("does not report a 401 for a database it could not reach", async () => {
    const { handle, submissions } = handlerOver({ authenticateThrows: true });

    const response = await handle(sending(ENVELOPE), RUN);

    expect(response.status).toBe(WORKER_RESULT_STATUS.unavailable);
    expect(submissions).toStrictEqual([]);
  });

  it("reports a failed acceptance as unavailable, not as a rejection", async () => {
    // The transaction rolled back, so the Run is exactly as it was and the
    // Result was neither accepted nor rejected. A `409` would tell the Worker
    // something about the Run, and nothing about the Run is what went wrong -
    // and a Worker that read it as terminal would discard a Result it could
    // still resubmit.
    const { handle } = handlerOver({ acceptThrows: true });

    const response = await handle(sending(ENVELOPE), RUN);

    expect(response.status).toBe(WORKER_RESULT_STATUS.unavailable);
  });
});
