/**
 * Provenance, over the whole of ADR 0013's rule rather than its happy path.
 *
 * The cases that matter are the ones where a wrong answer is not visible: a
 * fork whose head repository happens to share a *name* with the base, an
 * association that reads like membership and is not, and a deleted fork whose
 * `head.repo` is null. Each of those is `external` and each would be `internal`
 * under a plausible misreading.
 */
import { describe, expect, it } from "vitest";

import type { CanonicalPullRequest } from "./canonical.js";
import { PROVENANCE_RULE_VERSION, provenanceOf } from "./provenance.js";

const SAME_REPOSITORY: CanonicalPullRequest = {
  number: 7,
  open: true,
  draft: false,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRepositoryId: 3001,
  headRepositoryId: 3001,
  authorId: 5005,
  authorAssociation: "MEMBER",
};

const provenanceFor = (
  overrides: Partial<CanonicalPullRequest>
): "internal" | "external" =>
  provenanceOf({ ...SAME_REPOSITORY, ...overrides }).provenance;

describe("provenance", () => {
  it("is internal for a branch of the same repository by a member", () => {
    expect(provenanceFor({})).toBe("internal");
  });

  it("is internal for the three associations that mean the same repository", () => {
    expect(
      ["OWNER", "MEMBER", "COLLABORATOR"].map((authorAssociation) =>
        provenanceFor({ authorAssociation })
      )
    ).toStrictEqual(["internal", "internal", "internal"]);
  });

  it("is external for every association below collaborator", () => {
    expect(
      ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"].map(
        (authorAssociation) => provenanceFor({ authorAssociation })
      )
    ).toStrictEqual(["external", "external", "external", "external"]);
  });

  it("is external for a fork, however trusted its author", () => {
    expect(
      provenanceFor({ headRepositoryId: 9009, authorAssociation: "OWNER" })
    ).toBe("external");
  });

  it("is external for a deleted fork, which names no head repository at all", () => {
    expect(
      provenanceFor({ headRepositoryId: null, authorAssociation: "OWNER" })
    ).toBe("external");
  });

  it("is external for an association GitHub has not defined yet", () => {
    expect(provenanceFor({ authorAssociation: "SOMETHING_NEW" })).toBe(
      "external"
    );
  });

  it("does not match a lower-cased association, because GitHub sends upper", () => {
    expect(provenanceFor({ authorAssociation: "member" })).toBe("external");
  });

  it("records the inputs it decided from, rather than prose about them", () => {
    expect(provenanceOf(SAME_REPOSITORY)).toStrictEqual({
      provenance: "internal",
      basis: {
        ruleVersion: PROVENANCE_RULE_VERSION,
        baseRepositoryId: 3001,
        headRepositoryId: 3001,
        authorAssociation: "MEMBER",
        authorId: 5005,
        matchedSameRepository: true,
        matchedAssociation: true,
      },
    });
  });

  it("records which half failed, so an external Run stays explainable", () => {
    expect(
      provenanceOf({
        ...SAME_REPOSITORY,
        headRepositoryId: 9009,
        authorAssociation: "OWNER",
      }).basis
    ).toMatchObject({
      headRepositoryId: 9009,
      matchedSameRepository: false,
      matchedAssociation: true,
    });
  });
});
