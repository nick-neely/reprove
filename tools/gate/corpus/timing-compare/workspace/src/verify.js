import { createHmac } from "node:crypto";

/**
 * Whether `signature` is the HMAC-SHA256 of `body` under `secret`.
 *
 * Signatures arrive hex-encoded in the `X-Signature` header.
 */
export const verifySignature = (secret, body, signature) => {
  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return expected === signature;
};
