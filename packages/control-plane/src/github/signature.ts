/**
 * Reprove's own signature verification, over the exact bytes GitHub sent.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * closes with three implementation notes, and two of them are this module:
 * verify against the exact received bytes and never a re-serialized parse, and
 * use a timing-safe comparison. The third - reject an oversized body before
 * hashing it - is `body.ts`, which runs in front of this.
 *
 * **The bytes are the subject, not the payload.** `JSON.parse` followed by
 * `JSON.stringify` is lossy in ways nothing downstream can see: key order,
 * whitespace, `\u` escapes and the exact digits of a number all move. A handler
 * that hashed its own re-serialization would therefore accept bodies GitHub
 * never signed and reject ones it did, so nothing here ever sees a parsed value
 * and the parse happens strictly after this returns true.
 *
 * There is no `@octokit/webhooks` here on purpose. ADR 0010's matrix admits
 * `octokit` to this package, so the dependency is available and is still not
 * what a security boundary should be: the whole verification is a keyed hash and
 * a constant-time comparison, and owning it keeps the property readable in one
 * function rather than inferable from a version range.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The header GitHub carries the signature on, lower-cased because that is how
 * `Headers.get` normalizes it and how every comparison here is written.
 */
export const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * The algorithm prefix GitHub prepends to the digest. It is part of the signed
 * comparison rather than something to strip and discard: leaving it in is what
 * makes `sha1=...`, the retired scheme GitHub still sends on
 * `X-Hub-Signature`, fail here rather than being read as a bare digest.
 */
export const SIGNATURE_PREFIX = "sha256=";

/** The header value GitHub computes for a body, in full. */
export const signDelivery = (secret: string, body: Uint8Array): string =>
  `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A delivery's raw bytes and the signature offered for them. */
export interface OfferedSignature {
  /** The webhook secret the App was registered with. */
  readonly secret: string;
  /** The exact bytes received, before any parse. */
  readonly body: Uint8Array;
  /** The `X-Hub-Signature-256` header as it arrived, or null when absent. */
  readonly signature: string | null;
}

/**
 * Whether the offered signature is the one this secret produces over these
 * bytes.
 *
 * Every malformed shape - an absent header, an empty one, a bare digest, the
 * retired `sha1` scheme, a truncated digest - is a `false` rather than a throw,
 * because the caller turns this into a status and has nothing to do with an
 * exception.
 *
 * @param offered The bytes received and the signature offered for them.
 * @returns True only when the signature matches the bytes exactly.
 */
export const isSignatureValid = (offered: OfferedSignature): boolean => {
  if (offered.signature === null || offered.signature === "") {
    return false;
  }

  const expected = Buffer.from(signDelivery(offered.secret, offered.body));
  const received = Buffer.from(offered.signature);

  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // so the lengths are checked first. That leaks nothing: the digest's length
  // is fixed by the algorithm and the prefix is a public constant, so a
  // mismatch says only that the header was malformed - never anything about
  // the secret or the expected digest.
  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
};
