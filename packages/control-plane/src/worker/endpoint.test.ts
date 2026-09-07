/**
 * The claim endpoint's order, measured through doubles.
 *
 * Every status this endpoint can answer with is reachable here, and two
 * negatives are the point of the file: an unauthenticated request and an
 * incompatible one must never reach the claim port at all. A test that only
 * asserted their status codes would pass against a handler that claimed a Run
 * and then threw the grant away.
 */
import type { ClaimGrant } from "@reprove/protocol/v1";
import { protocolVersion } from "@reprove/protocol/v1";
import { describe, expect, it } from "vitest";

import type { WorkerIdentity } from "./authenticate.js";
import type { ClaimOutcome, WorkerClaimRequest } from "./claim-outcome.js";
import { WORKER_CLAIM_STATUS } from "./claim-outcome.js";
import { WORKER_PROTOCOL_SUPPORT } from "./compatibility.js";
import { createWorkerClaimHandler, MAXIMUM_CLAIM_BYTES } from "./endpoint.js";

const ACME = 1001;
const WORKER = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

const IDENTITY: WorkerIdentity = { ownerId: ACME, workerId: WORKER };

const GRANT: ClaimGrant = {
  runSpec: {
    runId: RUN,
    ownerId: String(ACME),
    repositoryId: "3001",
    installationId: "42",
    pullRequestNumber: 7,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    provenance: "internal",
    provenanceBasis: {
      ruleVersion: 1,
      baseRepositoryId: 3001,
      headRepositoryId: 3001,
      authorAssociation: "MEMBER",
      authorId: 5005,
      matchedSameRepository: true,
      matchedAssociation: true,
    },
    trigger: "automatic",
    placement: "self_hosted",
    allowHostedFallback: false,
    harness: "codex",
    model: "gpt-5.6-sol",
    strategy: "standard",
    autonomy: "verify",
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
    claimableUntil: "2026-02-01T12:05:00.000Z",
    createdAt: "2026-02-01T12:00:00.000Z",
  },
  executionToken: "an-execution-token",
  executionExpiresAt: "2026-02-01T12:10:00.000Z",
  protocolVersion,
};

/** A handler over recorded doubles, so what did *not* happen is readable. */
const handlerOver = (options: {
  readonly identity?: WorkerIdentity | null;
  readonly outcome?: ClaimOutcome;
  readonly authenticateThrows?: boolean;
  readonly claimThrows?: boolean;
}) => {
  const claims: WorkerClaimRequest[] = [];
  const handle = createWorkerClaimHandler({
    authenticate: (authorization) => {
      if (options.authenticateThrows) {
        return Promise.reject(new Error("the database is not reachable"));
      }
      const identity =
        options.identity === undefined ? IDENTITY : options.identity;
      return Promise.resolve(authorization === null ? null : identity);
    },
    claim: (request) => {
      claims.push(request);
      if (options.claimThrows) {
        return Promise.reject(new Error("rolled back"));
      }
      return Promise.resolve(
        options.outcome ?? { kind: "granted", grant: GRANT }
      );
    },
  });
  return { claims, handle };
};

/** A claim body, including the shapes a Worker should not be able to send. */
type ClaimBody = Readonly<Record<string, number | string>>;

const POLL = {
  protocolVersion,
  workerBuildVersion: "0.0.0",
} satisfies ClaimBody;
const TARGETED = { ...POLL, runId: RUN } satisfies ClaimBody;
const CREDENTIALLED = { authorization: `Bearer rpw1.${ACME}.a-secret` };

const claimRequest = (
  body: string,
  headers: Readonly<Record<string, string>>
): Request =>
  new Request("https://control.example/api/worker/runs/claim", {
    method: "POST",
    headers,
    body,
  });

/** A request from a Worker whose credential verifies. */
const sending = (body: ClaimBody): Request =>
  claimRequest(JSON.stringify(body), CREDENTIALLED);

/** A request whose body is whatever bytes the case needs it to be. */
const sendingRaw = (body: string): Request => claimRequest(body, CREDENTIALLED);

/** A request carrying no credential at all. */
const anonymous = (): Request => claimRequest(JSON.stringify(TARGETED), {});

describe("a granted claim", () => {
  it("returns the grant a Worker can execute from", async () => {
    const { claims, handle } = handlerOver({});

    const response = await handle(sending(TARGETED));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.granted);
    await expect(response.json()).resolves.toStrictEqual(GRANT);
    expect(claims).toStrictEqual([
      {
        ownerId: ACME,
        worker: {
          workerId: WORKER,
          protocolVersion,
          workerBuildVersion: "0.0.0",
        },
        runId: RUN,
      },
    ]);
  });

  it("polls with no Run named, and the port is told so", async () => {
    const { claims, handle } = handlerOver({});

    await handle(sending(POLL));

    expect(claims[0]?.runId).toBeUndefined();
  });

  it("answers an idle poll with no body at all", async () => {
    const { handle } = handlerOver({ outcome: { kind: "no_run_available" } });

    const response = await handle(sending(POLL));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.noRunAvailable);
    await expect(response.text()).resolves.toBe("");
  });
});

describe("a refused claim", () => {
  it.each([
    ["unknown_run", WORKER_CLAIM_STATUS.unknownRun],
    ["already_claimed", WORKER_CLAIM_STATUS.refused],
    ["claim_window_closed", WORKER_CLAIM_STATUS.refused],
    ["not_claimable", WORKER_CLAIM_STATUS.refused],
    ["placement_mismatch", WORKER_CLAIM_STATUS.refused],
    ["installation_unavailable", WORKER_CLAIM_STATUS.refused],
  ] as const)("names %s on a %d", async (reason, status) => {
    const { handle } = handlerOver({ outcome: { kind: "refused", reason } });

    const response = await handle(sending(TARGETED));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toStrictEqual({ status, reason });
  });
});

describe("what never reaches the claim", () => {
  it("refuses an unauthenticated request without opening a claim", async () => {
    const { claims, handle } = handlerOver({});

    const response = await handle(anonymous());

    expect(response.status).toBe(WORKER_CLAIM_STATUS.unauthenticated);
    await expect(response.json()).resolves.toStrictEqual({
      status: WORKER_CLAIM_STATUS.unauthenticated,
      reason: "no valid Worker credential",
    });
    expect(claims).toStrictEqual([]);
  });

  it("gives one answer for every way a credential can fail", async () => {
    // An unknown Owner, an unknown secret, a revoked credential and an expired
    // one all arrive here as `null`, so the endpoint has nothing to tell them
    // apart with and cannot be used to enumerate any of them.
    const { handle } = handlerOver({ identity: null });

    const response = await handle(sending(TARGETED));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.unauthenticated);
  });

  it("refuses a version this control plane does not serve, and claims nothing", async () => {
    const { claims, handle } = handlerOver({});

    const response = await handle(
      sending({
        ...TARGETED,
        protocolVersion: WORKER_PROTOCOL_SUPPORT.current + 1,
      })
    );

    expect(response.status).toBe(WORKER_CLAIM_STATUS.incompatible);
    await expect(response.json()).resolves.toStrictEqual({
      status: WORKER_CLAIM_STATUS.incompatible,
      reason: "unsupported_protocol_version",
      minimum: WORKER_PROTOCOL_SUPPORT.minimum,
      current: WORKER_PROTOCOL_SUPPORT.current,
    });
    expect(claims).toStrictEqual([]);
  });

  it("reads a version of zero as malformed rather than as an old Worker", async () => {
    // `upgrade_required` is unreachable from here while `minimum` is 1, because
    // there is no positive integer below it, and the protocol schema rejects a
    // non-positive one as not a version at all. That is a fact about a
    // one-family window rather than a gap: the branch itself is exercised in
    // `compatibility.test.ts`, and it becomes reachable the first time the
    // integer bumps and the window spans two families.
    const { claims, handle } = handlerOver({});

    const response = await handle(sending({ ...POLL, protocolVersion: 0 }));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.malformed);
    await expect(response.json()).resolves.toMatchObject({
      reason: expect.stringContaining("protocolVersion"),
    });
    expect(claims).toStrictEqual([]);
  });

  it("refuses a body over the cap before reading a header for meaning", async () => {
    const { claims, handle } = handlerOver({});

    const response = await handle(
      sending({
        ...POLL,
        workerBuildVersion: "x".repeat(MAXIMUM_CLAIM_BYTES),
      })
    );

    expect(response.status).toBe(WORKER_CLAIM_STATUS.oversized);
    expect(claims).toStrictEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", JSON.stringify(42)],
  ])("refuses a body that is %s", async (_label, body) => {
    const { claims, handle } = handlerOver({});

    const response = await handle(sendingRaw(body));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.malformed);
    expect(claims).toStrictEqual([]);
  });

  it.each([
    ["protocolVersion", { workerBuildVersion: "0.0.0" }],
    ["workerBuildVersion", { protocolVersion }],
    ["protocolVersion", { protocolVersion: "one", workerBuildVersion: "0" }],
    ["runId", { ...POLL, runId: "" }],
  ] as const)("names the %s field it could not read", async (field, body) => {
    const { claims, handle } = handlerOver({});

    const response = await handle(sending(body));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.malformed);
    await expect(response.json()).resolves.toMatchObject({
      reason: expect.stringContaining(field),
    });
    expect(claims).toStrictEqual([]);
  });
});

describe("what the endpoint says when it could not decide", () => {
  it("does not report a 401 for a database it could not reach", async () => {
    const { claims, handle } = handlerOver({ authenticateThrows: true });

    const response = await handle(sending(TARGETED));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.unavailable);
    expect(claims).toStrictEqual([]);
  });

  it("reports a failed claim as unavailable, not as a refusal", async () => {
    // The claim transaction rolled back, so no Run is held by an execution that
    // never received a grant. A `409` would tell the Worker something about the
    // Run, and nothing about the Run is what went wrong.
    const { handle } = handlerOver({ claimThrows: true });

    const response = await handle(sending(TARGETED));

    expect(response.status).toBe(WORKER_CLAIM_STATUS.unavailable);
  });
});
