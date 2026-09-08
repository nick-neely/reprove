/**
 * The Phase 0 exit, walked end to end against a clean build.
 *
 * This is the **payload** of the real-builder gate
 * ([ADR 0014](../docs/adr/0014-workflow-orchestration-seam.md)) rather than a
 * second gate beside it, which is
 * [ADR 0016](../docs/adr/0016-phase-0-acceptance-scenario.md)'s decision: "the
 * Phase 0 exit is one fact and gets one signal". It runs after that gate's own
 * artifact checks, reports through the same `ok`/`FAIL` pair, and contributes
 * to the same exit code.
 *
 * ```text
 * signed delivery -> Run creation -> lifecycle scheduling -> claim
 * ```
 *
 * That is the spine. One linear walk cannot be the whole answer, because
 * accepting a Result **terminalizes the Run it was accepted into** and every
 * rejection needs a Run that has not yet terminalized, so nine further cases
 * fork off it - through the same seam, against the same database, in one
 * harness. Ten walkthroughs, which is the ADR's own count:
 *
 * ```text
 * W0  the spine            a signed delivery becomes a queued Run whose
 *                          lifecycle is recorded and running, and the App JWT,
 *                          the installation token and the canonical fetch are
 *                          asserted as the built application really sent them
 * F1  webhook refusals     a tampered body, a signature valid over other bytes,
 *                          no signature at all, 25 MiB + 1, and a signed body
 *                          no envelope can be built from
 * F2  claim, hosted        the spine's hosted Run, claimed by a self-hosted
 *                          Worker, which is the placement it is not
 * F3  claim, self-hosted   a grant validated against `claimGrantSchema`, then
 *                          the same Run claimed twice
 * F4  Result rejections    every reachable one, each asserting the status and
 *                          the named reason
 * F5  execution_mismatch   a well-formed token that is not the Run's current one
 * F6  Acceptance           the eligible Result, read back under `withOwner()`,
 *                          with the ingress ledger beside it
 * F7  not_eligible         the same Result again, to the Run it terminalized
 * F8  exactly-once         two submissions in flight at once, on two sockets
 * F9  liveness             a Run left `claimed` with a null pass id, ended by
 *                          the deadline alone - both placements, side by side
 * ```
 *
 * F1 is one walkthrough rather than two because the ADR's sketch counts nine
 * forks and the webhook's refusals are one decision reached with several
 * inputs; the `duplicate_head` no-op rides with F6 because it is a fact about
 * the ledger row F6 already reads. The count is the ADR's; the grouping is this
 * file's, and it is stated here rather than the shape being contorted to match.
 *
 * **What is substituted, and what is not.** Only GitHub's own API, and only at
 * the transport. Signature verification is Reprove's own code running on the
 * exact bytes; the App JWT is signed with a key generated for this run and
 * verified against its public half; the installation-token exchange is issued
 * and the token it issued is asserted on the next request. Everything else -
 * the delivery, Run creation, the advisory-lock critical section, the
 * lifecycle, the claim, Acceptance, the watchdog - is the built application,
 * over real HTTP, against real Postgres behind real PgBouncer.
 *
 * **Three arrangements are made with `psql` as the superuser**, and each stands
 * in for something ADR 0016 asserts absent from Phase 0 rather than working
 * around something that exists. They are marked where they happen.
 *
 * **The ingress re-drive is cited, not re-proven.** ADR 0013 made automatic
 * re-drive of `contended` and `transient` dispositions a Phase 0 exit condition
 * and ADR 0014 discharged it as Workflow's own step retry, which
 * [#38](https://github.com/nick-neely/reprove/issues/38)'s scenarios already
 * exercise and `packages/control-plane-workflow/src/spine.test.ts` pins inside
 * this same required check. Re-proving it here would widen the scenario past
 * the acceptance seam it exists to prove.
 */
import { createHash, randomUUID } from "node:crypto";
import { Agent as HttpAgent, request as httpRequest } from "node:http";

import {
  createControlPlane,
  mintWorkerCredential,
  PHASE_0_RUN_PROFILE,
} from "@reprove/control-plane";
import { claimGrantSchema } from "@reprove/protocol/v1";

import {
  APP_ID,
  appKeyPair,
  bearerToken,
  DATABASE,
  decodeJws,
  DELIVERY_TIMEOUT_MS,
  INSTALLATION_ID,
  INSTALLATION_TOKEN,
  OWNER_ID,
  psql,
  PULL_REQUEST,
  REPOSITORY_FULL_NAME,
  runtimeUrl,
  signatureOver,
  signedDelivery,
  startBuiltApp,
  startCannedGitHub,
  until,
  untilServing,
  verifiesUnder,
  WEBHOOK_SECRET,
} from "./gate-fixtures.mjs";

// --- what the walkthroughs agree on ------------------------------------------

/**
 * The two Run windows, as this scenario names them.
 *
 * ADR 0016 runs "the **real** lifecycle loop, the **real** durable sleep and
 * the **real** conditional UPDATE, with only the two durations moved", and
 * these are the two durations:
 *
 * - `claimableFor` bounds how long the scenario has between a delivery and the
 *   claim that answers it. Run creation takes a per-pull-request advisory lock
 *   and fetches canonical state first, so a window of a few seconds would race
 *   the scenario's own setup rather than test anything.
 * - `livenessFor` is the window under observation, and it is short.
 *
 * **The watchdog fires no earlier than `claimableUntil`, and that is the
 * mechanism rather than a shortcoming of it.** A lifecycle sleeps toward the
 * deadline it read and re-reads only on wake; a Run that was `queued` when it
 * slept is asleep toward its claim window, and nothing notifies it when a claim
 * lands. So it wakes at `claimableUntil`, re-reads, finds a `claimed` Run whose
 * execution deadline has already passed, and closes **that** window - which is
 * the transition under test. The scenario therefore claims its silent Runs
 * first, walks everything else while the clock runs, and polls at the end.
 */
const CLAIMABLE_FOR_MS = 45_000;
const LIVENESS_FOR_MS = 8000;

/** How long the liveness wait may take, with room for the World's queue. */
const TERMINAL_TIMEOUT_MS = 150_000;
/** How long one Run may take to appear after its delivery was acknowledged. */
const RUN_TIMEOUT_MS = 90_000;
/** How long the ingress takes to settle a delivery that creates no Run. */
const LEDGER_TIMEOUT_MS = 30_000;

/**
 * A pull request per walkthrough that needs a live Run of its own, because
 * `run_one_live_per_pull_request` refuses two.
 */
const PULLS = {
  spine: PULL_REQUEST,
  accepted: 11,
  concurrent: 12,
  silent: 13,
};

/** Every pull request the scenario drives, which is the GitHub allowlist. */
const DRIVEN_PULLS = Object.values(PULLS);

/** The delivery GUIDs, so the ledger can be read back by the one that wrote it. */
const GUIDS = {
  spine: "gate-spine",
  duplicate: "gate-spine-again",
  accepted: "gate-accepted",
  concurrent: "gate-concurrent",
  silent: "gate-silent",
  refused: "gate-refused",
  oversized: "gate-oversized",
  unusable: "gate-unusable",
};

/** What the fixture Worker advertises. A build string, carrying no entropy. */
const WORKER_BUILD_VERSION = "gate-worker-0.0.0";

/** The Result's own prose, which is the scenario's and not a Reviewer's. */
const GATE_SUMMARY =
  "The build gate submitted this Result. No review was performed.";

/** A well-formed Run id nobody holds, for the `unknown_run` walkthroughs. */
const NOBODY = "11111111-1111-4111-8111-111111111111";

/** An Owner nobody in this database is, for the cross-tenant read. */
const STRANGER = 9009;

/** What the canonical fetch is made of, as the client spells the two requests. */
const EXCHANGE_PATH = `/app/installations/${INSTALLATION_ID}/access_tokens`;

/**
 * `GET /repos/{owner}/{repo}/pulls/{number}`, as the client spells it.
 *
 * @param {number} pullRequestNumber The pull request.
 * @returns {string} The request target.
 */
const canonicalPath = (pullRequestNumber) =>
  `/repos/${REPOSITORY_FULL_NAME}/pulls/${pullRequestNumber}`;

/** The two headers `createGitHubClient` puts on every request it sends. */
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";

/**
 * The three caps the refusals name.
 *
 * They are restated here rather than imported because each one is asserted
 * **through the refusal's own text**: a cap that moved would fail the
 * assertion that reads the number back out of the answer, which is the check
 * worth having. Importing the constant would make the two agree by
 * construction and prove nothing.
 */
const MAXIMUM_DELIVERY_BYTES = 25 * 1024 * 1024;
const RESULT_BYTES = 256 * 1024;
const SUBMISSION_BYTES = RESULT_BYTES + 8 * 1024;

// --- pure helpers, measured in phase0-exit.test.ts ----------------------------

/**
 * The digest a Run stores for the token a claim minted.
 *
 * Spelled here rather than imported, deliberately. The plaintext leaves the
 * control plane exactly once - in the claim grant - and `sha256:<hex>` over it
 * is the convention every credential in this schema takes, so what is respelled
 * is one line of a documented storage format rather than a decision. Exporting
 * a hash over a caller-supplied string is the same objection `credential.ts`
 * makes against publishing `hashWorkerSecret`.
 *
 * @param {string} executionToken The token a claim handed back.
 * @returns {string} What `run.execution_token_hash` holds for it.
 */
export const executionTokenDigest = (executionToken) =>
  `sha256:${createHash("sha256").update(executionToken, "utf-8").digest("hex")}`;

/**
 * The same bytes with one of them changed.
 *
 * The result need not be JSON and usually is not, which is the point:
 * `signature.ts` documents that the **bytes** are the signature's subject
 * rather than the parse, so a delivery whose body changed after signing has to
 * be refused before anything tries to read it.
 *
 * @param {Buffer} body The signed bytes.
 * @returns {Buffer} A copy differing in exactly one byte.
 */
export const tamperedBody = (body) => {
  const tampered = Buffer.from(body);
  const at = Math.floor(tampered.length / 2);
  // SAFETY: every body this is used on is a JSON object of several hundred
  // bytes; an empty one would have no byte to change and is not a delivery.
  // Arithmetic rather than a bit flip only because the house lint forbids the
  // operator; what matters is that exactly one byte differs.
  tampered[at] = (tampered[at] + 1) % 256;
  return tampered;
};

/**
 * One `passRecord`, which a Result must carry at least one of.
 *
 * `resultPayloadSchema.passes` is `.min(1)`, and the in-process helpers that
 * submit `passes: []` only get away with it because `ControlPlane.acceptResult`
 * does not validate. Over HTTP the schema runs, so this is the difference
 * between a walkthrough and a `422`.
 */
const PASS_RECORD = {
  passId: "pass_gate_01",
  harness: "codex",
  pinnedModel: "gpt-5",
  resolvedModel: null,
  startedAt: "2026-02-01T12:01:00Z",
  endedAt: "2026-02-01T12:02:00Z",
  outcome: "completed",
  failureReason: null,
  repairTurnUsed: false,
  usage: { inputTokens: 0, outputTokens: 0 },
};

/**
 * One Finding, carrying `verification: "static"` so it needs no Evidence.
 *
 * It exists so the absence battery has a row to be about: a `finding` table
 * with no rows would satisfy "no Reconciliation, no Threshold, no Ignore"
 * vacuously, and the assertion worth making is that a Finding really was
 * persisted and really carries none of them.
 */
const FINDING = {
  title: "The gate submitted this Finding",
  body: "It exists so that the absence assertions have a Finding to be absent from.",
  severity: "low",
  verification: "static",
  location: { path: "tools/phase0-exit.mjs", startLine: 1, endLine: 1 },
  anchoredText: "",
  evidence: [],
};

/**
 * A complete, eligible Result for one Run.
 *
 * @param {string} runId The Run it names.
 * @param {Readonly<Record<string, unknown>>} [overrides] What one walkthrough
 *   changes to make it unacceptable.
 * @returns {Record<string, unknown>} The Result payload.
 */
export const resultFor = (runId, overrides = {}) => ({
  runId,
  completeness: "complete",
  stoppedBy: null,
  summary: GATE_SUMMARY,
  disprovedHypothesisCount: 0,
  findings: [FINDING],
  passes: [PASS_RECORD],
  usage: { inputTokens: 0, outputTokens: 0 },
  protocolVersion: 1,
  workerBuildVersion: WORKER_BUILD_VERSION,
  ...overrides,
});

/**
 * One submission envelope around a Result.
 *
 * @param {string} runId The Run it names.
 * @param {string} executionToken The token the claim handed back.
 * @param {Readonly<Record<string, unknown>>} [overrides] What one walkthrough
 *   changes.
 * @returns {Record<string, unknown>} The body to POST.
 */
export const submissionFor = (runId, executionToken, overrides = {}) => ({
  protocolVersion: 1,
  executionToken,
  result: resultFor(runId),
  ...overrides,
});

/**
 * Which requests the built application sent GitHub that it was not supposed to.
 *
 * This is the absence battery's strongest assertion and its cheapest: the
 * canned server is the oracle, so "no Check run was published, no Review, no
 * Comment" is not a claim about what the code does not call - it is the request
 * list being **exactly** the installation-token exchange plus one canonical
 * fetch per pull request the scenario drove.
 *
 * @param {import("./gate-fixtures.mjs").CannedRequest[]} seen Every request the
 *   canned GitHub received.
 * @param {readonly number[]} pullRequests The pull requests the scenario drove.
 * @returns {string[]} Every request line outside the allowlist, deduplicated
 *   and sorted.
 */
export const unexpectedRequests = (seen, pullRequests) => {
  const allowed = new Set([
    `POST ${EXCHANGE_PATH}`,
    ...pullRequests.map((number) => `GET ${canonicalPath(number)}`),
  ]);
  return [...new Set(seen.map((request) => `${request.method} ${request.url}`))]
    .filter((line) => !allowed.has(line))
    .toSorted();
};

/**
 * What is wrong with the App JWT one request carried, if anything.
 *
 * Four separate facts rather than one, because a gate that reported "the App
 * JWT is wrong" would be as useful as the `401` GitHub answers: the assertion
 * exists, it is a JWS, it claims what this App is supposed to claim, and the
 * bytes were signed by this App's key. Only the last of those needs the key,
 * and only it distinguishes a real signature from a well-formed placeholder.
 *
 * @param {import("./gate-fixtures.mjs").CannedRequest} request The recorded
 *   installation-token exchange.
 * @param {string} publicKey The public half of the key the app was started with.
 * @returns {string | null} What it did wrong, as a sentence that follows the
 *   request's name, or `null` when it is exactly right.
 */
export const appJwtFault = (request, publicKey) => {
  const assertion = bearerToken(request);
  if (assertion === null) {
    return "carried no bearer credential";
  }
  const decoded = decodeJws(assertion);
  if (decoded === null) {
    return "carried a bearer credential that is not a compact JWS";
  }
  if (!(decoded.header.alg === "RS256" && decoded.header.typ === "JWT")) {
    return `carried the JOSE header ${JSON.stringify(decoded.header)} rather than an RS256 JWT`;
  }
  if (decoded.payload.iss !== APP_ID) {
    return `claimed iss ${JSON.stringify(decoded.payload.iss)} rather than the App id ${APP_ID}`;
  }
  if (!verifiesUnder(assertion, publicKey)) {
    return "carried a JWS that does not verify under the App's own key";
  }
  return null;
};

/**
 * Whether one request carries the two headers the client puts on every request.
 *
 * @param {import("./gate-fixtures.mjs").CannedRequest} request A recorded request.
 * @returns {string | null} What is missing, or `null`.
 */
export const restHeaderFault = (request) => {
  const wrong = [
    ["accept", GITHUB_ACCEPT],
    ["x-github-api-version", GITHUB_API_VERSION],
  ].filter(([header, expected]) => request.headers[header] !== expected);
  return wrong.length === 0
    ? null
    : `did not carry ${wrong.map(([header, expected]) => `${header}: ${expected}`).join(" or ")}`;
};

// --- reading the database the gate owns --------------------------------------

/*
 * The awaits below are sequential on purpose, several of them inside loops.
 * Each walkthrough reads what the last one wrote - a Run has to exist before it
 * can be claimed, and be claimed before a Result can be rejected against it -
 * so a `Promise.all` would race the scenario against itself. The one place two
 * requests really are concurrent is F8, where it is the whole point.
 */
/* oxlint-disable no-await-in-loop */

/** One row, or `null` where the statement matched none. */
const oneRow = (statement, values) =>
  psql(DATABASE, statement, values)[0] ?? null;

/**
 * Waits for one pull request's delivery to become a queued Run with a recorded
 * lifecycle, which is what says the ingress workflow executed for real: it took
 * the lock, fetched canonical state, created the Run, started the lifecycle and
 * won the race to record it.
 *
 * @param {number} pullRequestNumber Which pull request's Run.
 * @returns {Promise<{id: string, workflowRunId: string}>} The Run.
 * @throws {Error} When it never appeared, or reached a status that is not
 *   claimable.
 */
const untilRunQueued = async (pullRequestNumber) =>
  await until(
    () => {
      const row = oneRow(
        `select id, status, coalesce(workflow_run_id, '')
           from run where pull_request_number = :'pull'`,
        { pull: String(pullRequestNumber) }
      );
      if (!row) {
        return null;
      }
      if (row[1] !== "queued") {
        throw new Error(
          `the Run for pull request ${pullRequestNumber} reached ${row[1]} rather than staying claimable`
        );
      }
      return row[2] === "" ? null : { id: row[0], workflowRunId: row[2] };
    },
    {
      describe: `no queued Run with a recorded lifecycle appeared for pull request ${pullRequestNumber}`,
      timeoutMs: RUN_TIMEOUT_MS,
    }
  );

/**
 * Waits for one delivery's ledger row to leave `received`, which is where the
 * ingress workflow puts it and where a delivery nothing processed would stay.
 *
 * @param {string} deliveryGuid The delivery.
 * @returns {Promise<{state: string, disposition: string}>} How it settled.
 */
const untilLedgerSettled = async (deliveryGuid) =>
  await until(
    () => {
      const row = oneRow(
        `select state, coalesce(disposition, '')
           from ingress_delivery where delivery_guid = :'guid'`,
        { guid: deliveryGuid }
      );
      return row && row[0] !== "received"
        ? { disposition: row[1], state: row[0] }
        : null;
    },
    {
      describe: `the ledger row for ${deliveryGuid} never left received`,
      timeoutMs: LEDGER_TIMEOUT_MS,
    }
  );

/** What a Run may end as (ADR 0007), which is what the liveness wait is for. */
const TERMINAL_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "superseded",
  "cancelled",
  "unscheduled",
]);

/**
 * The execution deadline one Run carries, as text, so that "it never moved"
 * is a comparison between two reads rather than between a read and a guess.
 *
 * @param {string} runId The Run.
 * @returns {string} The deadline, or the empty string where it carries none.
 */
const executionDeadlineOf = (runId) =>
  oneRow(
    `select coalesce(to_char(execution_expires_at at time zone 'UTC',
                             'YYYY-MM-DD HH24:MI:SS.MS'), '')
       from run where id = :'runId'`,
    { runId }
  )?.[0] ?? "";

/**
 * Waits for one Run to reach a terminal status, and reads back everything the
 * liveness walkthrough asserts about it in one statement.
 *
 * @param {string} runId The Run.
 * @returns {Promise<string[]>} The row.
 */
const untilRunTerminal = async (runId) =>
  await until(
    () => {
      const row = oneRow(
        `select status,
                coalesce(failure_reason, ''),
                coalesce(failure_detail ->> 'detector', ''),
                coalesce(failure_detail ->> 'observation', ''),
                coalesce(failure_detail ->> 'lostFrom', ''),
                coalesce(hosted_workflow_run_id, ''),
                coalesce(workflow_run_id, ''),
                coalesce(worker_id::text, '')
           from run where id = :'runId'`,
        { runId }
      );
      return row && TERMINAL_STATUSES.has(row[0]) ? row : null;
    },
    {
      describe: `the Run ${runId} was never terminalized by liveness`,
      timeoutMs: TERMINAL_TIMEOUT_MS,
    }
  );

/**
 * One POST on a connection of its own.
 *
 * `fetch` is used everywhere else in this file; the exactly-once walkthrough is
 * the one place it will not do. Undici keeps a connection pool per origin, so
 * two `fetch` calls under `Promise.all` may be pipelined onto one socket and
 * arrive in order - and a scenario that proved "one 200, one 409" against two
 * requests the client serialized would have proved the sequential case ADR 0016
 * says is "a much weaker claim". An agent per request is what makes the two
 * genuinely simultaneous.
 *
 * @param {string} origin Where the built application serves.
 * @param {string} path The route.
 * @param {Readonly<Record<string, string>>} headers The request headers.
 * @param {string} body The request body.
 * @returns {Promise<{status: number, body: unknown}>} The answer.
 */
const onItsOwnConnection = (origin, path, headers, body) =>
  // `node:http` predates promises and exposes no promise-returning form, so
  // this is the adapter, and it is the only one in the file.
  // oxlint-disable-next-line promise/avoid-new
  new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    const request = httpRequest(
      {
        agent: new HttpAgent({ keepAlive: false, maxSockets: 1 }),
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
        hostname: target.hostname,
        method: "POST",
        path: target.pathname,
        port: target.port,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf-8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // Reported by the assertion that reads the reason out of it.
          }
          resolve({ body: parsed, status: response.statusCode ?? 0 });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });

// --- the walkthroughs --------------------------------------------------------

/**
 * W0, and the request-shape half of it.
 *
 * The canned server is the oracle rather than a stub's call log: what it
 * recorded is what the built application really put on the wire, so this is
 * where "only GitHub's own API is substituted, and only at the transport" stops
 * being a claim about the composition and becomes a claim about the bytes.
 *
 * @param {object} c The scenario's context.
 * @returns {void}
 */
const checkGitHubRequests = (c) => {
  const lines = c.github.seen.map(
    (request) => `${request.method} ${request.url}`
  );
  const exchange = c.github.seen.find(
    (request) => request.method === "POST" && request.url === EXCHANGE_PATH
  );
  const canonical = c.github.seen.find(
    (request) =>
      request.method === "GET" && request.url === canonicalPath(PULLS.spine)
  );

  if (exchange) {
    const fault = appJwtFault(exchange, c.appKey.publicKey);
    if (fault === null) {
      c.ok(
        `W0 POST ${EXCHANGE_PATH} carried an RS256 App JWT issued by App ${APP_ID} and signed by the App's key`
      );
    } else {
      c.bad(`W0 POST ${EXCHANGE_PATH} ${fault}`);
    }
  } else {
    c.bad(
      `W0 the built application never exchanged an App JWT at ${EXCHANGE_PATH}; it sent ${JSON.stringify(lines)}`
    );
  }

  if (canonical) {
    // The exact token the canned server issued, rather than merely some
    // credential: the App JWT authorizes the exchange and nothing else, so a
    // request under it here would mean the installation grant was never used.
    c.is(
      `W0 GET ${canonicalPath(PULLS.spine)} carried the installation token the exchange issued`,
      bearerToken(canonical),
      INSTALLATION_TOKEN
    );
  } else {
    c.bad(
      `W0 the built application never fetched canonical state at ${canonicalPath(PULLS.spine)}; it sent ${JSON.stringify(lines)}`
    );
  }

  const present = [exchange, canonical].filter(
    (request) => request !== undefined
  );
  const faults = present
    .map((request) => ({ fault: restHeaderFault(request), request }))
    .filter((seen) => seen.fault !== null);
  for (const { fault, request } of faults) {
    c.bad(`W0 ${request.method} ${request.url} ${fault}`);
  }
  if (present.length === 2 && faults.length === 0) {
    c.ok(
      `W0 both GitHub requests carried accept: ${GITHUB_ACCEPT} and x-github-api-version: ${GITHUB_API_VERSION}`
    );
  }
};

/**
 * W0: a signed delivery becomes a queued Run whose lifecycle is running.
 *
 * @param {object} c The scenario's context.
 * @returns {Promise<{id: string, workflowRunId: string}>} The spine's Run.
 */
const walkSpine = async (c) => {
  const delivery = signedDelivery({
    deliveryGuid: GUIDS.spine,
    pullRequestNumber: PULLS.spine,
  });
  const acknowledged = await c.send("/api/github/webhook", {
    body: delivery.body,
    headers: delivery.headers,
  });
  c.is("W0 a signed delivery is acknowledged", acknowledged.status, 200);
  c.is(
    "W0 the acknowledgement names the delivery it recorded",
    acknowledged.body?.reason,
    `delivery ${GUIDS.spine} recorded`
  );

  const run = await untilRunQueued(PULLS.spine);
  c.ok(
    `W0 the delivery became a queued Run recording lifecycle ${run.workflowRunId}`
  );

  const settled = await untilLedgerSettled(GUIDS.spine);
  c.is("W0 the ingress ledger row settled done", settled.state, "done");
  c.is(
    "W0 the ingress ledger row carries no disposition",
    settled.disposition,
    ""
  );

  // `workflow.workflow_runs` names its primary key `id`; the World's own schema
  // reserves `run_id` for the tables that point at a run.
  const lifecycle = oneRow(
    "select status from workflow.workflow_runs where id = :'id'",
    { id: run.workflowRunId }
  );
  c.is(
    "W0 the lifecycle is a running durable run in the World, asleep toward the deadline",
    lifecycle?.[0],
    "running"
  );

  checkGitHubRequests(c);
  return run;
};

/**
 * F1: every way the webhook says no.
 *
 * @param {object} c The scenario's context.
 * @returns {Promise<void>} When all five have been asserted.
 */
const walkWebhookRefusals = async (c) => {
  const unsigned = "no valid x-hub-signature-256 over these exact bytes";
  const delivery = signedDelivery({
    deliveryGuid: GUIDS.refused,
    pullRequestNumber: 900,
  });

  c.refuses(
    "F1 a delivery whose bytes changed after signing",
    await c.send("/api/github/webhook", {
      body: tamperedBody(delivery.body),
      headers: delivery.headers,
    }),
    401,
    unsigned
  );

  // The same refusal from the other side: a signature that is perfectly valid,
  // over bytes that are not the ones on the wire.
  const other = signedDelivery({
    deliveryGuid: GUIDS.refused,
    pullRequestNumber: 901,
  });
  c.refuses(
    "F1 a signature valid over different bytes than were sent",
    await c.send("/api/github/webhook", {
      body: delivery.body,
      headers: {
        ...delivery.headers,
        "x-hub-signature-256": other.headers["x-hub-signature-256"],
      },
    }),
    401,
    unsigned
  );

  const bare = Object.fromEntries(
    Object.entries(delivery.headers).filter(
      ([header]) => header !== "x-hub-signature-256"
    )
  );
  c.refuses(
    "F1 a delivery carrying no signature at all",
    await c.send("/api/github/webhook", { body: delivery.body, headers: bare }),
    401,
    unsigned
  );

  // 25 MiB + 1, unsigned. `readBoundedBody` short-circuits on `content-length`,
  // so the cap is proved against the real figure rather than a test-only one,
  // and the body is never hashed or accumulated.
  c.refuses(
    "F1 a delivery one byte over the real 25 MiB cap",
    await c.send("/api/github/webhook", {
      body: Buffer.alloc(MAXIMUM_DELIVERY_BYTES + 1, 0x61),
      headers: {
        "content-type": "application/json",
        "x-github-delivery": GUIDS.oversized,
        "x-github-event": "pull_request",
      },
    }),
    413,
    `a delivery may not exceed ${MAXIMUM_DELIVERY_BYTES} bytes`
  );

  // Signed, and still not something an envelope can be built from: no Owner
  // locator, which is the tenant key every query needs.
  const noOwner = Buffer.from(JSON.stringify({ action: "opened" }));
  c.refuses(
    "F1 a correctly signed body no envelope can be built from",
    await c.send("/api/github/webhook", {
      body: noOwner,
      headers: {
        "content-type": "application/json",
        "x-github-delivery": GUIDS.unusable,
        "x-github-event": "pull_request",
        "x-hub-signature-256": signatureOver(noOwner),
      },
    }),
    422,
    /Owner locator/u
  );

  const recorded = oneRow(
    `select count(*)::text from ingress_delivery
      where delivery_guid in (:'refused', :'oversized', :'unusable')`,
    {
      oversized: GUIDS.oversized,
      refused: GUIDS.refused,
      unusable: GUIDS.unusable,
    }
  );
  c.is("F1 no refused delivery reached the ledger", recorded?.[0], "0");
};

/**
 * The Worker the scenario claims as.
 *
 * **This stands in for Enrollment**, which is #78 and which ADR 0016 asserts
 * absent from Phase 0: there is no endpoint that issues a Worker credential,
 * because Phase 0 deliberately has none. The rows are written as the superuser,
 * so `FORCE ROW LEVEL SECURITY` does not stand in the way, and the secret is
 * minted at run time by `@reprove/control-plane`'s own `mintWorkerCredential`
 * so that nothing here respells the credential format and no high-entropy
 * literal is ever committed. Only the `sha256:` digest reaches SQL.
 *
 * @returns {{credential: string, workerId: string}} What to present, and who.
 */
const arrangeWorker = () => {
  const workerId = randomUUID();
  const minted = mintWorkerCredential(OWNER_ID);
  psql(
    DATABASE,
    `insert into worker (id, owner_id, protocol_version, worker_build_version)
       values (:'workerId', ${OWNER_ID}, 1, :'build');
     insert into worker_credential (owner_id, worker_id, secret_hash)
       values (${OWNER_ID}, :'workerId', :'secretHash');`,
    {
      build: WORKER_BUILD_VERSION,
      secretHash: minted.secretHash,
      workerId,
    }
  );
  return { credential: minted.credential, workerId };
};

/**
 * F3's arrangement, and the one thing about a Run this scenario changes.
 *
 * **This stands in for a repository whose profile selects the self-hosted
 * placement.** Phase 0 has no configuration surface for placement at all: the
 * application injects `PHASE_0_RUN_PROFILE` by name, and ADR 0013 built that
 * profile precisely so a placement could not be read from a deployment's
 * environment. Adding an override for it would be the "Phase 0 fixture quietly
 * becoming product selection policy" the ADR exists to prevent, so the
 * claimant's placement is arranged and the claim itself - which is the subject
 * - stays entirely real.
 *
 * @param {string} runId The Run to move.
 * @returns {void}
 */
const arrangeSelfHosted = (runId) => {
  psql(
    DATABASE,
    "update run set placement = 'self_hosted' where id = :'runId'",
    {
      runId,
    }
  );
};

/**
 * One claim over the authenticated endpoint.
 *
 * @param {object} c The scenario's context.
 * @param {string | undefined} runId The Run to name, or nothing to poll.
 * @returns {Promise<{status: number, body: any, text: string}>} The answer.
 */
const claim = async (c, runId) =>
  await c.send("/api/worker/runs/claim", {
    body: JSON.stringify({
      protocolVersion: 1,
      runId,
      workerBuildVersion: WORKER_BUILD_VERSION,
    }),
    headers: {
      authorization: `Bearer ${c.credential}`,
      "content-type": "application/json",
    },
  });

/**
 * F2 and F3: what each placement answers, and what a second claim answers.
 *
 * ADR 0016 asks for "claim endpoint status and body, for both placements", and
 * the honest reading is that **a claim only ever reaches its own placement**:
 * the endpoint is the self-hosted one, so a hosted Run answers
 * `placement_mismatch` and a self-hosted Run answers with a grant. Those are
 * the endpoint's two answers about placement, and there is no third.
 *
 * @param {object} c The scenario's context.
 * @param {{id: string}} hosted The spine's Run, which is hosted.
 * @param {{id: string}} selfHosted The Run this walkthrough claims.
 * @returns {Promise<string>} The execution token the grant handed back.
 */
const walkClaims = async (c, hosted, selfHosted) => {
  c.refuses(
    "F2 a self-hosted Worker claiming the hosted Run",
    await claim(c, hosted.id),
    409,
    "placement_mismatch"
  );

  const granted = await claim(c, selfHosted.id);
  c.is("F3 the self-hosted Run is granted", granted.status, 200);
  const grant = claimGrantSchema.safeParse(granted.body);
  if (grant.success) {
    c.ok("F3 the grant validates against claimGrantSchema");
    c.is(
      "F3 the grant names the Run it was asked for",
      grant.data.runSpec.runId,
      selfHosted.id
    );
    c.is(
      "F3 the grant's spec carries the claimed placement",
      grant.data.runSpec.placement,
      "self_hosted"
    );
    c.is(
      "F3 the grant's spec carries the injected harness",
      grant.data.runSpec.harness,
      PHASE_0_RUN_PROFILE.harness
    );
  } else {
    c.bad(
      `F3 the grant does not validate against claimGrantSchema: ${grant.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`
    );
  }

  c.refuses(
    "F3 the same Run claimed a second time",
    await claim(c, selfHosted.id),
    409,
    "already_claimed"
  );

  // A Run is never actively held twice, and the row is what says so.
  const row = oneRow(
    `select status, coalesce(worker_id::text, ''), worker_protocol_version::text
       from run where id = :'runId'`,
    { runId: selfHosted.id }
  );
  c.is(
    "F3 the claimed Run records the Worker that holds it",
    `${row?.[0]}/${row?.[1]}/${row?.[2]}`,
    `claimed/${c.workerId}/1`
  );

  return granted.body?.executionToken ?? "";
};

/**
 * F4: every rejection the Result endpoint can be made to name, with the status
 * and the reason both asserted.
 *
 * None of these touches the Run. That is asserted at the end rather than
 * assumed: a rejection that quietly terminalized the Run it refused would make
 * every later walkthrough pass for the wrong reason.
 *
 * @param {object} c The scenario's context.
 * @param {{id: string}} run The claimed Run they are all aimed at.
 * @param {string} token Its current execution token.
 * @returns {Promise<void>} When every rejection has been asserted.
 */
const walkResultRejections = async (c, run, token) => {
  const path = `/api/worker/runs/${run.id}/result`;
  const authorized = {
    authorization: `Bearer ${c.credential}`,
    "content-type": "application/json",
  };
  const patched = {
    ...FINDING,
    patch: { ...FINDING.location, replacement: "// nothing" },
  };

  const cases = [
    {
      body: JSON.stringify(submissionFor(run.id, token)),
      headers: { "content-type": "application/json" },
      name: "F4 a submission carrying no credential",
      path,
      reason: "no valid Worker credential",
      status: 401,
    },
    {
      body: JSON.stringify(submissionFor(NOBODY, token)),
      name: "F4 a submission to a Run id nobody holds",
      path: `/api/worker/runs/${NOBODY}/result`,
      reason: "unknown_run",
      status: 404,
    },
    {
      body: JSON.stringify(
        submissionFor(run.id, token, {
          result: resultFor(run.id, { padding: "x".repeat(SUBMISSION_BYTES) }),
        })
      ),
      limit: SUBMISSION_BYTES,
      name: "F4 a body over the submission cap",
      path,
      reason: "oversized",
      status: 413,
    },
    {
      body: JSON.stringify(
        submissionFor(run.id, token, {
          result: resultFor(run.id, {
            padding: "x".repeat(RESULT_BYTES + 1024),
          }),
        })
      ),
      limit: RESULT_BYTES,
      name: "F4 a Result over its own cap, inside a body under the outer one",
      path,
      reason: "oversized",
      status: 413,
    },
    {
      body: "{ this is not json",
      name: "F4 a body that is not JSON",
      path,
      reason: "the body is not JSON",
      status: 422,
    },
    {
      body: JSON.stringify({ protocolVersion: 1, result: resultFor(run.id) }),
      name: "F4 an envelope with no execution token",
      path,
      reason: /^executionToken /u,
      status: 422,
    },
    {
      body: JSON.stringify(
        submissionFor(run.id, token, {
          result: resultFor(run.id, { completeness: "thorough" }),
        })
      ),
      name: "F4 a Result the protocol schema refuses",
      path,
      reason: /completeness/u,
      status: 422,
    },
    {
      body: JSON.stringify(
        submissionFor(run.id, token, { result: resultFor(NOBODY) })
      ),
      name: "F4 a Result naming a different Run than the path",
      path,
      reason: `runId ${NOBODY} does not name the Run this Result was submitted to`,
      status: 422,
    },
    {
      body: JSON.stringify(
        submissionFor(run.id, token, {
          result: resultFor(run.id, { findings: [patched] }),
        })
      ),
      name: "F4 a Finding carrying a Patch, against a Run whose autonomy is verify",
      path,
      reason: "findings.0.patch is not accepted under autonomy=verify",
      status: 422,
    },
    {
      body: JSON.stringify(
        submissionFor(run.id, token, { protocolVersion: 99 })
      ),
      name: "F4 a protocol version above the served window",
      path,
      reason: "unsupported_protocol_version",
      status: 426,
    },
  ];

  for (const rejection of cases) {
    const answer = await c.send(rejection.path, {
      body: rejection.body,
      headers: rejection.headers ?? authorized,
    });
    c.refuses(rejection.name, answer, rejection.status, rejection.reason);
    if (rejection.limit !== undefined) {
      c.is(
        `${rejection.name} names the cap it broke`,
        answer.body?.limit,
        rejection.limit
      );
    }
  }

  // `upgrade_required` is the one member of ADR 0016's rejection set that is
  // unreachable here, and it is unreachable by arithmetic rather than by
  // omission: `WORKER_PROTOCOL_SUPPORT` has `minimum === current === 1`, and
  // the envelope schema requires a positive integer, so there is no version a
  // Worker could send that is both well-formed and below the minimum. It
  // becomes reachable the first time this control plane serves two versions.
  const untouched = oneRow(
    "select status, (accepted_at is null)::text from run where id = :'runId'",
    { runId: run.id }
  );
  c.is(
    "F4 none of the rejections touched the Run they were aimed at",
    `${untouched?.[0]}/${untouched?.[1]}`,
    "claimed/true"
  );
};

/**
 * F6 and F7: Acceptance, the readback under `withOwner()`, and the ledger.
 *
 * @param {object} c The scenario's context.
 * @param {{id: string}} run The claimed Run.
 * @param {string} token Its current execution token.
 * @returns {Promise<void>} When the readback has been asserted.
 */
const walkAcceptance = async (c, run, token) => {
  const submission = JSON.stringify(submissionFor(run.id, token));
  const headers = {
    authorization: `Bearer ${c.credential}`,
    "content-type": "application/json",
  };
  const accepted = await c.send(`/api/worker/runs/${run.id}/result`, {
    body: submission,
    headers,
  });
  c.is("F6 the eligible Result is accepted", accepted.status, 200);
  c.is(
    "F6 the Run it was accepted into is complete",
    accepted.body?.runStatus,
    "completed"
  );

  // The readback ADR 0016 names: through `withOwner()` on the pooled runtime
  // role, which is what `ControlPlane.readRun` is composed over.
  const record = await c.plane.readRun(OWNER_ID, run.id);
  c.is("F6 readRun: the Run is completed", record?.status, "completed");
  c.is(
    "F6 readRun: the token digest is the one the grant's token hashes to",
    record?.executionTokenHash,
    executionTokenDigest(token)
  );
  c.is("F6 readRun: acceptedAt is recorded", record?.acceptedAt !== null, true);
  c.is(
    "F6 readRun: the summary is the one submitted",
    record?.resultSummary,
    GATE_SUMMARY
  );
  c.is("F6 readRun: nothing failed", record?.failureReason, null);
  c.is("F6 readRun: there is no failure detail", record?.failureDetail, null);
  c.is(
    "F6 readRun: the placement is the one claimed",
    record?.placement,
    "self_hosted"
  );
  c.is(
    "F6 readRun: the same Run is invisible to another Owner",
    await c.plane.readRun(STRANGER, run.id),
    null
  );

  const settled = await untilLedgerSettled(GUIDS.accepted);
  c.is("F6 the ledger row for this Run settled done", settled.state, "done");
  c.is("F6 the ledger row carries no disposition", settled.disposition, "");

  // The same head, a second time, under a different GUID: ADR 0013's
  // duplicate-head no-op, which is a fact about the ledger rather than a Run.
  const again = signedDelivery({
    deliveryGuid: GUIDS.duplicate,
    pullRequestNumber: PULLS.spine,
  });
  const acknowledged = await c.send("/api/github/webhook", {
    body: again.body,
    headers: again.headers,
  });
  c.is(
    "F6 a second delivery at the same head is acknowledged",
    acknowledged.status,
    200
  );
  const duplicate = await untilLedgerSettled(GUIDS.duplicate);
  c.is("F6 the second delivery was discarded", duplicate.state, "discarded");
  c.is("F6 and named duplicate_head", duplicate.disposition, "duplicate_head");

  c.refuses(
    "F7 the same Result submitted again to the Run it terminalized",
    await c.send(`/api/worker/runs/${run.id}/result`, {
      body: submission,
      headers,
    }),
    409,
    "not_eligible"
  );
};

/**
 * F8: exactly-once, proven concurrently or not at all.
 *
 * Two identical valid Results, in flight at the same time, both aiming the same
 * conditional UPDATE at the same row. Postgres serializes them on the row lock:
 * one matches and commits, the other re-evaluates its `WHERE` against the
 * committed row and matches zero. Two sequential submissions would prove only
 * that a terminal Run rejects a Result, which F7 already proves.
 *
 * @param {object} c The scenario's context.
 * @param {{id: string}} run The claimed Run.
 * @param {string} token Its current execution token.
 * @returns {Promise<void>} When the pair has been asserted.
 */
const walkConcurrency = async (c, run, token) => {
  const body = JSON.stringify(submissionFor(run.id, token));
  const headers = {
    authorization: `Bearer ${c.credential}`,
    "content-type": "application/json",
  };
  const path = `/api/worker/runs/${run.id}/result`;
  const [first, second] = await Promise.all([
    onItsOwnConnection(c.app.origin, path, headers, body),
    onItsOwnConnection(c.app.origin, path, headers, body),
  ]);

  c.is(
    "F8 two simultaneous submissions yield exactly one 200 and one 409",
    [first.status, second.status].toSorted().join(" and "),
    "200 and 409"
  );
  const rejected = first.status === 409 ? first : second;
  c.is(
    "F8 the one that lost is not_eligible",
    rejected.body?.reason,
    "not_eligible"
  );

  const row = oneRow(
    `select r.status,
            (r.accepted_at is not null)::text,
            (select count(*)::text from finding f where f.run_id = r.id)
       from run r where r.id = :'runId'`,
    { runId: run.id }
  );
  c.is(
    "F8 exactly one acceptance was written, with one set of Findings",
    `${row?.[0]}/${row?.[1]}/${row?.[2]}`,
    "completed/true/1"
  );
};

/**
 * F9: a Run left `claimed` with a null pass id, ended by the deadline alone -
 * once for each placement.
 *
 * **The hosted case is the mandatory one** (ADR 0016). The row shape it needs -
 * `claimed`, execution token assigned, `hosted_workflow_run_id` null - is
 * reached here through the **real** hosted claim, `ControlPlane.claimRun`,
 * which is the same conditional UPDATE `dispatchHostedPass` calls; what is not
 * reached is the `start()` that would follow it, because `start()` cannot be
 * called from an uncompiled script (the Workflow client transform stamps a
 * workflow's id at build time, and this process never runs that transform).
 * `packages/control-plane-workflow/src/spine.test.ts` reaches that half through
 * the real dispatch path and its `interruptBeforeRecordingPass` injection
 * point, and it runs inside this same required check.
 *
 * **The self-hosted case is kept beside it at no cost**: a Worker claims over
 * the authenticated endpoint and goes quiet. Same terminal state, different
 * cause, no injection. The pair is what shows the eligibility window is
 * placement-neutral rather than a hosted special case.
 *
 * @param {object} c The scenario's context.
 * @param {readonly {label: string, run: {id: string, workflowRunId: string},
 *   token: string, workerId: string, deadline: string}[]} silent The two
 *   abandoned Runs, each with what it recorded at claim.
 * @returns {Promise<void>} When both have been asserted.
 */
const walkLiveness = async (c, silent) => {
  for (const { deadline, label, run, token, workerId } of silent) {
    const row = await untilRunTerminal(run.id);
    c.is(`${label} the Run failed`, row[0], "failed");
    c.is(`${label} for worker_lost`, row[1], "worker_lost");
    c.is(`${label} detected by the watchdog`, row[2], "hosted_watchdog");
    c.is(`${label} observing deadline_elapsed`, row[3], "deadline_elapsed");
    c.is(`${label} lost from claimed`, row[4], "claimed");
    c.is(`${label} with no pass ever recorded`, row[5], "");
    c.is(
      `${label} scheduled by the one lifecycle it recorded at creation`,
      row[6],
      run.workflowRunId
    );
    // The placement-neutrality half: one of these Runs records the Worker that
    // claimed it and the other records none, and both end the same way.
    c.is(`${label} the Worker identity it records`, row[7], workerId);
    c.is(
      `${label} its execution deadline never moved after the claim`,
      executionDeadlineOf(run.id),
      deadline
    );

    // The ordering ADR 0016 corrected: a Result arriving after the transition
    // has won is `not_eligible` - the Run ended - rather than
    // `execution_mismatch`, even though the token it presents is still the
    // Run's current one.
    c.refuses(
      `${label} a late Result on the still-current token`,
      await c.send(`/api/worker/runs/${run.id}/result`, {
        body: JSON.stringify(submissionFor(run.id, token)),
        headers: {
          authorization: `Bearer ${c.credential}`,
          "content-type": "application/json",
        },
      }),
      409,
      "not_eligible"
    );
  }
};

/**
 * What Phase 1 owns, asserted absent.
 *
 * @param {object} c The scenario's context.
 * @param {{id: string}} run Any Run, for the routes that do not exist.
 * @returns {Promise<void>} When the battery has run.
 */
const walkAbsence = async (c, run) => {
  const unexpected = unexpectedRequests(c.github.seen, DRIVEN_PULLS);
  c.is(
    "absent: no Check run, Review or Comment was published - the request list is exactly the exchange and the canonical fetches",
    unexpected.join(", "),
    ""
  );

  const counts = oneRow(
    `select (select count(*)::text from publication),
            (select count(*)::text from enrollment_code),
            (select count(*)::text from finding
               where reconciliation is not null
                  or publication_disposition is not null),
            (select count(*)::text from run where refusals is not null),
            (select count(*)::text from run where cancellation_reason is not null),
            (select count(*)::text from finding),
            (select count(*)::text from run
               where result_summary is not null and result_summary <> :'summary')`,
    { summary: GATE_SUMMARY }
  );
  c.is("absent: nothing was published", counts?.[0], "0");
  c.is(
    "absent: no Enrollment happened - the credential was arranged",
    counts?.[1],
    "0"
  );
  c.is(
    "absent: no Finding carries a Reconciliation or a publication disposition",
    counts?.[2],
    "0"
  );
  c.is("absent: no Run carries a Refusal", counts?.[3], "0");
  c.is("absent: no Run carries a cancellation reason", counts?.[4], "0");
  c.is(
    "present: the Findings that were submitted were persisted",
    counts?.[5],
    "2"
  );
  c.is(
    "absent: no Result reached a Run except the ones this scenario submitted - no checkout, Workspace, Sandbox or Harness ran",
    counts?.[6],
    "0"
  );

  // No narrative is supplied to any Reviewer, and there is no runtime probe for
  // that because there is no Reviewer: the hosted placement's own input sets
  // `narrative: { description: null, title: 'Run <id>' }`
  // (`packages/worker-hosted/src/core.ts`), and the self-hosted path here has
  // no Worker at all beyond the one the scenario is standing in for.

  const authorized = {
    authorization: `Bearer ${c.credential}`,
    "content-type": "application/json",
  };
  const lease = await c.send(`/api/worker/runs/${run.id}/lease`, {
    body: "{}",
    headers: authorized,
  });
  c.is("absent: there is no Lease renewal transport", lease.status, 404);
  const progress = await c.send(`/api/worker/runs/${run.id}/progress`, {
    body: "{}",
    headers: authorized,
  });
  c.is("absent: there are no progress messages", progress.status, 404);
};

// --- the scenario ------------------------------------------------------------

/**
 * The scenario, as one call.
 *
 * It owns the canned GitHub, the built application and a `ControlPlane` of its
 * own, and it reports through the gate's `ok`/`bad` so that every assertion
 * lands in one list under one exit code.
 *
 * @param {{ok: (message: string) => void, bad: (message: string) => void}}
 *   report The gate's own reporting pair.
 * @returns {Promise<void>} When every walkthrough has been attempted.
 */
export const runPhase0Exit = async (report) => {
  const { bad, ok } = report;

  /** Asserts one value, naming both sides when they differ. */
  const is = (message, actual, expected) => {
    if (actual === expected) {
      ok(message);
    } else {
      bad(
        `${message}: read ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`
      );
    }
  };

  /** Asserts a value against a pattern, for the reasons a schema wrote. */
  const looks = (message, actual, pattern) => {
    if (pattern.test(String(actual))) {
      ok(message);
    } else {
      bad(`${message}: read ${JSON.stringify(actual)}, wanted ${pattern}`);
    }
  };

  /** Asserts a `{ status, reason }` refusal, both halves of it. */
  const refuses = (message, answer, status, reason) => {
    is(`${message} answers ${status}`, answer.status, status);
    if (reason instanceof RegExp) {
      looks(`${message} names its reason`, answer.body?.reason, reason);
    } else {
      is(`${message} names ${reason}`, answer.body?.reason, reason);
    }
  };

  const appKey = appKeyPair();
  const github = await startCannedGitHub();
  const app = startBuiltApp(github.url, appKey.privateKey, {
    // The two durations ADR 0016 moves, and nothing else.
    REPROVE_RUN_CLAIMABLE_FOR_MS: String(CLAIMABLE_FOR_MS),
    REPROVE_RUN_LIVENESS_FOR_MS: String(LIVENESS_FOR_MS),
  });

  /** One request to the built application, read as far as its body. */
  const send = async (path, options = {}) => {
    const response = await fetch(`${app.origin}${path}`, {
      body: options.body,
      headers: options.headers ?? {},
      method: options.method ?? "POST",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A `204` has no body and a `404` from the framework is HTML. The
      // assertion that reads a reason out of this reports the absence itself.
    }
    return { body, status: response.status, text };
  };

  /** @type {import("@reprove/control-plane").ControlPlane | null} */
  let plane = null;
  try {
    await untilServing(app.origin);
    ok("the built application serves");

    plane = await createControlPlane({
      database: { connectionString: runtimeUrl(DATABASE), poolSize: 4 },
      github: {
        appId: APP_ID,
        privateKey: appKey.privateKey,
        // The same two durations the application was started with: a plane
        // whose `livenessFor` disagreed would write an `executionExpiresAt`
        // the application's watchdog is not waiting for.
        runProfile: {
          ...PHASE_0_RUN_PROFILE,
          claimableForMs: CLAIMABLE_FOR_MS,
          livenessForMs: LIVENESS_FOR_MS,
        },
        webhookSecret: WEBHOOK_SECRET,
      },
    });
    ok(
      "a second control plane composed over the pooled runtime role, proving the tenant boundary a second time"
    );

    const c = {
      app,
      appKey,
      bad,
      // Both filled in below: the Owner row a Worker references is created by
      // the first delivery, so there is nothing to enroll against until the
      // spine has run.
      credential: "",
      github,
      is,
      ok,
      plane,
      refuses,
      send,
      workerId: "",
    };

    // W0, and the hosted Run every later walkthrough forks off.
    const spine = await walkSpine(c);
    await walkWebhookRefusals(c);

    const worker = arrangeWorker();
    c.credential = worker.credential;
    c.workerId = worker.workerId;

    // The three Runs the rest of the scenario needs, created through the same
    // spine and claimed straight away - the liveness walkthrough's clock starts
    // at the claim, and everything below runs while it ticks.
    const runs = {};
    for (const [name, guid] of [
      ["accepted", GUIDS.accepted],
      ["concurrent", GUIDS.concurrent],
      ["silent", GUIDS.silent],
    ]) {
      const delivery = signedDelivery({
        deliveryGuid: guid,
        pullRequestNumber: PULLS[name],
      });
      const acknowledged = await c.send("/api/github/webhook", {
        body: delivery.body,
        headers: delivery.headers,
      });
      if (acknowledged.status !== 200) {
        throw new Error(
          `the delivery for ${name} answered ${acknowledged.status} ${acknowledged.text}`
        );
      }
      runs[name] = await untilRunQueued(PULLS[name]);
      arrangeSelfHosted(runs[name].id);
    }
    ok("three further Runs were created through the same spine");

    const acceptedToken = await walkClaims(c, spine, runs.accepted);

    const concurrent = await claim(c, runs.concurrent.id);
    is("the concurrency Run was claimed", concurrent.status, 200);
    const silent = await claim(c, runs.silent.id);
    is("the silent Run was claimed", silent.status, 200);
    const silentDeadline = executionDeadlineOf(runs.silent.id);

    // The hosted half of F9, taken through the real hosted claim. `start()` is
    // deliberately not called after it: this is the window ADR 0016 pays for.
    const orphan = await plane.claimRun({ ownerId: OWNER_ID, runId: spine.id });
    is("the hosted Run was claimed by the hosted path", orphan.kind, "granted");
    const orphanDeadline = executionDeadlineOf(spine.id);
    is(
      "the hosted claim recorded no pass, which is the abandoned shape",
      oneRow(
        `select status, coalesce(hosted_workflow_run_id, '')
           from run where id = :'runId'`,
        { runId: spine.id }
      )?.join("/"),
      "claimed/"
    );

    await walkResultRejections(c, runs.accepted, acceptedToken);
    c.refuses(
      "F5 a well-formed token that is not the Run's current one",
      await c.send(`/api/worker/runs/${runs.accepted.id}/result`, {
        body: JSON.stringify(submissionFor(runs.accepted.id, randomUUID())),
        headers: {
          authorization: `Bearer ${c.credential}`,
          "content-type": "application/json",
        },
      }),
      409,
      "execution_mismatch"
    );

    await walkAcceptance(c, runs.accepted, acceptedToken);
    await walkConcurrency(
      c,
      runs.concurrent,
      concurrent.body?.executionToken ?? ""
    );

    await walkLiveness(c, [
      {
        deadline: silentDeadline,
        label: "F9 self-hosted silence:",
        run: runs.silent,
        token: silent.body?.executionToken ?? "",
        workerId: worker.workerId,
      },
      {
        deadline: orphanDeadline,
        label: "F9 the hosted start() orphan:",
        run: spine,
        token: orphan.kind === "granted" ? orphan.grant.executionToken : "",
        // Null, and that is the placement rather than an omission: ADR 0006
        // gives the hosted placement no durable Worker identity at all.
        workerId: "",
      },
    ]);

    await walkAbsence(c, runs.accepted);
  } catch (error) {
    bad(
      `${error instanceof Error ? error.message : String(error)}\nServer said: ${app.log()}`
    );
  } finally {
    // Settled rather than sequenced: a `stop()` that rejects must not leave the
    // canned server listening or the pool open, whose handles would hang the
    // gate instead of letting it exit.
    await Promise.allSettled([plane?.close(), app.stop(), github.close()]);
  }
};
