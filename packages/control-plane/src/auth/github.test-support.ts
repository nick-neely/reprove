/**
 * GitHub, as a token response and two profile reads, and nothing else.
 *
 * The point of the composition test is what Better Auth does with a grant, so
 * GitHub is replaced at the only place it is reached from - `fetch` - rather
 * than by overriding a provider method, which would replace the code under
 * test. What the stub returns is the shape of a real GitHub App response,
 * including the two fields the App's "Expire user authorization tokens"
 * setting decides: `expires_in` and `refresh_token`.
 *
 * Not shipped: `tsconfig.build.json` keeps `*.test-support.ts` out of `dist`.
 */

/** GitHub's `POST /login/oauth/access_token` body, as JSON. */
export interface GitHubTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  /** Absent when the App does not expire user authorization tokens. */
  readonly expires_in?: number;
  /** Absent for the same reason. */
  readonly refresh_token?: string;
  readonly refresh_token_expires_in?: number;
}

/** Eight hours, which is what a GitHub App user access token actually lasts. */
export const ACCESS_TOKEN_TTL_SECONDS = 28_800;

/** Six months, which is what its refresh token lasts. */
export const REFRESH_TOKEN_TTL_SECONDS = 15_811_200;

/** The plaintext access token the encryption-at-rest case looks for. */
export const ACCESS_TOKEN = "gho_plaintext_access_token";
export const REFRESH_TOKEN = "ghr_plaintext_refresh_token";

/** A response from an App configured the way ADR 0008 assumes. */
export const EXPIRING_GRANT: GitHubTokenResponse = {
  access_token: ACCESS_TOKEN,
  token_type: "bearer",
  scope: "read:user,user:email",
  expires_in: ACCESS_TOKEN_TTL_SECONDS,
  refresh_token: REFRESH_TOKEN,
  refresh_token_expires_in: REFRESH_TOKEN_TTL_SECONDS,
};

/** What the same App returns with token expiration switched off. */
export const NON_EXPIRING_GRANT: GitHubTokenResponse = {
  access_token: ACCESS_TOKEN,
  token_type: "bearer",
  scope: "read:user,user:email",
};

/**
 * The other half of ADR 0008's condition, on its own: an access token that does
 * expire, with nothing to renew it. Not a shape a GitHub App produces today -
 * the setting decides both fields together - but the assertion names the two
 * separately, so each is measured separately. Reprove would otherwise hold a
 * credential that dies in eight hours with no way back.
 */
export const NO_REFRESH_GRANT: GitHubTokenResponse = {
  access_token: ACCESS_TOKEN,
  token_type: "bearer",
  scope: "read:user,user:email",
  expires_in: ACCESS_TOKEN_TTL_SECONDS,
};

/** One GitHub person, as `GET /user` reports them. */
export interface GitHubPerson {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly avatar_url: string;
}

export const PERSON: GitHubPerson = {
  id: 4242,
  login: "octocat",
  name: "Mona Octocat",
  email: "octocat@example.com",
  avatar_url: "https://avatars.example.invalid/octocat.png",
};

/**
 * A second person, who has never signed in. The refusal has two cases and they
 * are not the same write: a returning person's grant lands on an `account`
 * **update**, a newcomer's on an **insert** preceded by a `user` insert.
 */
export const NEWCOMER: GitHubPerson = {
  id: 7777,
  login: "hubot",
  name: "Hubot",
  email: "hubot@example.com",
  avatar_url: "https://avatars.example.invalid/hubot.png",
};

/** One entry of `GET /user/emails`. */
interface GitHubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

/** Every body this stub is allowed to answer with. */
type GitHubBody = GitHubEmail[] | GitHubPerson | GitHubTokenResponse;

const json = (body: GitHubBody): Response => Response.json(body);

/**
 * Installs a `fetch` that answers GitHub's three endpoints and refuses
 * everything else, so a request this test did not intend cannot quietly reach
 * the network.
 *
 * @param grant The token response GitHub should return.
 * @param person The GitHub person the profile endpoints should report.
 * @returns A function restoring the real `fetch`.
 */
export const stubGitHub = (
  grant: GitHubTokenResponse,
  person: GitHubPerson = PERSON
): (() => void) => {
  const real = globalThis.fetch;

  const stub = (input: Request | URL | string): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();

    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Promise.resolve(json(grant));
    }
    if (url === "https://api.github.com/user") {
      return Promise.resolve(json(person));
    }
    if (url === "https://api.github.com/user/emails") {
      return Promise.resolve(
        json([{ email: person.email, primary: true, verified: true }])
      );
    }
    return Promise.reject(
      new Error(`the test did not expect a request to ${url}`)
    );
  };

  // SAFETY: `stub` accepts every input `fetch` does and returns a `Response`.
  // The assertion only drops the `init` argument, which nothing here reads.
  globalThis.fetch = stub as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = real;
  };
};
