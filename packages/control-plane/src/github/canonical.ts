/**
 * Canonical pull request state, as [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * defines it: "**the webhook payload is not the authority for the state a Run is
 * built from**", so `GET /repos/{owner}/{repo}/pulls/{number}` is read under
 * installation authority and *its* head SHA, base SHA, open state and draft
 * state are what a Run is built from.
 *
 * That is what makes delivery ordering stop being load-bearing. An old
 * redelivery cannot move a pull request backwards, a reordered `synchronize`
 * cannot resurrect an old head, a stale `closed` cannot cancel a Run for a pull
 * request that has since reopened, and a permanently lost intermediate
 * `synchronize` does not matter because the next delivery observes the same
 * current state.
 *
 * The response is **parsed** rather than read field by field, for the same
 * reason the webhook envelope is: a Run's `baseSha` and `headSha` are immutable
 * once written, so a field that merely looked right at the property access that
 * read it is a permanent wrong answer. Reading the whole response into a
 * domain-shaped record - rather than passing GitHub's own object inward - is
 * what keeps `head.repo == null` a *decided* case rather than an optional chain
 * somewhere downstream.
 *
 * `baseSha` is `base.sha`, the **base branch tip**, and deliberately not the
 * merge base. ADR 0013 rejected computing the merge base here: it needs the
 * compare endpoint, which drags `Contents: read` into the App's grant and puts a
 * second network call inside GitHub's ten-second wall, while ADR 0004 already
 * keeps `.git` in the Workspace so the merge base is derived where the object
 * graph is. The caveat is that `base.sha` moves with the base branch and the
 * recorded value is what the tip was when the delivery was processed; a push to
 * the base branch fires no `pull_request` event, so a Run's base never moves
 * after creation and the record is an honest statement rather than a stale one.
 */
import { z } from "zod";

import { parseBody } from "./json.js";

/** Same bound as the envelope's: a value past 2^53 has already lost digits. */
const githubIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Forty lowercase hex characters, which is what `@reprove/protocol`'s `RunSpec`
 * requires of `baseSha` and `headSha`. Checking it here rather than at the Run
 * insert is what keeps an unusable SHA a classified fetch outcome instead of a
 * database error inside the critical section.
 */
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

/**
 * The repository a ref lives in, by **numeric id**. ADR 0013 is explicit that
 * Provenance compares ids and never names, so a rename cannot flip a
 * classification.
 */
const refRepositorySchema = z.object({ id: githubIdSchema });

/**
 * Everything a Run is built from, and nothing else. Unrecognised keys are
 * dropped rather than rejected: this response carries well over a hundred
 * fields and GitHub adds more without warning.
 */
const pullRequestResponseSchema = z.object({
  number: githubIdSchema,
  state: z.string().min(1),
  /** Absent on a repository plan without draft pull requests. */
  draft: z.boolean().optional(),
  head: z.object({
    sha: shaSchema,
    /** `null` when the fork was deleted, which ADR 0013 classifies external. */
    repo: refRepositorySchema.nullable(),
  }),
  base: z.object({ sha: shaSchema, repo: refRepositorySchema }),
  /**
   * Required, and GitHub always sends it: a deleted account's pull requests are
   * reattributed to the `ghost` user rather than losing their author. A Run's
   * `provenanceBasis` records `authorId`, so an absent one is a basis that
   * cannot be reconstructed later.
   */
  user: z.object({ id: githubIdSchema }),
  author_association: z.string().min(1),
});

/** Canonical state, in Reprove's shape rather than GitHub's. */
export interface CanonicalPullRequest {
  readonly number: number;
  /** `state === "open"`. A merged pull request is closed. */
  readonly open: boolean;
  readonly draft: boolean;
  /** The base branch tip, not the merge base. */
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRepositoryId: number;
  /** `null` for a deleted fork. */
  readonly headRepositoryId: number | null;
  readonly authorId: number;
  readonly authorAssociation: string;
}

/** Canonical state, or the reason this response could not become it. */
export type ParsedPullRequest =
  | { readonly kind: "canonical"; readonly pullRequest: CanonicalPullRequest }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Reads a `GET /repos/{owner}/{repo}/pulls/{number}` body into canonical state.
 *
 * @param body The raw response body.
 * @returns The canonical state, or why there is none.
 */
export const readPullRequest = (body: string): ParsedPullRequest => {
  const parsed = parseBody(body, pullRequestResponseSchema);
  if (parsed.kind === "unreadable") {
    return parsed;
  }

  const { base, head, user } = parsed.value;
  return {
    kind: "canonical",
    pullRequest: {
      number: parsed.value.number,
      open: parsed.value.state === "open",
      draft: parsed.value.draft ?? false,
      baseSha: base.sha,
      headSha: head.sha,
      baseRepositoryId: base.repo.id,
      headRepositoryId: head.repo?.id ?? null,
      authorId: user.id,
      authorAssociation: parsed.value.author_association,
    },
  };
};
