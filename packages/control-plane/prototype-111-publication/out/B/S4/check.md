<!-- name: Reprove -->
<!-- external_id: reprove.run.4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa -->
<!-- status: completed conclusion: timed_out -->
<!-- title: The review stopped when it reached its budget -->

## summary

The review stopped when it reached its budget.

The Run reached its configured `budget` after 14m 55s and made no claim before it did.

**What to do:** Raise `review.budget` in `.reprove.yml` on the base branch, or narrow the pull request, then re-run this Check.

No Review was published. A partial Result carrying no Findings publishes no Review (ADR 0007): publishing it would assert a clean bill of health the Reviewer never gave.

## text

## What ran

A codex Harness, named in `.reprove.yml`, driving gpt-5.6-sol (configured) at autonomy verify (default). Its deadline was 20m (configured) and it ran for 14m 55s.

## What it cost

Usage was in 612,400 / out 20,100 / cached 300,220 / reasoning 44,800 (complete). At `price-catalogue-2026-09-02` that is an estimated $5.02.

## Provenance

This lineage's qualification status is `unqualified`, which means it has never passed the adversarial gate. Provider drift: none.

<sub>external_id `reprove.run.4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa`</sub>
