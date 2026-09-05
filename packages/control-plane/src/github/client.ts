/**
 * The GitHub client, which is two requests and a classification.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * requires canonical state to be resolved "under installation authority", which
 * is App JWT then installation token then `GET
 * /repos/{owner}/{repo}/pulls/{number}`, and it fixes two things about how that
 * call may fail:
 *
 * ```text
 * network failure, 5xx, 429, identified secondary rate limiting -> transient
 * grant confirmed gone                                          -> grant_gone
 * auth or App configuration cannot establish access             -> operator_attention
 * ```
 *
 * > Retryability is classified by typed cause, never by HTTP status.
 *
 * The two `403`s are why. `403 Resource not accessible by integration` is a
 * missing permission and is permanent; a `403` carrying `retry-after` or an
 * exhausted quota is rate limiting and clears on its own. "All 401/403 retry
 * with backoff" retries the first forever and reports nothing, which is the
 * invisible loop ADR 0013 named.
 *
 * **Octokit is the rejected alternative**, and it is rejected for what it does
 * rather than for its size. Its app plugin brings a token cache, a retry plugin
 * and a throttling plugin whose defaults each contradict a decision above: it
 * would retry by status where ADR 0013 classifies by cause, and it would sleep
 * on a rate limit inside a transaction that is holding both an advisory lock and
 * a pooled connection. Turning three plugins off is more code than the fifty
 * lines below and leaves the behaviour a version bump from changing.
 *
 * `fetch` is injected rather than taken from the global for the same reason the
 * webhook's commit is a port: ADR 0016's acceptance scenario intercepts GitHub
 * "only at the transport", so the JWT, the exchange, the request shape and the
 * response parsing all execute for real against a canned body.
 */
import type { AppCredentials } from "./app-auth.js";
import { appJwt, readInstallationToken } from "./app-auth.js";
import type { CanonicalPullRequest } from "./canonical.js";
import { readPullRequest } from "./canonical.js";

/** GitHub's REST root. Overridden only by a test or by GitHub Enterprise. */
export const GITHUB_API_URL = "https://api.github.com";

/**
 * The hard client timeout ADR 0013 requires, per request.
 *
 * It is a **budget inside a transaction**, not a generous ceiling: the fetch
 * runs while an advisory lock and a pooled connection are both held, and ADR
 * 0013 backstops it with a transaction-local `idle_in_transaction_session_
 * timeout` set higher, "so application code normally aborts cleanly before
 * Postgres kills the session". Two requests at this budget still fit inside
 * that backstop.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** The response version GitHub asks every App to pin. */
const API_VERSION = "2022-11-28";

/** How much of an error body is quoted into a reason. */
const REASON_LIMIT = 300;

/**
 * `owner/name`, as GitHub spells a full name. It is checked rather than trusted
 * because the value travels from a webhook payload into a URL path: a locator
 * carrying `..` would otherwise address `/app/installations` with an
 * installation token, and a locator carrying `?` would address the right
 * repository with the wrong query.
 */
const FULL_NAME = /^[\w.-]+\/[\w.-]+$/u;

/** The injected transport. One `Request` in, one `Response` out. */
export type GitHubFetch = (request: Request) => Promise<Response>;

/** What the client is composed over. No value here is read from anywhere. */
export interface GitHubClientConfig extends AppCredentials {
  readonly fetch: GitHubFetch;
  /** Defaults to {@link GITHUB_API_URL}. */
  readonly baseUrl?: string;
  /** Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** The clock the App JWT is dated from. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** Which pull request, reached through which grant. */
export interface CanonicalRequest {
  readonly installationId: number;
  /** `owner/name`. */
  readonly repositoryNameWithOwner: string;
  readonly pullRequestNumber: number;
}

/**
 * What the fetch concluded, in ADR 0013's own vocabulary rather than in HTTP's.
 * Each failure maps onto exactly one ledger outcome, which is what stops the
 * classification being made twice in two places.
 */
export type CanonicalOutcome =
  | { readonly kind: "canonical"; readonly pullRequest: CanonicalPullRequest }
  /** Confirmed gone. Terminal: `discarded: grant_gone`. */
  | { readonly kind: "grant_gone"; readonly reason: string }
  /** Clears on its own. Nonterminal: `received`, `retryClass = transient`. */
  | { readonly kind: "transient"; readonly reason: string }
  /** A person has to act. Nonterminal: `received`, `operator_attention`. */
  | { readonly kind: "operator_attention"; readonly reason: string };

/** The one thing this client does. */
export interface GitHubClient {
  readonly canonicalPullRequest: (
    request: CanonicalRequest
  ) => Promise<CanonicalOutcome>;
}

const quote = (text: string): string =>
  text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}...` : text;

/**
 * Whether a `403` is rate limiting rather than a missing permission.
 *
 * All three signals, because GitHub answers with a different one depending on
 * which limit was hit: the primary limit reports an exhausted quota, secondary
 * limiting reports `retry-after`, and abuse detection reports neither and says
 * so in the body.
 */
const isRateLimited = (response: Response, body: string): boolean =>
  response.headers.get("retry-after") !== null ||
  response.headers.get("x-ratelimit-remaining") === "0" ||
  /rate limit/iu.test(body);

const classify = (
  response: Response,
  body: string,
  what: string
): CanonicalOutcome => {
  const reason = `${what} answered ${response.status}: ${quote(body)}`;
  if (response.status === 404) {
    // Under installation authority a repository outside the grant, a deleted
    // repository and a deleted installation are all `404`. ADR 0013 collapses
    // them deliberately: "canonical fetch fails conclusively -> not in scope;
    // create none".
    return { kind: "grant_gone", reason };
  }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "transient", reason };
  }
  if (response.status === 403 && isRateLimited(response, body)) {
    return { kind: "transient", reason };
  }
  return { kind: "operator_attention", reason };
};

/** The response body as text, whatever it turned out to be. */
const bodyOf = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Composes the client over an App's credentials and a transport.
 *
 * @param config The App id, its private key and the injected `fetch`.
 * @returns A client that resolves canonical pull request state.
 */
export const createGitHubClient = (
  config: GitHubClientConfig
): GitHubClient => {
  const baseUrl = (config.baseUrl ?? GITHUB_API_URL).replace(/\/+$/u, "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = config.now ?? (() => new Date());

  const send = (url: string, method: string, authorization: string) =>
    config.fetch(
      new Request(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization,
          "x-github-api-version": API_VERSION,
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
    );

  /**
   * The installation token, or the outcome that stands in for it. The App JWT
   * authorizes only this call and never leaves it: everything downstream
   * carries the installation token, which is scoped to one grant.
   */
  const installationToken = async (
    installationId: number
  ): Promise<{ token: string } | CanonicalOutcome> => {
    const response = await send(
      `${baseUrl}/app/installations/${installationId}/access_tokens`,
      "POST",
      `Bearer ${appJwt(config, now())}`
    );
    const body = await bodyOf(response);
    if (!response.ok) {
      return classify(response, body, "the installation token exchange");
    }

    const issued = readInstallationToken(body);
    if (issued.kind === "unreadable") {
      return {
        kind: "operator_attention",
        reason: `the installation token exchange answered ${response.status} with no usable token: ${quote(body)}`,
      };
    }
    return { token: issued.token };
  };

  const canonicalPullRequest = async (
    request: CanonicalRequest
  ): Promise<CanonicalOutcome> => {
    if (!FULL_NAME.test(request.repositoryNameWithOwner)) {
      return {
        kind: "operator_attention",
        reason: `the delivery's repository locator is not owner/name: ${quote(request.repositoryNameWithOwner)}`,
      };
    }

    try {
      const authorized = await installationToken(request.installationId);
      if (!("token" in authorized)) {
        return authorized;
      }

      const response = await send(
        `${baseUrl}/repos/${request.repositoryNameWithOwner}/pulls/${request.pullRequestNumber}`,
        "GET",
        `Bearer ${authorized.token}`
      );
      const body = await bodyOf(response);
      if (!response.ok) {
        return classify(response, body, "the canonical pull request fetch");
      }

      const parsed = readPullRequest(body);
      if (parsed.kind === "unreadable") {
        // Not transient and not a grant: GitHub answered, and the answer is not
        // the shape a Run can be built from. Retrying reaches it again.
        return {
          kind: "operator_attention",
          reason: `the canonical pull request is not the shape a Run needs: ${parsed.reason}`,
        };
      }
      return { kind: "canonical", pullRequest: parsed.pullRequest };
    } catch (error) {
      // A refused connection, a reset one, a body that is not JSON, and the
      // abort the timeout above raises. Every one of them is a request that did
      // not complete, which is ADR 0013's `transient` however it failed.
      return {
        kind: "transient",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return { canonicalPullRequest };
};
