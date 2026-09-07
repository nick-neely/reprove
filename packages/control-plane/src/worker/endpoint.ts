/**
 * `POST /api/worker/runs/claim`, as a function over a `Request`.
 *
 * The Worker is always the HTTP client and the control plane always the server
 * ([ADR 0006](../../../../docs/adr/0006-worker-protocol.md)), so this is the
 * whole of how work reaches a self-hosted Worker: no inbound port on the
 * Worker, no NAT traversal, no certificate on a laptop.
 *
 * The order is the decision, and every step exists to keep the next one from
 * running too early:
 *
 * ```text
 * read the body under a hard cap           -> 413
 * authenticate                (txn 1)      -> 401
 * parse it as a claim request              -> 422
 * check the protocol version               -> 426
 * claim                       (txn 2)      -> 200 | 204 | 404 | 409
 * ```
 *
 * **Authentication runs before the body is read for meaning**, which is the
 * same order `github/webhook.ts` gives for a signature: a request Reprove
 * cannot attribute is not a claim, and nothing about what it claims to be is
 * worth acting on. It costs one transaction against a garbage body and buys
 * that the request schema is not a surface a stranger can probe.
 *
 * **The compatibility check runs before the claim transaction opens.** ADR 0006
 * requires that a Worker below `minimum` "does not claim Runs": handing it a
 * `RunSpec` it cannot read and letting it refuse afterwards would consume the
 * Run's claim window on an execution that was never going to start.
 *
 * The refusal body is `{ status, reason }`, like the webhook's, and carries
 * nothing a stranger can use. `401` in particular never distinguishes an
 * unknown Owner, an unknown secret, a revoked credential or an expired one -
 * all four are the same answer, so the endpoint cannot be used to enumerate
 * which Owners exist or which credentials once did.
 */
import { claimRequestSchema } from "@reprove/protocol/v1";

import type { WorkerIdentity } from "./authenticate.js";
import type { ClaimRefusal, WorkerClaimPort } from "./claim-outcome.js";
import { WORKER_CLAIM_STATUS } from "./claim-outcome.js";
import { answer, readWorkerRequest, refusalStatus } from "./http.js";

/**
 * The largest claim request to accept.
 *
 * A claim carries a version, a build string and at most one Run id, so the cap
 * is three orders of magnitude above anything legitimate and still small enough
 * that an endpoint reachable by an unauthenticated caller cannot be made to
 * accumulate a body. ADR 0006's size bound is about Results; this is the same
 * reflex applied to the one request that arrives before authentication.
 */
export const MAXIMUM_CLAIM_BYTES = 16 * 1024;

/** What the handler is composed over. No value here is read from anywhere. */
export interface WorkerClaimConfig {
  /** Transaction one: verify the credential, and nothing else. */
  readonly authenticate: (
    authorization: string | null
  ) => Promise<WorkerIdentity | null>;
  /** Transaction two, reached only by an authenticated, compatible Worker. */
  readonly claim: WorkerClaimPort;
  /** The largest body to accept. Defaults to {@link MAXIMUM_CLAIM_BYTES}. */
  readonly maximumBytes?: number;
}

/** Which status a named refusal answers with. */
const statusOf = (reason: ClaimRefusal): number =>
  refusalStatus(
    reason,
    WORKER_CLAIM_STATUS.unknownRun,
    WORKER_CLAIM_STATUS.refused
  );

/**
 * Builds the handler.
 *
 * @param config The authenticator, the claim port and the body cap.
 * @returns A function from a claim request to its grant or its refusal.
 */
export const createWorkerClaimHandler = (
  config: WorkerClaimConfig
): ((request: Request) => Promise<Response>) => {
  const maximumBytes = config.maximumBytes ?? MAXIMUM_CLAIM_BYTES;

  const handle = async (request: Request): Promise<Response> => {
    const read = await readWorkerRequest({
      authenticate: config.authenticate,
      maximumBytes,
      onOversized: (limit) =>
        answer(
          WORKER_CLAIM_STATUS.oversized,
          `a claim may not exceed ${limit} bytes`
        ),
      onUnavailable: () =>
        answer(
          WORKER_CLAIM_STATUS.unavailable,
          "the credential could not be verified, so nothing was claimed"
        ),
      parse: (body) => claimRequestSchema.safeParse(body),
      request,
      statuses: WORKER_CLAIM_STATUS,
      versionOf: (claimRequest) => claimRequest.protocolVersion,
    });
    if (read.kind === "answered") {
      return read.response;
    }
    const { payload: claimRequest, worker } = read;

    let outcome: Awaited<ReturnType<WorkerClaimPort>>;
    try {
      outcome = await config.claim({
        ownerId: worker.ownerId,
        runId: claimRequest.runId,
        worker: {
          protocolVersion: claimRequest.protocolVersion,
          workerBuildVersion: claimRequest.workerBuildVersion,
          workerId: worker.workerId,
        },
      });
    } catch {
      // The claim transaction rolled back, so no Run is held by an execution
      // this request never received. Deliberately nothing from the cause: the
      // reader is a daemon's log on someone else's machine.
      return answer(
        WORKER_CLAIM_STATUS.unavailable,
        "the claim could not be attempted, so nothing was claimed"
      );
    }

    if (outcome.kind === "granted") {
      return Response.json(outcome.grant, {
        status: WORKER_CLAIM_STATUS.granted,
      });
    }
    if (outcome.kind === "no_run_available") {
      // No body at all. An idle poll is the ordinary case and the heartbeat
      // besides, so the answer a Worker sees most often says nothing is wrong.
      return new Response(null, {
        status: WORKER_CLAIM_STATUS.noRunAvailable,
      });
    }
    return answer(statusOf(outcome.reason), outcome.reason);
  };

  return handle;
};
