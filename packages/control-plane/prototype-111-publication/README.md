Throwaway prototype. It exists to answer issue #111 ("How should a Run look on the pull request?") and is deleted with its branch; nothing here is production code, nothing is tested, nothing persists, and no abstraction in it is meant to survive.

## Run it

```sh
pnpm proto:111
open packages/control-plane/prototype-111-publication/out/index.html
```

`out/` is committed, because the artifact a human opens is the point.

## What it produces

- `out/<variant>/<scenario>/review.md`, `comment-N.md`, `check.md` - raw GitHub-flavored markdown, postable to a real pull request verbatim.
- `out/index.html` - one self-contained page, no network, no build step. Left list switches scenario, the floating bar (or the `A` / `B` / `C` keys, or `?variant=`) switches variant. Each scenario shows the Review, every Comment under its fake diff hunk, every Check with its annotations and a visible Re-run affordance, and a panel naming the `publication` and `finding` rows the control plane would write.

The build asserts GitHub's documented write-surface limits and prints violations: Check `summary` and `text` at 65535 characters, 50 annotations per request, a 255-character annotation title, and that every Comment's anchor line falls inside a hunk. That last check caught a real fixture error on the first run.

## The three variants

| | hierarchy | Review body | Comment | Check |
| --- | --- | --- | --- | --- |
| **A** terse | one-line verdict, then fields | verdict line, out-of-diff Findings as a compact list, one facts table | severity/verification tag, claim, Evidence in `<details>` | everything in `summary`, `text` is `null` |
| **B** narrative | prose first, fields last | the Reviewer's own summary as the opening paragraph, every operational fact written as a sentence, facts as one `<sub>` footer | prose, Evidence inline and always visible | two sentences in `summary`, the explanation in `text` |
| **C** ledger | nothing is prose | an index table of every Finding with links | a fields table plus an Evidence table | `summary` is a status table, `text` is the full ledger including suppressed Findings, out-of-diff Findings are **annotations** rather than review-body entries |

C deliberately contradicts ADR 0007's "a Finding outside the diff renders as a structured entry in the Review body". The write-surface research found annotations anchor at any `path:line` with no diff-membership requirement and priced the option at zero; C is what taking that option looks like, so the trade can be judged rather than argued.

## Files

- `types.ts` - shapes mirroring the protocol and the schema. Nothing imports either package: this folder must not join the ADR 0010 dependency graph.
- `fixtures.ts` - the thirteen scenarios (S1-S11, C1, C2) and their expected `publication` / `finding` rows.
- `variant-a.ts`, `variant-b.ts`, `variant-c.ts` - one `render(scenario)` each.
- `markdown.ts` - a vendored markdown subset renderer, so the prototype adds no dependency.
- `build.ts` - writes `out/`.
