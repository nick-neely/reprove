# Reprove

**Open-source agentic code review for GitHub pull requests.**

Reprove turns established coding agents - Codex, Claude Code, OpenCode - into
autonomous PR reviewers, validators, and optional fixers. Instead of piping a
diff into a review-only LLM, it gives a real coding agent a real repository
environment: inspect the code, question the change, run the build and tests,
verify the finding, and only then report it.

```text
inspect → question → execute → verify → fix → re-prove
```

**Status:** Pre-implementation. The [PRD](docs/prd.md) is the spec of record;
no code has been written yet.

## Why

Most AI reviewers make the model and the review architecture the vendor's
choice. Reprove makes them yours:

- **Harness choice** - Codex, Claude Code, or OpenCode.
- **Model choice** - wherever the harness supports it, including OpenCode's
  broad provider support.
- **Execution choice** - a self-hosted worker on your infrastructure, or a
  hosted Vercel Sandbox.
- **Bring your own setup** - use the agent authentication and subscriptions
  you already have; self-hosted provider credentials never reach the control
  plane.
- **Verified findings** - the agent runs code to confirm a hypothesis before
  it becomes a review comment.

## How it works

```text
GitHub PR
   ↓
GitHub App → Control Plane → ReviewJob
   ↓
Self-Hosted Worker  |  Hosted Sandbox
   ↓
HarnessAgent → Codex / Claude Code / OpenCode
   ↓
ReviewResult → GitHub Review
```

Three modes of increasing autonomy:

| Mode | The agent... |
|---|---|
| **Review** | inspects the diff, repository, and history to find issues |
| **Verify** | additionally runs builds, tests, and scripts to confirm or discard each finding |
| **Fix** | additionally edits code, proposes a patch, and re-validates it |

## Roadmap

| Phase | Goal |
|---|---|
| 0 | Foundation - GitHub App, control-plane boundaries, `ReviewJob` / `ReviewResult` |
| 1 | MVP - hosted Review + Verify end to end on one harness |
| 2 | Multi-harness, model choice, review strategies |
| 3 | Self-hosted worker |
| 4 | Fix mode and cross-harness workflows |
| 5 | Hardening and productization |

## Stack

TypeScript, Node.js 22+ (ESM), AI SDK 7 `HarnessAgent`, Octokit, Vercel
Sandbox and AI Gateway for hosted execution. Control-plane framework,
database, and queue are still open - see the [PRD](docs/prd.md).

## Docs

- [Product Requirements Document](docs/prd.md) - full product definition,
  architecture, roadmap, and open questions.

## License

Not yet chosen.
