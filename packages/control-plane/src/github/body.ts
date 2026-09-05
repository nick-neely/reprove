/**
 * Reading a delivery body under a hard cap, which is what runs in front of the
 * hash.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * asks for an oversized body to be rejected *before* hashing it, and that is a
 * statement about the bytes rather than about the status: `await
 * request.arrayBuffer()` followed by a length check has already accumulated
 * whatever was sent, so the cap it enforces is on what the handler proceeds
 * with rather than on what the process holds.
 *
 * So the body is read as a stream and abandoned the moment it passes the cap.
 * The declared `content-length` is consulted first because a sender that
 * describes an oversized body has already said enough, and it is never trusted
 * on its own, because a stream that lies about its length is exactly the shape
 * the cap exists for.
 */

/** A body that fitted, or the cap it broke. */
export type BoundedBody =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "oversized"; readonly limit: number };

/**
 * Whether a declared `content-length` already exceeds the cap.
 *
 * An absent, empty or unparseable header is not a refusal - it is simply no
 * information, and the streaming cap below is what answers instead.
 */
const declaredOverLimit = (request: Request, limit: number): boolean => {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > limit;
};

/**
 * Reads at most `limit` bytes of a request body.
 *
 * @param request The delivery, unread.
 * @param limit The largest body in bytes that may be accumulated.
 * @returns The exact bytes received, or the cap they broke.
 */
export const readBoundedBody = async (
  request: Request,
  limit: number
): Promise<BoundedBody> => {
  if (declaredOverLimit(request, limit)) {
    return { kind: "oversized", limit };
  }

  const stream = request.body;
  if (!stream) {
    return { kind: "bytes", bytes: new Uint8Array() };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  // Async iteration rather than a reader loop, because `break` is what makes
  // the refusal complete: it calls the iterator's `return`, which cancels the
  // stream, so an endless producer is told to stop rather than left enqueueing
  // into a reader nobody reads.
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > limit) {
      return { kind: "oversized", limit };
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { kind: "bytes", bytes };
};
