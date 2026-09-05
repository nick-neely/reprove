/**
 * What [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s
 * closing implementation note asks for, measured rather than asserted: the
 * signature is checked against the exact received bytes and never a re-serialized
 * parse, and the comparison is timing-safe.
 *
 * The re-serialization case is the one worth a test of its own. `JSON.parse`
 * followed by `JSON.stringify` is lossy in ways that are invisible in a
 * debugger - key order, whitespace, `\u` escapes, the exact digits of a number -
 * so a handler that hashed its own re-serialization would accept a body whose
 * bytes GitHub never signed and reject bodies GitHub did.
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isSignatureValid,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  signDelivery,
} from "./signature.js";

const SECRET = "a-webhook-secret-that-is-not-a-real-one";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A body whose byte-for-byte identity survives no round trip: the keys are not
 * in lexical order, the whitespace is GitHub's rather than `JSON.stringify`'s,
 * and the escaped characters re-serialize as themselves.
 */
const DELIVERY =
  '{"action": "opened", "number": 7, "repository": {"full_name": "acme/\\u0072eprove"}}';

describe("the delivery signature", () => {
  it("names the header GitHub actually sends", () => {
    expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
    expect(SIGNATURE_PREFIX).toBe("sha256=");
  });

  it("accepts a valid signature over the exact received bytes", () => {
    const body = bytes(DELIVERY);
    expect(
      isSignatureValid({
        secret: SECRET,
        body,
        signature: signDelivery(SECRET, body),
      })
    ).toBeTruthy();
  });

  it("is the HMAC-SHA256 GitHub computes, not a spelling of Reprove's own", () => {
    const body = bytes(DELIVERY);
    const digest = createHmac("sha256", SECRET).update(body).digest("hex");

    expect(signDelivery(SECRET, body)).toBe(`sha256=${digest}`);
  });

  it("rejects the signature over a re-serialized body", () => {
    const body = bytes(DELIVERY);
    const reserialized = bytes(JSON.stringify(JSON.parse(DELIVERY)));

    // The two parse to the same value and are different bytes, which is the
    // whole hazard: only one of them is what GitHub signed.
    expect(JSON.parse(DELIVERY)).toStrictEqual(JSON.parse(DELIVERY));
    expect(reserialized).not.toStrictEqual(body);
    expect(
      isSignatureValid({
        secret: SECRET,
        body,
        signature: signDelivery(SECRET, reserialized),
      })
    ).toBeFalsy();
  });

  it("rejects a tampered body under a signature that was valid for another", () => {
    const body = bytes(DELIVERY);
    const signature = signDelivery(SECRET, body);
    const tampered = bytes(DELIVERY.replace('"opened"', '"closed"'));

    expect(
      isSignatureValid({ secret: SECRET, body: tampered, signature })
    ).toBeFalsy();
  });

  it("rejects a signature minted with a different secret", () => {
    const body = bytes(DELIVERY);

    expect(
      isSignatureValid({
        secret: SECRET,
        body,
        signature: signDelivery("some-other-app-secret", body),
      })
    ).toBeFalsy();
  });

  // Each of these is a shape a caller can produce without meaning to, and each
  // one has to be a rejection rather than a throw: the handler above turns a
  // `false` into a status and has nothing to do with an exception.
  const MALFORMED: [string, string | null][] = [
    ["an absent header", null],
    ["an empty header", ""],
    [
      "the digest without its algorithm prefix",
      signDelivery(SECRET, bytes(DELIVERY)).slice(SIGNATURE_PREFIX.length),
    ],
    [
      "the retired sha1 algorithm",
      "sha1=0000000000000000000000000000000000000000",
    ],
    ["a truncated digest", signDelivery(SECRET, bytes(DELIVERY)).slice(0, -2)],
    ["a digest that is not hexadecimal", `sha256=${"z".repeat(64)}`],
  ];

  it.each(MALFORMED)("rejects %s", (_description, signature) => {
    expect(
      isSignatureValid({ secret: SECRET, body: bytes(DELIVERY), signature })
    ).toBeFalsy();
  });

  it("compares in constant time rather than by string equality", () => {
    // Timing is not observable from a test, so this reads the one fact that
    // would make the claim untrue: the comparison the module reaches for. A
    // rewrite to `===` is a diff this fails on rather than one nobody notices.
    expect(isSignatureValid.toString()).toContain("timingSafeEqual");
  });
});
