/**
 * The canonical fetch, measured at the transport.
 *
 * ADR 0016 fixes exactly this seam: "**only GitHub's own API is substituted,
 * and only at the transport**... so the App-auth exchange, the request shape
 * and the response parsing all execute; what is canned is the response body."
 * So every case here drives the real client with a real key and asserts the
 * requests it actually issued, rather than stubbing the client itself.
 *
 * The classification cases are the reason the seam is worth this much: ADR 0013
 * classifies retryability **by typed cause, never by HTTP status**, and the two
 * `403`s below - one a missing permission, one secondary rate limiting - are
 * the pair that makes "all 401/403 retry with backoff" an invisible loop.
 */
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createGitHubClient } from "./client.js";
import type { JsonValue } from "./json.js";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();

const TOKEN = "ghs_an_installation_token";

const CANONICAL = {
  number: 7,
  state: "open",
  draft: false,
  head: { sha: "b".repeat(40), repo: { id: 3001 } },
  base: { sha: "a".repeat(40), repo: { id: 3001 } },
  user: { id: 5005 },
  author_association: "MEMBER",
};

const REQUEST = {
  installationId: 42,
  repositoryNameWithOwner: "acme/reprove",
  pullRequestNumber: 7,
};

const json = (
  status: number,
  body: JsonValue,
  headers: Readonly<Record<string, string>> = {}
) =>
  Response.json(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Records every request issued and answers each one from the list given. */
const transport = (...answers: readonly Response[]) => {
  const issued: Request[] = [];
  const remaining = [...answers];
  return {
    issued,
    fetch: (request: Request): Promise<Response> => {
      issued.push(request);
      const answer = remaining.shift();
      if (answer === undefined) {
        throw new Error(
          `no canned answer for ${request.method} ${request.url}`
        );
      }
      return Promise.resolve(answer);
    },
  };
};

const clientOver = (...answers: readonly Response[]) => {
  const wire = transport(...answers);
  return {
    ...wire,
    client: createGitHubClient({
      appId: "1234",
      privateKey: PRIVATE_KEY,
      fetch: wire.fetch,
    }),
  };
};

/** The token exchange, answered so a case can be about the fetch after it. */
const tokenIssued = () =>
  json(201, { token: TOKEN, expires_at: "2026-02-01T13:00:00Z" });

describe("the canonical fetch", () => {
  it("exchanges an App JWT for an installation token, then reads the pull request", async () => {
    const { client } = clientOver(tokenIssued(), json(200, CANONICAL));

    const outcome = await client.canonicalPullRequest(REQUEST);

    expect(outcome).toStrictEqual({
      kind: "canonical",
      pullRequest: {
        number: 7,
        open: true,
        draft: false,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        baseRepositoryId: 3001,
        headRepositoryId: 3001,
        authorId: 5005,
        authorAssociation: "MEMBER",
      },
    });
  });

  it("addresses the installation token exchange with the App JWT", async () => {
    const { client, issued } = clientOver(tokenIssued(), json(200, CANONICAL));

    await client.canonicalPullRequest(REQUEST);

    const [exchange] = issued;
    expect(exchange?.method).toBe("POST");
    expect(exchange?.url).toBe(
      "https://api.github.com/app/installations/42/access_tokens"
    );
    expect(exchange?.headers.get("authorization")).toMatch(
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u
    );
  });

  it("issues GET /repos/owner/name/pulls/{n} with the installation token", async () => {
    const { client, issued } = clientOver(tokenIssued(), json(200, CANONICAL));

    await client.canonicalPullRequest(REQUEST);

    const [, fetched] = issued;
    expect(fetched?.method).toBe("GET");
    expect(fetched?.url).toBe(
      "https://api.github.com/repos/acme/reprove/pulls/7"
    );
    expect(fetched?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(fetched?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(fetched?.headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("never sends the App JWT to the endpoint the installation token is for", async () => {
    const { client, issued } = clientOver(tokenIssued(), json(200, CANONICAL));

    await client.canonicalPullRequest(REQUEST);

    expect(issued[1]?.headers.get("authorization")).not.toBe(
      issued[0]?.headers.get("authorization")
    );
  });

  it("reads a closed draft from a fork with its head repository deleted", async () => {
    const { client } = clientOver(
      tokenIssued(),
      json(200, {
        ...CANONICAL,
        state: "closed",
        draft: true,
        head: { sha: "c".repeat(40), repo: null },
        author_association: "CONTRIBUTOR",
      })
    );

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "canonical",
      pullRequest: {
        number: 7,
        open: false,
        draft: true,
        baseSha: "a".repeat(40),
        headSha: "c".repeat(40),
        baseRepositoryId: 3001,
        headRepositoryId: null,
        authorId: 5005,
        authorAssociation: "CONTRIBUTOR",
      },
    });
  });

  it("treats an installation GitHub no longer has as a grant that is gone", async () => {
    const { client, issued } = clientOver(json(404, { message: "Not Found" }));

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "grant_gone",
      reason: expect.stringContaining("404"),
    });
    // The pull request is never asked for: there is no authority to ask with.
    expect(issued).toHaveLength(1);
  });

  it("treats a repository outside the grant as a grant that is gone", async () => {
    const { client } = clientOver(tokenIssued(), json(404, {}));

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "grant_gone",
      reason: expect.stringContaining("404"),
    });
  });

  it("classifies a missing permission as needing an operator, not a retry", async () => {
    const { client } = clientOver(
      tokenIssued(),
      json(403, { message: "Resource not accessible by integration" })
    );

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "operator_attention",
      reason: expect.stringContaining("Resource not accessible by integration"),
    });
  });

  it("classifies secondary rate limiting as transient, at the same status", async () => {
    const { client } = clientOver(
      tokenIssued(),
      json(
        403,
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        },
        { "retry-after": "60" }
      )
    );

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "transient",
      reason: expect.stringContaining("secondary rate limit"),
    });
  });

  it("classifies a primary rate limit with no quota left as transient", async () => {
    const { client } = clientOver(
      tokenIssued(),
      json(
        403,
        { message: "API rate limit exceeded" },
        {
          "x-ratelimit-remaining": "0",
        }
      )
    );

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toMatchObject({
      kind: "transient",
    });
  });

  it("classifies 429 and 5xx as transient", async () => {
    const outcomes = await Promise.all(
      [429, 500, 502, 503].map((status) => {
        const { client } = clientOver(tokenIssued(), json(status, {}));
        return client.canonicalPullRequest(REQUEST);
      })
    );

    expect(outcomes.map((outcome) => outcome.kind)).toStrictEqual([
      "transient",
      "transient",
      "transient",
      "transient",
    ]);
  });

  it("classifies a rejected App JWT as needing an operator", async () => {
    const { client } = clientOver(json(401, { message: "Bad credentials" }));

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toMatchObject({
      kind: "operator_attention",
    });
  });

  it("classifies a network failure as transient", async () => {
    const client = createGitHubClient({
      appId: "1234",
      privateKey: PRIVATE_KEY,
      fetch: () => Promise.reject(new Error("ECONNRESET")),
    });

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "transient",
      reason: expect.stringContaining("ECONNRESET"),
    });
  });

  it.each(["token exchange", "pull request"])(
    "classifies a failed %s response body as transient",
    async (stage) => {
      const failed = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("ECONNRESET during response body"));
          },
        }),
        { status: 200 }
      );
      const { client, issued } = clientOver(
        ...(stage === "token exchange" ? [failed] : [tokenIssued(), failed])
      );

      await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual(
        {
          kind: "transient",
          reason: "ECONNRESET during response body",
        }
      );
      expect(issued).toHaveLength(stage === "token exchange" ? 1 : 2);
    }
  );

  it("bounds the request with a signal rather than waiting on GitHub", async () => {
    const { client, issued } = clientOver(tokenIssued(), json(200, CANONICAL));

    await client.canonicalPullRequest(REQUEST);

    expect(issued[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(issued[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("needs an operator when the token exchange answers without a token", async () => {
    const { client } = clientOver(
      json(201, { expires_at: "2026-02-01T13:00:00Z" })
    );

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toMatchObject({
      kind: "operator_attention",
    });
  });

  it("needs an operator when the pull request is not the shape a Run needs", async () => {
    const { client } = clientOver(
      tokenIssued(),
      json(200, { ...CANONICAL, head: { sha: "not-a-sha" } })
    );

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toStrictEqual({
      kind: "operator_attention",
      reason: expect.stringContaining("head.sha"),
    });
  });

  it("refuses a repository locator that is not owner/name, rather than building a URL from it", async () => {
    const { client, issued } = clientOver();

    await expect(
      client.canonicalPullRequest({
        ...REQUEST,
        repositoryNameWithOwner: "../../app/installations",
      })
    ).resolves.toMatchObject({ kind: "operator_attention" });
    expect(issued).toHaveLength(0);
  });

  it("classifies a private key the deployment got wrong as needing an operator", async () => {
    // The credential cannot become valid on its own, so calling it transient
    // would retry a truncated PEM forever with no signal that anything is
    // wrong. It is also caught before the first request: `issued` is empty.
    const wire = transport();
    const client = createGitHubClient({
      appId: "1234",
      privateKey: PRIVATE_KEY.slice(0, 200),
      fetch: wire.fetch,
    });

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toMatchObject({
      kind: "operator_attention",
      reason: expect.stringContaining("App credential"),
    });
    expect(wire.issued).toHaveLength(0);
  });

  it("classifies an empty App id the same way, and asks GitHub nothing", async () => {
    const wire = transport();
    const client = createGitHubClient({
      appId: "",
      privateKey: PRIVATE_KEY,
      fetch: wire.fetch,
    });

    await expect(client.canonicalPullRequest(REQUEST)).resolves.toMatchObject({
      kind: "operator_attention",
    });
    expect(wire.issued).toHaveLength(0);
  });
});
