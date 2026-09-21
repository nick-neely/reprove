Throwaway prototype. It exists to answer issue #111 ("How should a Run look on the pull request?") and is deleted with its branch; nothing here is production code, nothing is tested, nothing persists, and no abstraction in it is meant to survive.

## Run it

```sh
pnpm proto:111
open packages/control-plane/prototype-111-publication/out/index.html
```

`out/` is committed, because the artifact a human opens is the point.

## What it produces

- `out/<variant>/<scenario>/review.md`, `comment-N.md`, `check.md` - raw GitHub-flavored markdown, postable to a real pull request verbatim.
- `out/index.html` - one self-contained page, no network, no build step. Left list switches scenario, the floating bar (or the `D` / `A` / `C` keys, or `?variant=`) switches variant; `D` is the default. Each scenario shows the Review, every Comment under its fake diff hunk, every Check with its annotations and a visible Re-run affordance, and a panel naming the `publication` and `finding` rows the control plane would write.

The build asserts GitHub's documented write-surface limits and prints violations: Check `summary` and `text` at 65535 characters, 50 annotations per request, a 255-character annotation title, and that every Comment's anchor line falls inside a hunk. That last check caught a real fixture error on the first run.

## The variants

**D is the default.** A and C are kept only so the composite can be compared against the two it came from. B (narrative) was rejected and deleted: prose blobs cannot be read at a glance.

| | hierarchy | Review body | Comment | Check |
| --- | --- | --- | --- | --- |
| **D** composite | C's index with A's verdict line and facts table; no prose anywhere | verdict line, then an index row per Finding including out-of-diff and carried-over ones; `unfinished`, Limitations and the below-Threshold count as labelled lines | glanceable header line (Severity square, Verification mark, title), the consequence, Evidence in `<details>` | `title` carries the verdict, `summary` is the verdict line plus the facts table, `text` is the full ledger including unpublished Findings |
| **A** terse | one-line verdict, then fields | verdict line, out-of-diff Findings as a compact list, one facts table | severity/verification tag, claim, Evidence in `<details>` | everything in `summary`, `text` is `null` |
| **C** ledger | nothing is prose | an index table of every Finding with links | a fields table plus an Evidence table | `summary` is a status table, `text` is the full ledger |

D and C both contradict ADR 0007's "a Finding outside the diff renders as a structured entry in the Review body": the write-surface research found annotations anchor at any `path:line` with no diff-membership requirement and priced the option at zero. In D the Review index still carries a row for each of them, marked "outside the diff" and linking to the Checks tab, so the Review stays a complete index while the exact line lives where GitHub can actually point at it.

### Emoji set in D, complete and closed

| mark | means |
| --- | --- |
| 🟥 🟧 🟨 ⬜ | Severity: `critical`, `high`, `medium`, `low` |
| ✅ | `verified` - something was executed and its output demonstrates the claim |
| ❌ | `inconclusive` - something was executed and failed to settle the claim |

`static` carries no mark at all, because a check or a cross would both imply an execution that never happened. There is no warning sign and nothing decorative. The status icons in the mock Checks chrome of `index.html` are GitHub's own UI, not content D emits.

### Decisions applied in D

1. Out-of-diff Findings are Check annotations; the Review index lists them as a row marked "outside the diff".
2. Earlier Findings that stopped being reported get a count line and a collapsed list. `anchor_changed` and `not_reproduced` never reach the surface.
3. A recurring Finding keeps its index row, marked "still open from the previous review" and linking the prior Comment; its Comment stays suppressed.
4. A no-op re-run puts the reason in the Check **title**, because the conclusion is re-asserted unchanged and the colour cannot carry it.
5. `publication` is one row per published Check, always carrying the Check Run id, the check suite id and an `external_id` of `reprove.run.<id>`, `reprove.refusal.<id>` or `reprove.config.<id>`. `github_review_id` is nullable.
6. The `Reprove config` Check publishes from an Owner-scoped config validation record, the third subject a `publication` row can have.
7. Narrowing is against the Reprove boundary only, and is labelled as such, because Phase 1 has no Owner layer.
8. `claimed` renders as Check status `queued`. A control-plane Refusal names its key path, and a line number only when the record has one. Below-Threshold Findings are a count line in the Review and full rows in the Check ledger. Qualification is labelled as the Lineage's.

## Files

- `types.ts` - shapes mirroring the protocol and the schema. Nothing imports either package: this folder must not join the ADR 0010 dependency graph.
- `fixtures.ts` - the thirteen scenarios (S1-S11, C1, C2) and their expected `publication` / `finding` rows.
- `variant-d.ts`, `variant-a.ts`, `variant-c.ts` - one `render(scenario)` each. `variant-b.ts` was deleted in round 2.
- `markdown.ts` - a vendored markdown subset renderer, so the prototype adds no dependency.
- `build.ts` - writes `out/`.
