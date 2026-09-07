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
 * read the body under a hard cap           -> 413
 * authenticate                (txn 1)      -> 401
 * parse the envelope                       -> 422
 * check the protocol version               -> 426
 * parse the Result                         -> 422
 * accept                      (txn 2)      -> 200 | 404 | 409 | 422
 * ```
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
import { protocolLimits, resultSchema, submissionSchemas } from "@reprove/protocol/v1";

import { readBoundedBody } from "../github/body.js";
import type { ResultRejection, WorkerResultPort } from "./acceptance-outcome.js";
import { WORKER_RESULT_STATUS } from "./acceptance-outcome.js";
import type { WorkerIdentity } from "./authenticate.js";
import { checkProtocolVersion } from "./compatibility.js";

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

/** A response carrying a reason a person can read and nothing a stranger can use. */
const answer = (
  status: number,
  reason: string,
  detail: Readonly<Record<string, number>> = {}
): Response => Response.json({ status, reason, ...detail }, { status });

/** Which status a named rejection answers with. */
const statusOf = (reason: ResultRejection): number =>
  reason === "unknown_run"
    ? WORKER_RESULT_STATUS.unknownRun
    : WORKER_RESULT_STATUS.rejected;

/** Every field a schema could not read, named, as one line. */
const fieldsOf = (error: { readonly issues: readonly {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}[] }): string =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`)
    .join("; ");

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
    const body = await readBoundedBody(request, maximumBytes);
    if (body.kind === "oversized") {
      return answer(
        WORKER_RESULT_STATUS.oversized,
        `a Result submission may not exceed ${body.limit} bytes`
      );
    }

    let worker: WorkerIdentity | null;
    try {
      worker = await config.authenticate(request.headers.get("authorization"));
    } catch {
      // The pre-authentication transaction could not run. Nothing was decided,
      // so this is not a `401`: telling a Worker its credential is bad when the
      // database was unreachable would send an operator after the wrong thing.
      return answer(
        WORKER_RESULT_STATUS.unavailable,
        "the credential could not be verified, so nothing was accepted"
      );
    }
    if (!worker) {
      return answer(
        WORKER_RESULT_STATUS.unauthenticated,
        "no valid Worker credential"
      );
    }

    let envelope: ReturnType<typeof submissionSchemas.request.safeParse>;
    try {
      envelope = submissionSchemas.request.safeParse(
        JSON.parse(new TextDecoder().decode(body.bytes))
      );
    } catch {
      return answer(WORKER_RESULT_STATUS.malformed, "the body is not JSON");
    }
    if (!envelope.success) {
      return answer(WORKER_RESULT_STATUS.malformed, fieldsOf(envelope.error));
    }
    const submission = envelope.data;

    const compatibility = checkProtocolVersion(submission.protocolVersion);
    if (compatibility.kind === "incompatible") {
      return answer(
        WORKER_RESULT_STATUS.incompatible,
        compatibility.reason,
        // Both numbers, both ways round: a Worker below the window needs the
        // minimum to upgrade to, and a Worker above it needs the current
        // version, because telling that one to upgrade would be false.
        { minimum: compatibility.minimum, current: compatibility.current }
      );
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
