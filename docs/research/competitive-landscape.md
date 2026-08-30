# Who else reviews pull requests with coding agents?

Research for [#9](https://github.com/nick-neely/reprove/issues/9) (child of the foundation map [#1](https://github.com/nick-neely/reprove/issues/1)).
Surveyed 2026-08-29. Every star count, date and feature claim below was checked against the
GitHub API, repository READMEs or vendor documentation on that date.

**This file is a dated snapshot, not a position.** It rots faster than anything else in the
repository - the list it replaces was roughly half wrong within months of being written, and
half of that list was not in the category at all. The durable claim lives in
[`docs/prd.md`](../prd.md) §38; this file only records who was doing what on the date in the
heading. Re-verify before citing it after
~2026-11, and update *this* file rather than the PRD when the landscape moves.

Each claim is tagged **[V]** verified (API response, README quote, or vendor doc read on the
date above) or **[I]** inferred, labelled as such.

---

## 1. How this survey is scoped

**The category is pull-request review**, and only projects in it count as competitors. A
reviewer arrives on a pull request without being asked, leaves anchored Findings a team can
set policy on, and produces a Review a human reads like any other.

That excludes a whole class of project this survey initially conflated with the category:
**agent orchestrators**. Tools that drive Codex, Claude Code and OpenCode from one place are
solving session management, quota routing and multi-agent workflow. Some expose a GitHub
surface where a mention summons an agent onto a pull request. That is orchestration wearing a
PR-shaped hat, not a reviewer - and having built multi-harness plumbing does not put a project
in the review category any more than having a database makes something a CRM.

The survey therefore splits in two:

- **§2 - the review category.** The competitive set.
- **§3 - adjacent orchestrators.** Prior art on the plumbing, not competitors. Listed so
  nobody has to rediscover them, and so nobody mistakes them for a threat.

## 2. The review category

### Verdict

**No reviewer in the category lets the reviewing agent be one the team already uses.** Every
one either selects the model on the user's behalf, or is locked to a single vendor's agent by
construction.

| Reviewer | Auto-trigger | Executes code | Who chooses the reviewing agent | Hosted / self |
|---|---|---|---|---|
| CodeRabbit | Yes | **Yes** - isolated microVM | Vendor; models blended internally | Hosted only |
| Greptile | Yes | Not evidenced | Vendor | Hosted only |
| PR-Agent | Yes | No - single LLM call | User picks a *Model*; agent loop is PR-Agent's | Self-host |
| shippie | Yes | Tool access; build/test not confirmed | User picks a *Model*; single agent loop | Self-host |
| Claude Code Review | Yes | Not evidenced | Anthropic. Claude only | Hosted (preview) |
| Codex auto reviews | Yes | **No** - diff only | OpenAI. Codex only | Hosted |
| **Reprove** | Yes | **Yes** - Workspace in a Sandbox | **The user. Their Harness, their authentication** | **Both** |

Two consequences worth stating plainly:

1. **[V] "We run tests and they don't" is dead.** CodeRabbit already runs reviews in an
   isolated microVM (8 vCPU / 32 GB, one-hour timeout) where it writes and executes shell
   scripts - grep, ast-grep, curl against vulnerability databases, `gh`. Execution is table
   stakes in the category now, not a differentiator.
2. **[I] The vendor-native reviewers can never close the gap.** Claude's Code Review is
   Claude-only and Codex's is Codex-only *by construction* - either would be shipping a
   competitor's coding agent as its own review engine. This is structural, not a roadmap item.

### CodeRabbit - the incumbent to position against

**[V]** Proprietary, hosted only. Reviews run in an isolated microVM where the reviewer writes
and runs shell scripts. Blends multiple models internally (NVIDIA Nemotron added January 2026)
and argues explicitly that users should not need to choose the underlying model.

**Read:** the real competitor, and the honest philosophical disagreement. Blending models
internally is not the same as a user choosing Claude Code over Codex as the Reviewer.

### Greptile

**[V]** Proprietary, hosted. v4 (2026-03-06) added a "Fix in X" button handing a flagged issue
to an external coding agent (Claude Code, Codex, Cursor) **to fix it** - notably, *not* to
review with it. No evidence of user-selectable review models or execution-based review.

**Read:** the closest anyone in the category comes to touching an external Harness, and it is
on the fix side only. Suggestive that the review side is seen as the vendor's moat.

### PR-Agent - the scale benchmark

**[V]** MIT, Python. Now `The-PR-Agent/pr-agent` (moved from `qodo-ai/pr-agent`).
Created 2023-07-05. 12,760 stars, 1,763 forks - by a wide margin the largest here.
Commit on 2026-08-29; v0.41.0 released 2026-07-26. The community-ownership claim is accurate:
the open-source-transition README rewrite (PR #2339) merged 2026-04-21.

**[V]** Diff- and context-based: each tool (`/review`, `/improve`, `/ask`) "uses a single LLM
call (~30 seconds, low cost)" over a compressed PR. Multi-*model* via LiteLLM, not
multi-harness; no cross-agent review, only a self-reflection pass. Self-host only across
GitHub, GitLab, Bitbucket, Azure DevOps and Gitea. Qodo's commercial "Qodo Merge" is a
separate hosted product the README explicitly disclaims.

**Read:** the incumbent OSS default and the star benchmark, on the opposite side of the
architectural line. A useful contrast, not a rival on the thesis.

### shippie - closest OSS reviewer, still narrower

**[V]** MIT, TypeScript. Created 2023-07-06. 2,487 stars, 243 forks. The stall-and-rewrite
claim checks out: last commit before the gap 2025-10-25, next commit 2026-06-22, rewrite onto
a new framework ("flue" + "pi") running 2026-06-22 through 2026-07-02, the latest commit on
`main`.

**[V]** Genuinely automatic: an `on: pull_request` GitHub Action with a full checkout
(`fetch-depth: 0`), plus an on-demand `/shippie review` comment trigger.

Where the original claim overstated it:

- **Not multi-harness.** Provider-agnostic on the underlying *Model* (Anthropic, OpenAI,
  OpenRouter, Cloudflare Workers AI), but it runs its own single agent loop. It does not drive
  Claude Code or Codex as Harnesses, and has no adversarial or cross-agent review.
- **Execution is qualified.** Real file and tool access to explore the codebase, and an MCP
  client - so not diff-to-LLM. **[I]** But build and test execution is not confirmed as part
  of the review path; that appears to be a separate `shippie qa` subtool.
- **[V]** No documented story for isolating the agent's credential from untrusted repo code.

**Read:** the closest OSS analog *within the category*, and still a single-agent reviewer that
brings its own loop. Cite it precisely or not at all.

### The vendor-native reviewers

- **Claude Code hosted Code Review** - **[V]** Team/Enterprise, research preview. Genuinely
  automatic with a configurable per-repo trigger (on PR open, on every push, or manual),
  running "a fleet of specialized agents" in parallel with "a verification step [that] checks
  candidates against actual code behavior." **[I]** The docs never claim it executes builds or
  tests. Claude-only, hosted-only. The self-hosted `claude-code-action` path does get real
  bash and file execution since it runs the actual CLI in the runner - still Claude-only.
- **OpenAI Codex GitHub integration** - **[V]** An "Automatic reviews" toggle in Codex Cloud
  settings. The docs state it "reviews the pull request diff" - diff-only, no execution.
  Codex-only, hosted (requires Codex cloud configured for the repository).

**Read:** these validate the workflow and constrain nothing. They are also the clearest
evidence for the structural asymmetry: neither vendor can offer the other's Harness.

## 3. Adjacent orchestrators - prior art, not competitors

These are the projects the original competitor list got wrong. All of them are real, several
are excellent, and **none of them is a PR review bot.** They are recorded so nobody
rediscovers them and mistakes multi-harness plumbing for a competing product.

### `majiayu000/harness` - the architectural prior art

**[V]** MIT, Rust. Created 2026-03-02. 64 stars, 5 forks, 42 open issues, 1 release,
last commit 2026-08-29 - actively developed, apparently single-maintainer.

**[V]** It drives Claude Code, Codex, OpenCode and a direct Anthropic-API adapter behind
policy and observability, with sandbox modes (`read-only`, `workspace-write`,
`danger-full-access`) enforced by Landlock/bwrap on Linux, so agents run real builds and tests
in a workspace. Its README names "independent agent review - automatic cross-agent code
review between implementation and GitHub review, preventing self-review by architecture."

**Why it is not in the category. [V]** Its GitHub surface is HMAC-verified webhooks that parse
**`@harness` mentions** in issue and PR comments - you summon an agent onto a pull request.
**[I]** That is an orchestration entry point, not a reviewer: no unprompted arrival on every
pull request, no Severity or threshold policy, no dedupe across pushes, no Review a team reads
as a review. A separate "CI/CD GitHub Action" exists; whether it fires on a bare
`pull_request: opened` without a mention could not be confirmed.

**Read:** the one project that independently built the same *plumbing* - harness choice,
cross-agent workflow, sandboxed execution. Genuine prior art on the architecture and worth
acknowledging honestly. It is not competing for the same job, and it could not be adopted as a
PR reviewer today regardless: no hosted path, Postgres to operate, and mention-gated entry.

### `razzant/claudexor` - not a PR product at all

**[V]** MIT, TypeScript. Created 2026-06-05 (under three months old). 425 stars, 40 forks,
v3.9.0 released 2026-08-29. Distributed via npm and a signed macOS DMG.

**[V]** Multi-harness (Codex, Claude Code, Cursor, OpenCode, Antigravity/Gemini, raw API),
quota-aware credential-profile rotation across subscriptions, shared thread context, and
best-of-N races with independent reviewers and arbitration. Credential handling is genuinely
good: named profiles with platform-declared custody, credentials staying in vendor CLIs and OS
keychains.

**[V] It does not review GitHub pull requests.** No webhook path, no reviewing Action, no PR
surface in the README or `docs/INTEGRATIONS.md`. It is a local-first desktop app, daemon and
CLI for driving coding-agent sessions on your own machine, with an SSH-remote mode.

**Read:** a fast-growing, legitimate orchestrator competing on *local implementation*. It was
listed as a competitor in error. Worth watching only because a PR surface is a plausible thing
for it to grow.

### `spencermarx/open-code-review`

**[V]** Apache-2.0, created 2026-01-26, 348 stars. Thirteen Harnesses (Claude Code, Cursor,
Windsurf, Cline, Continue and others), per-persona model assignment, and built-in discourse
between reviewer personas - the closest thing in spirit to adversarial review found anywhere.

**[V] Manually invoked** (`/ocr-review`, then `/ocr-post` to publish afterwards), no repository
checkout, no build or test execution. Diff-based static analysis, self-host only.

**Read:** the name says review, and the trigger says otherwise. A local analysis tool you point
at a diff, not a reviewer that shows up on pull requests. **[I]** Of everything in this
section it is the most likely to move into the category, since only the trigger and a
checkout separate it.

### `wshobson/agents`

**[V]** 39,246 stars. A multi-harness plugin marketplace for Claude Code, Codex, Cursor,
OpenCode, Copilot and Antigravity. Not a review product in any sense. Recorded only as
evidence of how large the multi-harness *tooling* space is - which is the point of this
section: multi-harness is a crowded plumbing layer, not a product position.

## 4. What this means for positioning

**[I]** Four conclusions the PRD's §38 rewrite rests on:

1. **Draw the category line first.** The most misleading result of the original survey came
   from searching for a *capability* ("multi-harness plus cross-agent review") instead of a
   *category*. That put orchestrators in a reviewer's competitive set and made the landscape
   look far more crowded than it is. Ask "does this arrive on a pull request and leave a
   review a team can set policy on?" before anything else.
2. **Inside the category, the position is unclaimed and simple.** Every reviewer either
   selects the model for you or is locked to one vendor's agent. **None lets the reviewing
   agent be the coding agent the team already uses.** That single sentence is stronger and
   more durable than the four-axis combination it replaces, because it does not depend on
   nobody else assembling the same feature list.
3. **The vendor-native reviewers can never offer Harness choice.** Claude's Code Review is
   Claude-only and Codex's is Codex-only, by construction - each would be shipping a
   competitor's product. Structurally unavailable to the two largest incumbents, which makes
   it durable in a way feature parity never is.
4. **Acknowledge `majiayu000/harness` accurately, as prior art rather than as a rival.**
   It independently built the same plumbing, and pretending otherwise is checkable and
   discrediting. But it is an orchestrator with a mention-gated GitHub surface, and calling
   it a competing PR reviewer overstates it in the other direction. Precision in both
   directions is what makes the rest of the document trustworthy.

## 5. Not verified

- Whether `majiayu000/harness`'s GitHub Action triggers on `pull_request` without an
  `@harness` mention.
- Whether Claude Code's hosted Code Review "verification step" executes code or re-reads it.
- CodeRabbit's and Greptile's internal architecture beyond their public blogs and changelogs;
  no independent technical audit is available for either.
