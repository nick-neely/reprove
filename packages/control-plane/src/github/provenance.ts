/**
 * Where the code under review came from, computed rather than configured.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * states the rule and the reason it is computed **from the canonical response
 * fetched inside the critical section**, "so it is fresh rather than
 * event-stale":
 *
 * ```text
 * internal  iff  head.repo.id is present
 *           and  head.repo.id === base.repo.id
 *           and  author_association in { OWNER, MEMBER, COLLABORATOR }
 * external  otherwise
 * ```
 *
 * Repository **numeric ids, never names**, so a rename cannot flip a
 * classification, and a deleted fork - `head.repo == null` - is `external`
 * along with `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER` and `NONE`.
 * Anything GitHub adds to that vocabulary later is `external` too, because the
 * allowlist is the safe direction to be wrong in.
 *
 * **The live collaborator-permission endpoint is the rejected alternative, and
 * its absence is an accepted consequence rather than a gap.** It would
 * additionally distinguish a read-only collaborator from one who can push, and
 * ADR 0008 establishes that it needs only `Metadata: read`, so it is available.
 * It is not used because `CONTEXT.md` says collaborator, not write-capable
 * collaborator, and Provenance "classifies risk rather than conferring safety".
 * If it should later mean "could push the head branch", that is a new
 * {@link PROVENANCE_RULE_VERSION} and old Runs stay explainable - which is the
 * entire reason ADR 0007 kept `provenanceBasis`.
 *
 * The basis persists the **inputs** rather than prose reconstructed later, for
 * the same reason: a sentence explaining a decision is written against today's
 * rule, and the rule is the thing that changes.
 */
import type { CanonicalPullRequest } from "./canonical.js";

/**
 * Which rule produced a classification. It is on every basis so that a Run
 * classified under an older rule is still readable as what it was, rather than
 * being reinterpreted under whatever the rule became.
 */
export const PROVENANCE_RULE_VERSION = 1;

/**
 * The associations that mean the Author is inside the Repository. Matched
 * exactly and case-sensitively, because GitHub sends them upper-cased and a
 * case-insensitive match would silently widen the set the day a payload arrived
 * spelled differently.
 */
const INSIDE_THE_REPOSITORY: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

/** ADR 0007's `provenanceBasis`, which is the inputs and the two matches. */
export interface ProvenanceBasis {
  readonly ruleVersion: number;
  readonly baseRepositoryId: number;
  readonly headRepositoryId: number | null;
  readonly authorAssociation: string;
  readonly authorId: number;
  readonly matchedSameRepository: boolean;
  readonly matchedAssociation: boolean;
}

/** The classification and everything it was reached from. */
export interface ProvenanceDecision {
  readonly provenance: "internal" | "external";
  readonly basis: ProvenanceBasis;
}

/**
 * Classifies one pull request's canonical state.
 *
 * @param pullRequest Canonical state, as the fetch inside the lock read it.
 * @returns The classification and the basis to persist beside it.
 */
export const provenanceOf = (
  pullRequest: CanonicalPullRequest
): ProvenanceDecision => {
  const matchedSameRepository =
    pullRequest.headRepositoryId !== null &&
    pullRequest.headRepositoryId === pullRequest.baseRepositoryId;
  const matchedAssociation = INSIDE_THE_REPOSITORY.has(
    pullRequest.authorAssociation
  );

  return {
    provenance:
      matchedSameRepository && matchedAssociation ? "internal" : "external",
    basis: {
      ruleVersion: PROVENANCE_RULE_VERSION,
      baseRepositoryId: pullRequest.baseRepositoryId,
      headRepositoryId: pullRequest.headRepositoryId,
      authorAssociation: pullRequest.authorAssociation,
      authorId: pullRequest.authorId,
      matchedSameRepository,
      matchedAssociation,
    },
  };
};
