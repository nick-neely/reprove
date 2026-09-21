<!-- name: Reprove -->
<!-- external_id: reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26 -->
<!-- status: completed conclusion: failure -->
<!-- title: unscheduled · 0 findings -->

## summary

| | |
| --- | --- |
| outcome | `unscheduled` -> `failure` |
| findings | 0 made, 0 commented |
| result | none accepted |
| review | not published |
| external_id | `reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26` |

## text

## Reason

The Worker refused to execute: policy_unenforceable.

Required: autonomy=inspect enforced by the Harness. Actual: codex 0.61.2 (artifact fingerprint sha256:4c19…a7) advertises no tool restriction below `verify`.

**Next step:** Change `review.autonomy`, or pin a Harness that can enforce it, then re-run this Check. Nothing is retried automatically: the attempt already spent a probe turn and a Sandbox.

## No Review

Nothing executed past the authorization line, so there is no Result and no Review.

## Terminal facts

| fact | value | provenance |
| --- | --- | --- |
| harness | `codex` | `configured` |
| model | `gpt-5.6-sol` | `configured` |
| autonomy | `inspect` | `configured` |
| deadline | `20m` | `configured` |
| duration | 41s | measured |
| usage | in 1,204 / out 96 / cached unknown / reasoning unknown (incomplete) | aggregate |
| estimated cost | unknown | `price-catalogue-2026-09-02` |
| qualification | `unqualified` | lineage |
| provider drift | none | observed |
