/**
 * GitHub, stood up on loopback for a test that runs the real workflows.
 *
 * Not shipped: `tsconfig.build.json` keeps it out of `dist`.
 *
 * ADR 0016 substitutes GitHub "only at the transport", and `@reprove/control-plane`
 * does that with an injected `fetch`. A step cannot be handed one: it resolves
 * its own configuration from the environment, in a module registry the test
 * does not share. So the substitution moves one layer out, to a real HTTP
 * server the step's real `fetch` reaches through `REPROVE_GITHUB_API_URL` -
 * which is the same seam the real-builder gate uses, for the same reason. The
 * App JWT, the installation-token exchange, the request line and the response
 * parsing all execute for real; only the two bodies are canned.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** The secret every delivery below is signed with. Not a real one. */
export const WEBHOOK_SECRET = "a-webhook-secret-that-is-not-a-real-one";

/** The App id the canned GitHub is told to expect. */
export const APP_ID = "1234";

/** A key of the test's own, so the App JWT is really signed and really parsed. */
export const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

/** What the canned GitHub says a pull request currently is. */
export interface CannedPullRequest {
  readonly headSha: string;
  readonly baseSha: string;
  readonly open: boolean;
  readonly draft: boolean;
}

/** What a pull request fetch does before it answers, if anything. */
export interface FetchBehaviour {
  /** Hold the answer this long, so a second delivery can contend for the lock. */
  readonly delayMs?: number;
}

/** One request the canned GitHub saw, for a case to assert on. */
export interface SeenRequest {
  readonly method: string;
  readonly path: string;
}

/** A canned GitHub, answering under a base URL a step can be pointed at. */
export interface CannedGitHub {
  readonly url: string;
  readonly seen: SeenRequest[];
  /** Sets what a pull request number answers with from now on. */
  readonly pullRequest: (
    number: number,
    state: CannedPullRequest,
    behaviour?: FetchBehaviour
  ) => void;
  readonly close: () => Promise<void>;
}

/** A JSON body as GitHub's REST API returns one, to the depth these need. */
interface CannedBody {
  readonly [key: string]: string | number | boolean | CannedBody;
}

interface CannedAnswer {
  readonly status: number;
  readonly body: CannedBody;
}

const REPOSITORY_ID = 3001;
const AUTHOR_ID = 5005;

const TOKEN_EXCHANGE = /^\/app\/installations\/\d+\/access_tokens$/u;
const PULL_REQUEST = /^\/repos\/[^/]+\/[^/]+\/pulls\/(?<number>\d+)$/u;

/**
 * Starts the canned GitHub on an ephemeral loopback port.
 *
 * @returns The server's URL, what it saw, and how to program it.
 */
export const startCannedGitHub = async (): Promise<CannedGitHub> => {
  const pullRequests = new Map<
    number,
    { state: CannedPullRequest; behaviour: FetchBehaviour }
  >();
  const seen: SeenRequest[] = [];

  const answer = async (
    method: string,
    path: string
  ): Promise<CannedAnswer> => {
    if (method === "POST" && TOKEN_EXCHANGE.test(path)) {
      return {
        status: 201,
        body: { token: "ghs_a_token", expires_at: "2026-02-01T13:00:00Z" },
      };
    }
    const pull = PULL_REQUEST.exec(path);
    if (method === "GET" && pull?.groups?.number) {
      const number = Number(pull.groups.number);
      const canned = pullRequests.get(number);
      if (!canned) {
        return { status: 404, body: { message: "Not Found" } };
      }
      if (canned.behaviour.delayMs) {
        await sleep(canned.behaviour.delayMs);
      }
      return {
        status: 200,
        body: {
          number,
          state: canned.state.open ? "open" : "closed",
          draft: canned.state.draft,
          head: { sha: canned.state.headSha, repo: { id: REPOSITORY_ID } },
          base: { sha: canned.state.baseSha, repo: { id: REPOSITORY_ID } },
          user: { id: AUTHOR_ID },
          author_association: "MEMBER",
        },
      };
    }
    return {
      status: 404,
      body: { message: `no canned answer for ${method} ${path}` },
    };
  };

  const serve = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    seen.push({ method, path });
    // Drain the body, or the socket stays half-open.
    for await (const _chunk of request) {
      // The canned GitHub reads nothing a request carries.
    }
    try {
      const { status, body } = await answer(method, path);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    } catch {
      response.writeHead(500);
      response.end();
    }
  };

  const server: Server = createServer((request, response) => {
    void serve(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: `address()` is a string only for a server listening on a pipe or a
  // Unix socket, and this one was just told to listen on a TCP port.
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    pullRequest: (number, state, behaviour = {}) => {
      pullRequests.set(number, { state, behaviour });
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

/** What a delivery names. */
export interface NamedDelivery {
  readonly action: string;
  readonly deliveryGuid: string;
  readonly ownerId: number;
  readonly repositoryId: number;
  readonly pullRequestNumber: number;
  readonly headSha: string;
}

/**
 * A signed `pull_request` delivery, as GitHub would post it.
 *
 * @param named What the delivery names.
 * @returns The request the webhook handler is given.
 */
export const signedDelivery = (named: NamedDelivery): Request => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      action: named.action,
      number: named.pullRequestNumber,
      installation: { id: 42 },
      repository: {
        id: named.repositoryId,
        full_name: "acme/reprove",
        owner: { id: named.ownerId, login: "acme", type: "Organization" },
      },
      pull_request: {
        number: named.pullRequestNumber,
        head: { sha: named.headSha },
      },
    })
  );
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  return new Request("https://reprove.test/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": named.deliveryGuid,
      "x-hub-signature-256": signature,
    },
    body,
  });
};
