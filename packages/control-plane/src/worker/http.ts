/**
 * The part of a Worker endpoint that is the same on both of them.
 *
 * `POST /api/worker/runs/claim` and `POST /api/worker/runs/:runId/result` are
 * two different decisions reached through one identical preamble, and the
 * preamble is not incidental - it is the order
 * [ADR 0006](../../../../docs/adr/0006-worker-protocol.md) and
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)
 * fix between them:
 *
 * ```text
 * read the body under a hard cap        -> the caller's own refusal
 * authenticate              (txn 1)     -> 401, or the caller's own outage answer
 * parse the body as JSON                -> 422
 * parse it as the endpoint's request    -> 422, naming the field
 * check the protocol version            -> 426, naming the window
 * ```
 *
 * Sharing it is what keeps the two from drifting: authentication before the
 * body is read for meaning is a decision about what a stranger may probe, and
 * an endpoint that quietly reordered it would still pass every status-code
 * assertion written against it. Each endpoint keeps whatever comes **after**,
 * which is where the two stop agreeing.
 *
 * Two refusals stay with the caller rather than moving here, because their
 * wording is the endpoint's own: the cap says what was too big, and the
 * pre-authentication outage says what was consequently not done - "nothing was
 * claimed" against "nothing was accepted", which is the difference between two
 * things a Worker would do next.
 */
import { readBoundedBody } from "../github/body.js";
import type { WorkerIdentity } from "./authenticate.js";
import { checkProtocolVersion } from "./compatibility.js";

/** A response carrying a reason a person can read and nothing a stranger can use. */
export const answer = (
  status: number,
  reason: string,
  detail: Readonly<Record<string, number>> = {}
): Response => Response.json({ status, reason, ...detail }, { status });

/**
 * Which status a named refusal answers with.
 *
 * `unknown_run` is the only one that is a `404`, on both endpoints and for the
 * same reason: it is the answer for a Run this Owner does not hold, which
 * includes a Run another Owner holds, because the probe that names it runs
 * inside `withOwner` and cannot see across the boundary.
 *
 * @param reason The named refusal.
 * @param unknownRun The endpoint's `404`.
 * @param refused The endpoint's `409`.
 * @returns The status to answer with.
 */
export const refusalStatus = (
  reason: string,
  unknownRun: number,
  refused: number
): number => (reason === "unknown_run" ? unknownRun : refused);

/**
 * One decoded JSON body, before any schema has been applied to it. It is what
 * `JSON.parse` produced and nothing more, which is exactly what a schema is
 * handed.
 */
export type DecodedBody =
  | string
  | number
  | boolean
  | null
  | readonly DecodedBody[]
  | { readonly [key: string]: DecodedBody };

/** The shape of a failed Zod parse, named structurally so this file imports no schema. */
export interface ParseIssues {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}

/** Every field a schema could not read, named, as one line. */
export const fieldsOf = (error: ParseIssues): string =>
  error.issues
    .map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`)
    .join("; ");

/** What a schema answers, as much of it as this module needs to know. */
export type ParseOutcome<Payload> =
  | { readonly success: true; readonly data: Payload }
  | { readonly success: false; readonly error: ParseIssues };

/** The statuses the shared preamble answers with, as each endpoint spells them. */
export interface WorkerRequestStatuses {
  readonly unauthenticated: number;
  readonly malformed: number;
  readonly incompatible: number;
}

/** What reading one authenticated Worker request is composed over. */
export interface WorkerRequestConfig<Payload> {
  readonly request: Request;
  /** The largest body to accept, before anything is read for meaning. */
  readonly maximumBytes: number;
  /** Transaction one: verify the credential, and nothing else. */
  readonly authenticate: (
    authorization: string | null
  ) => Promise<WorkerIdentity | null>;
  /** The endpoint's own request schema, as a function so this file names none. */
  readonly parse: (body: DecodedBody) => ParseOutcome<Payload>;
  /** Where the compatibility check reads the advertised version from. */
  readonly versionOf: (payload: Payload) => number;
  readonly statuses: WorkerRequestStatuses;
  /** The endpoint's own refusal for a body over the cap. */
  readonly onOversized: (limit: number) => Response;
  /** The endpoint's own answer when the pre-authentication transaction could not run. */
  readonly onUnavailable: () => Response;
}

/** An authenticated, compatible, well-formed request, or the answer that ended it. */
export type WorkerRequest<Payload> =
  | { readonly kind: "answered"; readonly response: Response }
  | {
      readonly kind: "ready";
      readonly worker: WorkerIdentity;
      readonly payload: Payload;
    };

/**
 * Reads one Worker request as far as every Worker endpoint reads it the same
 * way, and no further.
 *
 * **Authentication runs before the body is read for meaning**, which is the
 * order `github/webhook.ts` gives for a signature: a request Reprove cannot
 * attribute is not a claim and is not a submission, and nothing about what it
 * says it is is worth acting on. It costs one transaction against a garbage
 * body and buys that the request schema is not a surface a stranger can probe.
 *
 * **The compatibility check runs last here, and therefore before either
 * endpoint's own transaction opens.** ADR 0006 requires that a Worker below
 * `minimum` "does not claim Runs", and handing one a payload it cannot read and
 * letting it refuse afterwards is a different and weaker guarantee.
 *
 * @param config The request, the cap, the authenticator and the schema.
 * @returns The Worker and its parsed payload, or the response that refused it.
 */
export const readWorkerRequest = async <Payload>(
  config: WorkerRequestConfig<Payload>
): Promise<WorkerRequest<Payload>> => {
  const body = await readBoundedBody(config.request, config.maximumBytes);
  if (body.kind === "oversized") {
    return { kind: "answered", response: config.onOversized(body.limit) };
  }

  let worker: WorkerIdentity | null;
  try {
    worker = await config.authenticate(
      config.request.headers.get("authorization")
    );
  } catch {
    // Nothing was decided and nothing was written, so this is not a `401`:
    // telling a Worker its credential is bad when the database was unreachable
    // would send an operator after the wrong thing.
    return { kind: "answered", response: config.onUnavailable() };
  }
  if (!worker) {
    // One answer for an unknown Owner, an unknown secret, a revoked credential
    // and an expired one alike, so the endpoint cannot be used to enumerate
    // which Owners exist or which credentials once did.
    return {
      kind: "answered",
      response: answer(
        config.statuses.unauthenticated,
        "no valid Worker credential"
      ),
    };
  }

  let parsed: ParseOutcome<Payload>;
  try {
    parsed = config.parse(JSON.parse(new TextDecoder().decode(body.bytes)));
  } catch {
    return {
      kind: "answered",
      response: answer(config.statuses.malformed, "the body is not JSON"),
    };
  }
  if (!parsed.success) {
    return {
      kind: "answered",
      response: answer(config.statuses.malformed, fieldsOf(parsed.error)),
    };
  }

  const compatibility = checkProtocolVersion(config.versionOf(parsed.data));
  if (compatibility.kind === "incompatible") {
    return {
      kind: "answered",
      response: answer(
        config.statuses.incompatible,
        compatibility.reason,
        // Both numbers, both ways round. ADR 0006 requires `upgrade_required`
        // to name the minimum, and a Worker ahead of this control plane needs
        // the current version for the same reason: a version it can act on
        // rather than an instruction it cannot follow.
        { current: compatibility.current, minimum: compatibility.minimum }
      ),
    };
  }

  return { kind: "ready", payload: parsed.data, worker };
};
