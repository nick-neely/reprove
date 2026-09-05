/**
 * The third of [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s
 * implementation notes: reject an oversized body **before** hashing it.
 *
 * "Before hashing" is a claim about what the process does with the bytes, not
 * only about the status it returns, so the cases below check that an oversized
 * body is refused without being accumulated and that the stream is cancelled
 * rather than drained.
 */
import { describe, expect, it } from "vitest";

import { readBoundedBody } from "./body.js";

const LIMIT = 64;

const bodyOf = (
  bytes: Uint8Array,
  headers: Record<string, string> = {}
): Request =>
  new Request("https://reprove.test/api/github/webhook", {
    method: "POST",
    headers,
    body: bytes,
  });

describe("reading a delivery body under a cap", () => {
  it("returns the exact bytes when the body fits", async () => {
    const sent = new TextEncoder().encode('{"action":"opened"}');

    const read = await readBoundedBody(bodyOf(sent), LIMIT);

    expect(read.kind).toBe("bytes");
    expect(read.kind === "bytes" && read.bytes).toStrictEqual(sent);
  });

  it("accepts a body of exactly the cap", async () => {
    const read = await readBoundedBody(bodyOf(new Uint8Array(LIMIT)), LIMIT);

    expect(read.kind).toBe("bytes");
  });

  it("refuses a body one byte over the cap", async () => {
    const read = await readBoundedBody(
      bodyOf(new Uint8Array(LIMIT + 1)),
      LIMIT
    );

    expect(read).toStrictEqual({ kind: "oversized", limit: LIMIT });
  });

  it("refuses on a declared length, whatever the body then turns out to be", () => {
    // The body here is tiny and the declared length is not, so a refusal can
    // only have come from the header. A sender that describes an oversized
    // body has already said enough to be turned away.
    const request = bodyOf(new Uint8Array(8), {
      "content-length": String(LIMIT * 100),
    });

    return expect(readBoundedBody(request, LIMIT)).resolves.toStrictEqual({
      kind: "oversized",
      limit: LIMIT,
    });
  });

  it("refuses an endless stream that declares no length at all", async () => {
    // SAFETY: the Fetch standard requires `duplex` for a streaming request
    // body and the `RequestInit` typings do not carry it yet; `"half"` is the
    // only value the standard defines.
    const request = new Request("https://reprove.test/api/github/webhook", {
      method: "POST",
      // No `content-length`, and a stream that would never end. Trusting the
      // header alone would hand an unbounded body straight to the hash.
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(LIMIT));
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readBoundedBody(request, LIMIT)).resolves.toStrictEqual({
      kind: "oversized",
      limit: LIMIT,
    });
    // That this resolves at all is the assertion. The stream never ends, so a
    // reader that accumulated first and measured afterwards would hang here
    // until the test timed out, and `content-length` is absent so the cheap
    // check in front cannot be what refused it.
  });

  it("reads a body arriving in several chunks as one run of bytes", async () => {
    // SAFETY: the Fetch standard requires `duplex` for a streaming request
    // body and the `RequestInit` typings do not carry it yet; `"half"` is the
    // only value the standard defines.
    const request = new Request("https://reprove.test/api/github/webhook", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.enqueue(new Uint8Array([4, 5]));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const read = await readBoundedBody(request, LIMIT);

    expect(read.kind === "bytes" && read.bytes).toStrictEqual(
      new Uint8Array([1, 2, 3, 4, 5])
    );
  });

  it("reads a request with no body as no bytes", async () => {
    // SAFETY: the Fetch standard requires `duplex` for a streaming request
    // body and the `RequestInit` typings do not carry it yet; `"half"` is the
    // only value the standard defines.
    const request = new Request("https://reprove.test/api/github/webhook", {
      method: "POST",
    });

    const read = await readBoundedBody(request, LIMIT);

    expect(read.kind === "bytes" && read.bytes).toStrictEqual(new Uint8Array());
  });
});
