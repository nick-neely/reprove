<!-- name: Reprove -->
<!-- external_id: reprove.run.4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa -->
<!-- status: completed conclusion: timed_out -->
<!-- title: incomplete · 0 findings -->

## summary

| | |
| --- | --- |
| outcome | `incomplete` -> `timed_out` |
| findings | 0 made, 0 commented |
| result | `partial` / `budget_exhausted` |
| review | not published |
| external_id | `reprove.run.4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa` |

## text

## Reason

The review stopped when it reached its budget.

The Run reached its configured `budget` after 14m 55s and made no claim before it did.

**Next step:** Raise `review.budget` in `.reprove.yml` on the base branch, or narrow the pull request, then re-run this Check.

## No Review

A partial Result carrying no Findings publishes no Review (ADR 0007): publishing it would assert a clean bill of health the Reviewer never gave.

## Terminal facts

| fact | value | provenance |
| --- | --- | --- |
| harness | `codex` | `configured` |
| model | `gpt-5.6-sol` | `configured` |
| autonomy | `verify` | `default` |
| deadline | `20m` | `configured` |
| duration | 14m 55s | measured |
| usage | in 612,400 / out 20,100 / cached 300,220 / reasoning 44,800 (complete) | aggregate |
| estimated cost | $5.02 | `price-catalogue-2026-09-02` |
| qualification | `unqualified` | lineage |
| provider drift | none | observed |
