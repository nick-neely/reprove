/**
 * `POST /api/github/webhook`, as a function over a `Request`.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * fixes the order and makes it the whole decision:
 *
 * ```text
 * verify HMAC-SHA256 over the raw bytes
 *   -> normalize a bounded ingress envelope
 *   -> commit it with its processing state
 *   -> return 200
 *   -> kick asynchronous processing
 * ```
 *
 * **Durability comes before the acknowledgement**, because GitHub does not
 * automatically redeliver: redelivery is manual, from the App's delivery UI or
 * the deliveries API, and only within three days. So a `200` returned before
 * anything is persisted is the one genuinely unrecoverable outcome in the
 * system, and a failure to commit is a non-2xx **on purpose** - it buys the only
 * recovery GitHub offers. Once the envelope is committed the opposite holds: a
 * failed asynchronous kick still returns `200`, because Reprove now holds the
 * intent and the ledger is what recovers it.
 *
 * The commit is a **port** rather than a database call, and that is what makes
 * the ordering testable: a handler that answered first and persisted afterwards
 * passes every assertion about status codes and fails the one about when it
 * answered. `createControlPlane()` binds the port to a `withOwner` transaction.
 *
 * There is no Check anywhere in here. `CONTEXT.md` requires a Refusal to be
 * visible on a Check, and ADR 0013 records that **no Refusal is reachable in
 * Phase 0** - a control-plane Refusal arises from configuration that is invalid
 * or cannot be resolved, and Phase 0 Runs are built from fixed inputs with no
 * repository configuration. A rejected delivery here is not a Refusal: nothing
 * was refused and nothing executed.
 */
import { readBoundedBody } from "./body.js";
import type { IngressEnvelope } from "./envelope.js";
import { normalizeDelivery } from "./envelope.js";
import { isSignatureValid, SIGNATURE_HEADER } from "./signature.js";

export const EVENT_HEADER = "x-github-event";
export const DELIVERY_HEADER = "x-github-delivery";

/**
 * GitHub's own documented cap on a webhook payload. The default is that number
 * rather than a smaller guess so the bound is a backstop against a body GitHub
 * could not have sent, never a reason a legitimate delivery is turned away.
 */
export const MAXIMUM_DELIVERY_BYTES = 25 * 1024 * 1024;

/**
 * One status per reason, because ADR 0013's recovery story is different for
 * each of them and a single `400` would collapse the three.
 *
 * `notCommitted` is the one that matters most and is the counterintuitive half
 * of the decision: it is a failure Reprove *wants* GitHub to see, so the
 * delivery stays manually redeliverable. The other three are rejections of
 * something Reprove will never be able to use, and re-sending them would only
 * produce the same answer.
 */
export const WEBHOOK_STATUS = {
  /** The envelope is durable. Processing has not necessarily started. */
  acknowledged: 200,
  /** No valid signature over these exact bytes. */
  unsigned: 401,
  /** Over the cap, and refused before being hashed. */
  oversized: 413,
  /** Signed, and still not something an envelope can be built from. */
  unusable: 422,
  /** The envelope could not be committed, so nothing may be acknowledged. */
  notCommitted: 503,
} as const;

/**
 * What durably commits an envelope. It resolves only once the row is committed,
 * and rejects otherwise; there is no third answer, because the handler turns
 * the distinction straight into an acknowledgement or the absence of one.
 */
export type CommitEnvelope = (envelope: IngressEnvelope) => Promise<void>;

/** What the handler is composed over. No value here is read from anywhere. */
export interface WebhookConfig {
  /** The webhook secret the App was registered with. */
  readonly secret: string;
  /** The largest body to accept. Defaults to {@link MAXIMUM_DELIVERY_BYTES}. */
  readonly maximumBytes?: number;
  readonly commit: CommitEnvelope;
}

/**
 * A response carrying a reason a person can read and nothing a stranger can
 * use. GitHub ignores the body, so its only reader is whoever is looking at a
 * failed delivery in the App's delivery UI - which is a good reason for it to
 * say what happened and a better one for it never to quote an internal error.
 */
const answer = (status: number, reason: string): Response =>
  Response.json({ status, reason }, { status });

/**
 * Builds the handler.
 *
 * @param config The webhook secret, the body cap and the commit port.
 * @returns A function from a delivery to its acknowledgement or rejection.
 */
export const createGitHubWebhookHandler = (
  config: WebhookConfig
): ((request: Request) => Promise<Response>) => {
  const maximumBytes = config.maximumBytes ?? MAXIMUM_DELIVERY_BYTES;

  return async (request: Request): Promise<Response> => {
    const body = await readBoundedBody(request, maximumBytes);
    if (body.kind === "oversized") {
      return answer(
        WEBHOOK_STATUS.oversized,
        `a delivery may not exceed ${body.limit} bytes`
      );
    }

    // Before anything reads a header for meaning, and before the body is
    // parsed: an unsigned request is not a delivery, and nothing about what it
    // claims to be is worth acting on.
    if (
      !isSignatureValid({
        secret: config.secret,
        body: body.bytes,
        signature: request.headers.get(SIGNATURE_HEADER),
      })
    ) {
      return answer(
        WEBHOOK_STATUS.unsigned,
        `no valid ${SIGNATURE_HEADER} over these exact bytes`
      );
    }

    const normalized = normalizeDelivery({
      event: request.headers.get(EVENT_HEADER) ?? "",
      deliveryGuid: request.headers.get(DELIVERY_HEADER) ?? "",
      body: body.bytes,
    });
    if (normalized.kind === "malformed") {
      return answer(WEBHOOK_STATUS.unusable, normalized.reason);
    }

    try {
      await config.commit(normalized.envelope);
    } catch {
      // Deliberately nothing from the cause: the reader of this body is
      // whoever opens the App's delivery UI, and a connection string or a
      // relation name has no business being there. The failure is the
      // deployment's to observe on its own side.
      return answer(
        WEBHOOK_STATUS.notCommitted,
        "the delivery could not be recorded durably, so it is not acknowledged"
      );
    }

    return answer(
      WEBHOOK_STATUS.acknowledged,
      `delivery ${normalized.envelope.deliveryGuid} recorded`
    );
  };
};
