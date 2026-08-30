# Who else reviews pull requests with coding agents?

Research for [#9](https://github.com/nick-neely/reprove/issues/9) (child of the foundation map [#1](https://github.com/nick-neely/reprove/issues/1)).
Surveyed 2026-08-29. Every star count, date and feature claim below was checked against the
GitHub API, repository READMEs or vendor documentation on that date.

**This file is a dated snapshot, not a position.** It rots faster than anything else in the
repository - the list it replaces was roughly half wrong within months of being written. The
durable claim about what Reprove combines lives in [`docs/prd.md`](../prd.md) §38; this file
only records who was doing what on the date in the heading. Re-verify before citing it after
~2026-11, and update *this* file rather than the PRD when the landscape moves.

Each claim is tagged **[V]** verified (API response, README quote, or vendor doc read on the
date above) or **[I]** inferred, labelled as such.

---

## 1. Verdict

**No project ships all four of Reprove's axes together.** Those axes are:

1. the user's choice of multiple full coding-agent Harnesses as the Reviewer;
2. cross-harness / adversarial review between them;
3. a real repository checkout in a Sandbox, with build and test execution as the evidentiary
   basis for a Finding;
4. both a hosted and a self-hosted Worker.

**[V]** `majiayu000/harness` is genuine prior art on three of the four and is the honest
overlap to acknowledge - not a strawman, and not something to pretend away. Everyone else
fails at least two axes, usually because they are solving a different problem.

Two corrections to the framing that motivated this survey:

- **"We run tests and they don't" is dead as a differentiator.** **[V]** CodeRabbit already
  runs reviews in an isolated microVM where it writes and executes shell scripts. The PRD's
  §38 instinct that execution alone is not a position was correct, and is now demonstrably so.
- **"Multi-harness plus cross-agent review" is no longer unclaimed.** **[V]** It is shipped,
  today, by at least one Apache/MIT project. What remains unclaimed is that combination
  *arriving automatically on a GitHub pull request, with execution-backed Findings, in a form
  a team can adopt without operating it themselves*.

---

## 2. The four projects the ticket named

### `majiayu000/harness` - the real overlap

**[V]** MIT, Rust. Created 2026-03-02. 64 stars, 5 forks, 42 open issues, 1 release,
last commit 2026-08-29 - actively developed, and appears to be a single-maintainer project.

| Axis | Status |
|---|---|
| Harness choice | **Yes**, and broader than the ticket claimed: Claude Code, Codex, OpenCode, plus a direct Anthropic-API adapter. |
| Cross-agent review | **Yes**, an explicit shipped feature: "automatic cross-agent code review between implementation and GitHub review, preventing self-review by architecture." |
| Real execution | **Yes.** Sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) enforced by Landlock/bwrap on Linux. Agents run real builds and tests in a workspace. |
| Hosted option | **No.** Self-host only - you stand up Postgres and the Rust server yourself via Docker Compose. |
| Auto-trigger on PRs | **Partly.** HMAC-verified webhooks parse `@harness` mentions in issue and PR comments; a separate "CI/CD GitHub Action" also exists. **[I]** Whether the Action path fires on a bare `pull_request: opened` without a mention could not be confirmed. |
| Credential isolation | Runs as an unprivileged OS user by default (`--drop-sudo=true`) with sandboxed filesystem and network. **[V]** The README states the provider credential is forwarded into the agent's container while "operator secrets remain filtered" - so the agent credential shares an environment with executing code. |

**Read:** this is what Reprove would be if it stopped at the architecture and skipped the
product. The gap is not the idea, it is that a team cannot adopt it as a turnkey reviewer
today: no hosted path, Postgres to operate, mention-gated triggering, and 64 stars of
production evidence.

### `razzant/claudexor` - different product category

**[V]** MIT, TypeScript. Created 2026-06-05 (under three months old). 425 stars, 40 forks,
v3.9.0 released 2026-08-29. Distributed via npm and a signed macOS DMG.

**[V]** The ticket's description of it is accurate almost verbatim - multi-harness (Codex,
Claude Code, Cursor, OpenCode, Antigravity/Gemini, raw API), quota-aware credential-profile
rotation across subscriptions, shared thread context, and best-of-N races with independent
reviewers and arbitration. Credential handling is genuinely good: named profiles with
platform-declared custody, credentials staying in vendor CLIs and OS keychains.

**[V] But it does not review GitHub pull requests.** No webhook path, no reviewing GitHub
Action, no PR surface in the README or `docs/INTEGRATIONS.md`. It is a local-first desktop
app, daemon and CLI for driving coding-agent sessions on your own machine, with an SSH-remote
mode.

**Read:** a fast-growing, legitimate multi-harness orchestrator competing on *local
implementation*, not on pull-request review. It should not be listed as a competitor. It is
worth watching only because a PR surface is a plausible thing for it to grow.

### `mattzcarey/shippie` - closest on trigger, narrowest on architecture

**[V]** MIT, TypeScript. Created 2023-07-06. 2,487 stars, 243 forks, 22 open issues.
The stall-and-rewrite claim checks out exactly: last commit before the gap 2025-10-25, next
commit 2026-06-22, rewrite onto a new framework ("flue" + "pi") running 2026-06-22 through
2026-07-02, which is the latest commit on `main`.

**[V]** Genuinely automatic: an `on: pull_request` GitHub Action with a full checkout
(`fetch-depth: 0`), plus an on-demand `/shippie review` comment trigger.

Where the ticket overstated it:

- **Not multi-harness.** Provider-agnostic on the underlying *Model* (Anthropic, OpenAI,
  OpenRouter, Cloudflare Workers AI), but it runs its own single agent loop. It does not
  drive Claude Code or Codex as Harnesses, and has no adversarial or cross-agent review.
- **Execution is qualified.** It gets real file and tool access to explore the codebase, and
  is an MCP client - so it is not diff-to-LLM. **[I]** But build and test execution is not
  confirmed as part of the review path; that appears to be a separate `shippie qa` subtool.
- **[V]** No documented story for isolating the agent's credential from untrusted repo code.

**Read:** "closest OSS analog" is defensible for *real tool access on an auto-triggered PR
review*, and wrong for *multi-harness execution-backed review*. Cite it precisely or not at all.

### PR-Agent - largest, and solving a different problem

**[V]** MIT, Python. Now `The-PR-Agent/pr-agent` (moved from `qodo-ai/pr-agent`).
Created 2023-07-05. 12,760 stars, 1,763 forks - by a wide margin the largest here.
Commit on 2026-08-29; v0.41.0 released 2026-07-26.

**[V]** The community-ownership claim is accurate as stated: the open-source-transition README
rewrite (PR #2339) merged 2026-04-21. (The `The-PR-Agent` org itself was created 2026-02-26,
but the public transition landed in April.)

**[V]** Diff- and context-based, not execution-based: each tool (`/review`, `/improve`,
`/ask`) "uses a single LLM call (~30 seconds, low cost)" over a compressed PR. Multi-*model*
via LiteLLM, not multi-harness; no cross-agent review, only a self-reflection pass. Self-host
only across GitHub, GitLab, Bitbucket, Azure DevOps and Gitea. Qodo's commercial "Qodo Merge"
is a separate hosted product the README explicitly disclaims.

**Read:** the scale benchmark and the incumbent OSS default, on the opposite side of the
architectural line Reprove is drawing. A useful contrast, not a rival on the thesis.

---

## 3. What the ticket did not know about

- **`spencermarx/open-code-review`** - **[V]** Apache-2.0, created 2026-01-26, 348 stars.
  Thirteen Harnesses (Claude Code, Cursor, Windsurf, Cline, Continue and others), per-persona
  model assignment, and built-in discourse between reviewer personas - the closest thing in
  spirit to adversarial review found anywhere. But: manually invoked (`/ocr-review`, then
  `/ocr-post` to publish afterwards), no repository checkout, no build or test execution.
  Diff-based static analysis, self-host only.
- **Claude Code's own hosted Code Review** - **[V]** Team/Enterprise, research preview.
  Genuinely automatic with a configurable per-repo trigger (on PR open, on every push, or
  manual), running "a fleet of specialized agents" in parallel with "a verification step
  [that] checks candidates against actual code behavior." **[I]** The docs never claim it
  executes builds or tests. Claude-only, hosted-only, no Harness choice. The self-hosted
  `claude-code-action` path does get real bash and file execution, since it runs the actual
  CLI in the runner - still Claude-only.
- **OpenAI Codex GitHub integration** - **[V]** An "Automatic reviews" toggle in Codex Cloud
  settings. The docs state it "reviews the pull request diff" - diff-only, no execution.
  Codex-only, hosted (requires Codex cloud configured for the repository).
- **CodeRabbit** - **[V]** Already ships real sandboxed execution: reviews run in an isolated
  microVM (8 vCPU / 32 GB, one-hour timeout) where it writes and runs shell scripts - grep,
  ast-grep, curl against vulnerability databases, `gh`. It also blends multiple models
  internally (NVIDIA Nemotron added January 2026). Proprietary and hosted-only, and blending
  models internally is not the same as a user choosing Claude Code over Codex as the Reviewer.
- **Greptile** - **[V]** v4 (2026-03-06) added a "Fix in X" button handing a flagged issue to
  an external coding agent (Claude Code, Codex, Cursor) *to fix it* - not to review with it.
  No evidence of user-selectable review models or execution-based review. Proprietary, hosted.
- **`wshobson/agents`** - **[V]** 39,246 stars, a multi-harness plugin marketplace for Claude
  Code, Codex, Cursor, OpenCode, Copilot and Antigravity. Not a PR-review orchestrator.
  Listed for awareness of scale in the multi-harness space, not as a competitor.

---

## 4. What this means for positioning

**[I]** Three conclusions the PRD's §38 rewrite rests on:

1. **Do not lead with any single axis.** Every one of the four is individually claimed by
   somebody - harness choice by claudexor and open-code-review, cross-agent review by
   `majiayu000/harness`, sandboxed execution by CodeRabbit, hosted convenience by the vendors.
   The position is the combination arriving automatically on a pull request.
2. **The vendor-native reviewers will never offer Harness choice.** Claude's Code Review is
   Claude-only and Codex's is Codex-only, by construction - each would be shipping a
   competitor's product. That axis is structurally unavailable to the two largest incumbents,
   which makes it durable in a way feature parity usually is not.
3. **Acknowledge `majiayu000/harness` by name and honestly.** It is the one project that
   independently arrived at the same architecture. Claiming the idea is unclaimed is both
   false and checkable, and a reader who finds it after reading a sweeping claim will
   discount everything else in the document.

## 5. Not verified

- Whether `majiayu000/harness`'s GitHub Action triggers on `pull_request` without an
  `@harness` mention.
- Whether Claude Code's hosted Code Review "verification step" executes code or re-reads it.
- CodeRabbit's and Greptile's internal architecture beyond their public blogs and changelogs;
  no independent technical audit is available for either.
