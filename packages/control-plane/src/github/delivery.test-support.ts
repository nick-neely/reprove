/**
 * A GitHub delivery as GitHub would send one, built once so that every test
 * measuring the handler signs the bytes it actually posts.
 *
 * Not shipped: `tsconfig.build.json` keeps it out of `dist`.
 *
 * The signing runs over the serialized bytes rather than over the object,
 * because that is the only arrangement in which a test can tell a handler that
 * hashes the received bytes from one that hashes its own re-serialization.
 */
import { signDelivery, SIGNATURE_HEADER } from "./signature.js";

export const WEBHOOK_URL = "https://reprove.test/api/github/webhook";

/** The secret these fixtures are signed with. Not a real one. */
export const WEBHOOK_SECRET = "a-webhook-secret-that-is-not-a-real-one";

/** A `pull_request` payload carrying every locator the envelope reads. */
export const OPENED_PULL_REQUEST = {
  action: "opened",
  number: 7,
  installation: { id: 42 },
  repository: {
    id: 3001,
    full_name: "acme/reprove",
    owner: { id: 1001, login: "acme", type: "Organization" },
  },
  pull_request: { number: 7, head: { sha: "b".repeat(40) } },
} as const;

export const DELIVERY_GUID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

/** What a caller may vary about a delivery. */
export interface DeliveryOptions {
  readonly secret?: string;
  readonly event?: string;
  readonly deliveryGuid?: string;
  /** The exact bytes to post, overriding the payload below. */
  readonly body?: Uint8Array;
  /** The signature header to send, overriding the one these bytes deserve. */
  readonly signature?: string | null;
  /** Headers to leave off entirely. */
  readonly without?: readonly string[];
}

/** A payload's bytes, which is the form everything downstream sees. */
export const deliveryBytes = <Fixture>(payload: Fixture): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(payload));

/** The default payload's bytes, so a test can tamper with them. */
export const openedPullRequestBytes = (): Uint8Array =>
  deliveryBytes(OPENED_PULL_REQUEST);

/**
 * A signed delivery, or a deliberately broken one.
 *
 * @param options What to vary about the delivery.
 * @returns The request a handler is given.
 */
export const signedDelivery = (options: DeliveryOptions = {}): Request => {
  const body = options.body ?? openedPullRequestBytes();
  const secret = options.secret ?? WEBHOOK_SECRET;
  const omitted = new Set(options.without);

  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": options.event ?? "pull_request",
    "x-github-delivery": options.deliveryGuid ?? DELIVERY_GUID,
  });
  const signature =
    options.signature === undefined
      ? signDelivery(secret, body)
      : options.signature;
  if (signature !== null) {
    headers.set(SIGNATURE_HEADER, signature);
  }
  for (const header of omitted) {
    headers.delete(header);
  }

  return new Request(WEBHOOK_URL, { method: "POST", headers, body });
};
