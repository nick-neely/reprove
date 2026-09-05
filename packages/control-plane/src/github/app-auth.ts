/**
 * The App's own assertion of who it is, which is the first half of [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)'s
 * canonical fetch: "Run creation resolves `GET
 * /repos/{owner}/{repo}/pulls/{number}` under **installation authority**", and
 * installation authority is only reachable by presenting a JWT signed with the
 * App's private key and exchanging it for an installation token.
 *
 * It is **thirty lines of `node:crypto` rather than a dependency**, and that is
 * the rejected alternative rather than an oversight. Octokit's app plugin is the
 * obvious choice and brings a token cache, a rate limiter, retries and its own
 * fetch; every one of those is a behaviour ADR 0013 already decided differently
 * - retryability is classified by typed cause rather than by HTTP status, the
 * fetch is bounded by a hard client timeout inside a transaction that holds a
 * pooled connection, and the fetch itself is the injected seam ADR 0016's
 * acceptance scenario intercepts. Adopting a client whose defaults contradict
 * all three would mean configuring each of them off, which is more code than
 * this and leaves the behaviour a version bump away from changing.
 *
 * A JWS over two base64url segments is also the whole of what GitHub reads. No
 * claim here is optional, none is Reprove's, and there is nothing to negotiate.
 */
import { createSign } from "node:crypto";

import { z } from "zod";

/**
 * How far the `iat` claim is backdated. GitHub rejects a JWT whose `iat` is in
 * *its* future, and the two clocks are not the same clock; a minute is GitHub's
 * own documented recommendation for the gap.
 */
export const CLOCK_DRIFT_SECONDS = 60;

/**
 * The token's life, under GitHub's ten-minute ceiling with the backdating
 * already spent. Nine minutes rather than the ceiling, because a JWT that
 * expires exactly at the limit is one whose validity depends on the drift being
 * in the direction that helps.
 */
export const APP_JWT_LIFETIME_SECONDS = 9 * 60;

/** The App's identity, as the deployment configured it. */
export interface AppCredentials {
  /** GitHub's numeric App id, which is the JWT's `iss`. */
  readonly appId: string;
  /** The App's private key, PEM-encoded, in either PKCS#1 or PKCS#8. */
  readonly privateKey: string;
}

/** One JWS segment: the header, or the claim set. Both are flat. */
type Segment = Readonly<Record<string, string | number>>;

const encode = (segment: Segment): string =>
  Buffer.from(JSON.stringify(segment), "utf-8").toString("base64url");

/** Never returns; typed so the callers below read as expressions. */
const failing = (field: string, problem: string): never => {
  throw new TypeError(`AppCredentials.${field} ${problem}`);
};

/**
 * Mints the JWT the installation-token exchange is authorized by.
 *
 * @param credentials The App id and its PEM private key.
 * @param issuedAt The instant to date the assertion from.
 * @returns A compact JWS, ready for an `Authorization: Bearer` header.
 * @throws {TypeError} Naming the field, when the App id is empty or the private
 *   key is not a key. Both are deployment configuration, and a JWT built from
 *   either would fail at GitHub as an opaque `401` classified
 *   `operator_attention` - true, and several steps removed from the cause.
 */
export const appJwt = (credentials: AppCredentials, issuedAt: Date): string => {
  if (credentials.appId === "") {
    return failing("appId", "is empty");
  }

  const issued = Math.floor(issuedAt.getTime() / 1000) - CLOCK_DRIFT_SECONDS;
  const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: issued,
    exp: issued + APP_JWT_LIFETIME_SECONDS,
    iss: credentials.appId,
  })}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  let signature: Buffer;
  try {
    signature = signer.sign(credentials.privateKey);
  } catch (error) {
    return failing(
      "privateKey",
      `is not a PEM private key (${error instanceof Error ? error.message : String(error)})`
    );
  }

  return `${signingInput}.${signature.toString("base64url")}`;
};

/**
 * The exchange's answer, which is the one field Reprove uses. GitHub sends
 * `expires_at`, `permissions` and `repository_selection` beside it and none of
 * them is read: the token is used once, inside the transaction that asked for
 * it, so there is nothing here that a cache would need and nothing to keep.
 */
const installationTokenSchema = z.object({ token: z.string().min(1) });

/** An installation token, or the reason this response carried none. */
export type IssuedInstallationToken =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Reads `POST /app/installations/{id}/access_tokens`'s body.
 *
 * @param body The raw response body.
 * @returns The token, or why there is none.
 */
export const readInstallationToken = (
  body: string
): IssuedInstallationToken => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `the response is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = installationTokenSchema.safeParse(json);
  return parsed.success
    ? { kind: "token", token: parsed.data.token }
    : { kind: "unreadable", reason: "the response carries no token" };
};
