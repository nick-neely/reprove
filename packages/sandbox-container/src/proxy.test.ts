import { once } from "node:events";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vitest";

import { createHostProxy } from "./index.js";

describe("the host proxy", () => {
  it("refuses cleartext Provider origins before accepting credentials", async () => {
    await expect(
      createHostProxy({
        rules: [
          {
            origin: "http://provider.example",
            method: "POST",
            path: "/v1/responses",
          },
        ],
        maxRequests: 1,
        maxConcurrency: 1,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("HTTPS origin");
  });

  it("brokers only the allowed endpoint and removes a reflected credential", async () => {
    const seen: string[] = [];
    const origin = "https://provider.example";
    const placeholder = `aisdkhc_${"a".repeat(43)}`;
    const proxy = await createHostProxy({
      rules: [{ origin, method: "POST", path: "/v1/responses" }],
      fetch: (incoming) => {
        seen.push(
          `${incoming.method} ${new URL(incoming.url).pathname} ${incoming.headers.get("authorization")}`
        );
        return Promise.resolve(
          new Response(incoming.headers.get("authorization"))
        );
      },
      maxRequests: 4,
      maxConcurrency: 2,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      signal: new AbortController().signal,
    });
    const send = async (method: string, path: string) => {
      const outgoing = request({
        hostname: "127.0.0.1",
        port: proxy.port,
        method,
        path: origin + path,
        headers: { authorization: `Bearer ${placeholder}` },
      });
      const received = once(outgoing, "response");
      outgoing.end();
      // SAFETY: Node's response event carries exactly one IncomingMessage.
      const [incoming] = (await received) as [IncomingMessage];
      return { status: incoming.statusCode, body: await text(incoming) };
    };
    try {
      proxy.credentials([{ origin, placeholder, secret: "only-on-worker" }]);
      await expect(send("POST", "/v1/responses")).resolves.toStrictEqual({
        status: 200,
        body: "Bearer [redacted]",
      });
      await expect(send("DELETE", "/v1/responses")).resolves.toStrictEqual({
        status: 403,
        body: "",
      });
      await expect(send("POST", "/v1/files")).resolves.toStrictEqual({
        status: 403,
        body: "",
      });
      expect(seen).toStrictEqual(["POST /v1/responses Bearer only-on-worker"]);
    } finally {
      await proxy.close();
    }
  });
});
