import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import { isSandboxCredentialPlaceholder } from "@ai-sdk/harness/utils";

import { boundPort } from "./tcp.js";

export interface ProxyRule {
  readonly origin: string;
  readonly method: string;
  readonly path: string;
}

export interface ProxyCredential {
  readonly origin: string;
  readonly placeholder: string;
  readonly secret: string;
}

export interface ProxyOptions {
  readonly rules: readonly ProxyRule[];
  readonly maxRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrency: number;
  readonly signal: AbortSignal;
  /** The external HTTP boundary; production uses the platform fetch. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

export interface HostProxy {
  readonly port: number;
  readonly certificate: Uint8Array;
  readonly credentials: (credentials: readonly ProxyCredential[]) => void;
  readonly close: () => Promise<void>;
}

const execute = promisify(execFile);
const FORWARDED_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "chatgpt-account-id",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
]);

const boundedBody = async (
  input: AsyncIterable<Uint8Array>,
  limit: number
): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new Error("proxy body limit exceeded");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const decodeRequest = (
  body: Buffer,
  encoding: string | string[] | undefined,
  limit: number
): Buffer => {
  if (encoding === undefined || encoding === "identity") {
    return body;
  }
  // Saved ChatGPT authentication uses zstd request compression. Decode before
  // policy/probe inspection and forwarding, with a separate decompressed cap.
  // A host whose Node has no zstd fails qualification rather than forwarding
  // compressed data while pretending it was inspected as JSON. Every Node the
  // `engines` floor admits has it; this stays a capability check rather than a
  // version check because it is the capability the decode needs.
  if (encoding !== "zstd" || !zlib.zstdDecompressSync) {
    throw new Error("unsupported request encoding");
  }
  return zlib.zstdDecompressSync(body, { maxOutputLength: limit });
};

const permittedTarget = (
  request: IncomingMessage,
  rules: readonly ProxyRule[],
  origin: string | undefined
): URL | null => {
  const target = origin
    ? new URL(request.url ?? "/", origin)
    : new URL(request.url ?? "");
  if (
    (origin && target.origin !== origin) ||
    target.username ||
    target.password ||
    target.hash ||
    target.search
  ) {
    return null;
  }
  return rules.some(
    (rule) =>
      rule.origin === target.origin &&
      rule.method === request.method &&
      rule.path === target.pathname
  )
    ? target
    : null;
};

const forwardedHeaders = (request: IncomingMessage): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      FORWARDED_HEADERS.has(name) &&
      value !== undefined &&
      !Array.isArray(value)
    ) {
      headers.set(name, value);
    }
  }
  return headers;
};

/** A fixed host/method/path allowlist, enforced after TLS termination. */
export const createHostProxy = async (
  options: ProxyOptions
): Promise<HostProxy> => {
  options.signal.throwIfAborted();
  for (const value of [
    options.maxRequests,
    options.maxRequestBytes,
    options.maxResponseBytes,
    options.maxConcurrency,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError("proxy limits must be positive integers");
    }
  }
  const origins = options.rules.map((rule) => new URL(rule.origin));
  for (const origin of origins) {
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.protocol !== "https:"
    ) {
      throw new TypeError(
        "a proxy rule must name an HTTPS origin without credentials"
      );
    }
  }
  if (origins.length === 0) {
    throw new TypeError("a proxy needs at least one allowed origin");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "reprove-proxy-"));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "ca.pem");
  const names = [...new Set(origins.map((origin) => origin.hostname))];
  // No caller text becomes an OpenSSL config fragment without this closed check.
  if (names.some((name) => !/^[a-zA-Z0-9.-]+$/u.test(name))) {
    await rm(directory, { recursive: true, force: true });
    throw new TypeError("unsupported proxy hostname");
  }
  let certificate: Buffer;
  let key: Buffer;
  let leaf: Buffer;
  try {
    await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=Reprove Pass proxy",
        "-addext",
        `subjectAltName=${names.map((name) => (/^\d+\.\d+\.\d+\.\d+$/u.test(name) ? `IP:${name}` : `DNS:${name}`)).join(",")}`,
      ],
      { signal: options.signal }
    );
    const leafKey = path.join(directory, "leaf-key.pem");
    const csr = path.join(directory, "leaf.csr");
    const leafCert = path.join(directory, "leaf.pem");
    const extensions = path.join(directory, "leaf.ext");
    await writeFile(
      extensions,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((name) => (/^\d+\.\d+\.\d+\.\d+$/u.test(name) ? `IP:${name}` : `DNS:${name}`)).join(",")}\n`
    );
    await execute(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-keyout",
        leafKey,
        "-out",
        csr,
        "-subj",
        "/CN=Reprove Pass endpoint",
      ],
      { signal: options.signal }
    );
    await execute(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        certPath,
        "-CAkey",
        keyPath,
        "-CAcreateserial",
        "-out",
        leafCert,
        "-days",
        "1",
        "-extfile",
        extensions,
      ],
      { signal: options.signal }
    );
    certificate = await readFile(certPath);
    key = await readFile(leafKey);
    leaf = await readFile(leafCert);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const context = createSecureContext({ key, cert: leaf });
  let credentials: readonly ProxyCredential[] = [];
  const sockets = new Set<Socket>();
  const connectedOrigin = new WeakMap<object, string>();
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let requests = 0;
  let active = 0;
  const forward = async (
    request: IncomingMessage,
    response: ServerResponse
  ) => {
    active += 1;
    requests += 1;
    try {
      if (
        signal.aborted ||
        active > options.maxConcurrency ||
        requests > options.maxRequests
      ) {
        response.writeHead(429).end();
        return;
      }
      const target = permittedTarget(
        request,
        options.rules,
        connectedOrigin.get(request.socket)
      );
      if (!target) {
        response.writeHead(403).end();
        return;
      }
      const headers = forwardedHeaders(request);
      const body = decodeRequest(
        await boundedBody(request, options.maxRequestBytes),
        request.headers["content-encoding"],
        options.maxRequestBytes
      );
      const credential = credentials.find(
        (entry) => entry.origin === target.origin
      );
      if (credential) {
        if (
          headers.get("authorization") !== `Bearer ${credential.placeholder}`
        ) {
          response.writeHead(403).end();
          return;
        }
        headers.set("authorization", `Bearer ${credential.secret}`);
      }
      const requestOptions: RequestInit = {
        method: request.method,
        headers,
        signal,
        redirect: "error",
      };
      if (body.length > 0) {
        requestOptions.body = new Uint8Array(body);
      }
      const upstream = await (options.fetch ?? fetch)(
        new Request(target, requestOptions)
      );
      let content = upstream.body
        ? await boundedBody(upstream.body, options.maxResponseBytes)
        : Buffer.alloc(0);
      // The broker does not turn a provider echo into a credential delivery.
      for (const entry of credentials) {
        if (content.includes(Buffer.from(entry.secret))) {
          content = Buffer.from(
            content.toString("utf-8").replaceAll(entry.secret, "[redacted]")
          );
        }
      }
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
      });
      response.end(content);
    } catch {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    } finally {
      active -= 1;
    }
  };
  const server = createServer((request, response) => {
    void forward(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (request, socket, head) => {
    const origin = origins.find(
      (candidate) =>
        candidate.protocol === "https:" &&
        candidate.host === (request.url ?? "")
    );
    // CONNECT normally includes :443 even when URL.host omits the default port.
    const matched =
      origin ??
      origins.find(
        (candidate) =>
          candidate.protocol === "https:" &&
          `${candidate.hostname}:${candidate.port || "443"}` === request.url
      );
    if (!matched || signal.aborted || head.length > 0) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tls = new TLSSocket(socket, {
      isServer: true,
      secureContext: context,
    });
    connectedOrigin.set(tls, matched.origin);
    tls.on("error", () => tls.destroy());
    server.emit("connection", tls);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = boundPort(server);
  const close = async () => {
    controller.abort();
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await promisify(server.close.bind(server))();
    }
    credentials = [];
  };
  const abort = () => {
    void close();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  return {
    port,
    certificate,
    credentials: (entries) => {
      for (const entry of entries) {
        if (
          !origins.some((origin) => origin.origin === entry.origin) ||
          !entry.secret ||
          !isSandboxCredentialPlaceholder(entry.placeholder)
        ) {
          throw new TypeError("invalid broker credential binding");
        }
      }
      credentials = entries.map((entry) => ({ ...entry }));
    },
    close: async () => {
      options.signal.removeEventListener("abort", abort);
      await close();
    },
  };
};
