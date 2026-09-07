/**
 * `POST /api/worker/runs/:runId/result`, as a function over a `Request`.
 *
 * This is the stale-result boundary
 * ([ADR 0006](../../../../docs/adr/0006-worker-protocol.md)), and it holds
 * against a Worker that is buggy, partitioned or hostile rather than merely
 * slow. The order is the decision, and every step exists to keep the next one
 * from running too early:
 *
 * ```text
 * read the body under a hard cap           -> 413  oversized
 * authenticate                (txn 1)      -> 401
 * parse the envelope                       -> 422  malformed
 * check the protocol version               -> 426
 * measure the Result against its own bound -> 413  oversized
 * parse the Result                         -> 422  malformed
 * accept                      (txn 2)      -> 200 | 404 | 409 | 422
 * ```
 *
 * **Two caps, both answering `oversized`.** ADR 0006 bounds the Result and this
 * endpoint bounds the body, which is the Result plus an envelope, so there is a
 * band between them: a Result over its own bound inside a body under the outer
 * cap. Left to `resultSchema` that band comes back as a schema failure, and ADR
 * 0016 names it `oversized` - a different instruction to a Worker than "your
 * payload is malformed", because ADR 0006 requires an oversized submission to be
 * "rejected rather than upgraded into a streaming or artifact protocol". So the
 * inner bound is measured here, and both refusals carry the `limit` they broke.
 *
 * The inner measurement is **after** the compatibility check rather than before
 * it, which is the one place this order departs from listing the cheapest check
 * first. A Worker outside the served window has an upgrade to install whatever
 * else is wrong with its payload, and ADR 0006 makes naming that the control
 * plane's obligation; telling it its Result was too big would answer a question
 * it has not reached yet.
 *
 * **Authentication runs before the body is read for meaning**, which is the
 * order `endpoint.ts` and `github/webhook.ts` both give: a request Reprove
 * cannot attribute is not a submission, and nothing about what it claims to be
 * is worth acting on.
 *
 * **The compatibility check runs between the two parses, and that placement is
 * the reason the envelope exists.** `resultSchema` pins `protocolVersion` with
 * a literal, so parsing the Result first would report a Worker outside the
 * served window as malformed and lose ADR 0006's one actionable instruction -
 * a structured `upgrade_required` naming the minimum. The envelope's plain
 * integer is read first, and the Result is parsed after the window has been
 * agreed.
 *
 * **Nothing about Run state is read or written until the payload has passed
 * `@reprove/protocol`.** That is #55's "rejected before it can affect Run
 * state", made structural by the ordering rather than by care: the acceptance
 * port is the only thing here that touches a Run, and every refusal above
 * returns before reaching it.
 *
 * The refusal body is `{ status, reason }`, like the claim's, and carries
 * nothing a stranger can use.
 */
import type { ResultSubmission } from "@reprove/protocol/v1";
import {
  protocolLimits,
  resultSchema,
  submissionSchemas,
} from "@reprove/protocol/v1";

import type {
  ResultRejection,
  WorkerResultPort,
} from "./acceptance-outcome.js";
import { WORKER_RESULT_STATUS } from "./acceptance-outcome.js";
import type { WorkerIdentity } from "./authenticate.js";
import { answer, fieldsOf, readWorkerRequest, refusalStatus } from "./http.js";

/**
 * The largest submission to accept.
 *
 * ADR 0006 bounds the **Result**, and `resultSchema` enforces that figure over
 * the Result itself. This is the bound on the whole body, which is the Result
 * plus an envelope carrying a token, an optional key and a version - so capping
 * the body at the Result's own figure would refuse a Result that is exactly
 * within its bound. Eight kilobytes is three orders of magnitude above what the
 * envelope needs and far below anything that could be called bulk.
 *
 * Both bounds are real and each is honest about what it bounds: this one is the
 * one that refuses **before the bytes are accumulated**, because `readBoundedBody`
 * abandons the stream at the cap, and ADR 0006 requires an oversized submission
 * to be rejected rather than truncated into shape.
 */
export const MAXIMUM_SUBMISSION_BYTES = protocolLimits.resultBytes + 8 * 1024;

/** What the handler is composed over. No value here is read from anywhere. */
export interface WorkerResultConfig {
  /** Transaction one: verify the credential, and nothing else. */
  readonly authenticate: (
    authorization: string | null
  ) => Promise<WorkerIdentity | null>;
  /** Transaction two, reached only by an authenticated, compatible, valid submission. */
  readonly accept: WorkerResultPort;
  /** The largest body to accept. Defaults to {@link MAXIMUM_SUBMISSION_BYTES}. */
  readonly maximumBytes?: number;
}

/**
 * A refusal naming the cap it broke, which is the one refusal that is worth a
 * number: a Worker cannot shrink a payload it has not been told the size of.
 */
const oversized = (limit: number): Response =>
  answer(WORKER_RESULT_STATUS.oversized, "oversized", { limit });

/**
 * The bytes `resultSchema`'s own bound is measured over, computed the same way
 * `boundedJsonSchema` computes it so the two cannot disagree about a payload on
 * the edge. The bound itself is read from `protocolLimits`, so there is one
 * figure rather than two.
 *
 * Unknown additive fields count, deliberately: they are bytes that crossed, and
 * the schema counts them too before Zod strips them for forward compatibility.
 */
const resultBytesOf = (submission: ResultSubmission): number =>
  Buffer.byteLength(JSON.stringify(submission.result ?? null), "utf-8");

/** Which status a named rejection answers with. */
const statusOf = (reason: ResultRejection): number =>
  refusalStatus(
    reason,
    WORKER_RESULT_STATUS.unknownRun,
    WORKER_RESULT_STATUS.rejected
  );

/**
 * Builds the handler.
 *
 * @param config The authenticator, the acceptance port and the body cap.
 * @returns A function from a submission and its Run id to the answer.
 */
export const createWorkerResultHandler = (
  config: WorkerResultConfig
): ((request: Request, runId: string) => Promise<Response>) => {
  const maximumBytes = config.maximumBytes ?? MAXIMUM_SUBMISSION_BYTES;

  const handle = async (request: Request, runId: string): Promise<Response> => {
    const read = await readWorkerRequest({
      authenticate: config.authenticate,
      maximumBytes,
      onOversized: oversized,
      onUnavailable: () =>
        answer(
          WORKER_RESULT_STATUS.unavailable,
          "the credential could not be verified, so nothing was accepted"
        ),
      parse: (body) => submissionSchemas.request.safeParse(body),
      request,
      statuses: WORKER_RESULT_STATUS,
      versionOf: (envelope) => envelope.protocolVersion,
    });
    if (read.kind === "answered") {
      return read.response;
    }
    const { payload: submission, worker } = read;

    if (resultBytesOf(submission) > protocolLimits.resultBytes) {
      return oversized(protocolLimits.resultBytes);
    }

    const parsed = resultSchema.safeParse(submission.result);
    if (!parsed.success) {
      return answer(WORKER_RESULT_STATUS.malformed, fieldsOf(parsed.error));
    }
    const result = parsed.data;

    if (result.runId !== runId) {
      // The path is the request's own subject and the body is the Worker's
      // account of itself. Accepting the mismatch would let one of the two be
      // decoration, and there is no reading under which they may differ.
      return answer(
        WORKER_RESULT_STATUS.malformed,
        `runId ${result.runId} does not name the Run this Result was submitted to`
      );
    }

    let outcome: Awaited<ReturnType<WorkerResultPort>>;
    try {
      outcome = await config.accept({
        ownerId: worker.ownerId,
        runId,
        executionToken: submission.executionToken,
        result,
        // `idempotencyKey` deliberately stops here. ADR 0006 makes it "a
        // convenience for network retry" and says in the same sentence that it
        // must not be what enforces at most one accepted terminal Result, so
        // nothing downstream is given the chance to read it.
      });
    } catch {
      // The acceptance transaction rolled back, so the Run is exactly as it
      // was. Deliberately nothing from the cause: the reader is a daemon's log
      // on someone else's machine.
      return answer(
        WORKER_RESULT_STATUS.unavailable,
        "the Result could not be accepted, and the Run is unchanged"
      );
    }

    if (outcome.kind === "accepted") {
      return Response.json(
        {
          status: WORKER_RESULT_STATUS.accepted,
          runStatus: outcome.runStatus,
        },
        { status: WORKER_RESULT_STATUS.accepted }
      );
    }
    if (outcome.kind === "malformed") {
      return answer(WORKER_RESULT_STATUS.malformed, outcome.reason);
    }
    return answer(statusOf(outcome.reason), outcome.reason);
  };

  return handle;
};
