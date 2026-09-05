/**
 * The canonical parse, at the boundary rather than through the client.
 *
 * Everything here is a value a Run's immutable spec would otherwise be built
 * from: `baseSha` and `headSha` can never be corrected after creation, and
 * `authorId` is what makes a recorded `provenanceBasis` reconstructable. So each
 * case is a response that would read as plausible at a property access and is
 * refused at the parse.
 */
import { describe, expect, it } from "vitest";

import { readPullRequest } from "./canonical.js";
import type { JsonValue } from "./json.js";

/** One canned pull request response. */
interface CannedResponse {
  readonly [key: string]: JsonValue;
}

const RESPONSE = {
  number: 7,
  state: "open",
  draft: false,
  head: { sha: "b".repeat(40), repo: { id: 3001 } },
  base: { sha: "a".repeat(40), repo: { id: 3001 } },
  user: { id: 5005 },
  author_association: "OWNER",
};

/** A canned response body, as the transport would hand it over. */
const body = (response: CannedResponse): string => JSON.stringify(response);

const unreadable = (response: CannedResponse): string => {
  const parsed = readPullRequest(body(response));
  if (parsed.kind === "canonical") {
    throw new Error("expected the response to be refused, and it parsed");
  }
  return parsed.reason;
};

describe("canonical pull request state", () => {
  it("keeps GitHub's extra fields out rather than refusing them", () => {
    const parsed = readPullRequest(
      body({
        ...RESPONSE,
        title: "whatever the Author wrote",
        body: "and however much of it there is",
        _links: { self: { href: "https://api.github.com/..." } },
      })
    );

    expect(parsed).toStrictEqual({
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
        authorAssociation: "OWNER",
      },
    });
  });

  it("reads an absent draft flag as not a draft", () => {
    const { draft, ...withoutDraft } = RESPONSE;
    expect(readPullRequest(body(withoutDraft))).toMatchObject({
      pullRequest: { draft: false },
    });
    expect(draft).toBeFalsy();
  });

  it("reads any state other than open as closed", () => {
    expect(
      readPullRequest(body({ ...RESPONSE, state: "closed" }))
    ).toMatchObject({
      pullRequest: { open: false },
    });
  });

  it("refuses an omitted head repository instead of recording a deleted fork", () => {
    expect(
      unreadable({ ...RESPONSE, head: { sha: RESPONSE.head.sha } })
    ).toContain("head.repo");
  });

  it("refuses a head SHA that is not a full 40-character SHA", () => {
    expect(
      unreadable({ ...RESPONSE, head: { sha: "b1b2b3", repo: null } })
    ).toContain("head.sha");
  });

  it("refuses a repository id past the safe-integer range, which has already lost digits", () => {
    expect(
      unreadable({
        ...RESPONSE,
        base: {
          sha: "a".repeat(40),
          repo: { id: Number.MAX_SAFE_INTEGER + 2 },
        },
      })
    ).toContain("base.repo.id");
  });

  it("refuses a response with no author, because the basis records one", () => {
    const { user, ...withoutUser } = RESPONSE;
    expect(unreadable(withoutUser)).toContain("user");
    expect(user.id).toBe(5005);
  });

  it("refuses something that is not a pull request at all", () => {
    expect(unreadable({ message: "Not Found" })).not.toBe("");
  });
});
