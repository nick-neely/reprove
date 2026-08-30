# Reprove

**Open-source agentic code review for GitHub pull requests.**

Reprove combines the experience of manually asking Codex or Claude Code to
deeply review your code with the automation and GitHub workflow of a dedicated
PR review bot.

Instead of piping a diff into a review-only LLM, it gives a real coding agent a
real repository environment: inspect the code, question the change, run the
build and tests, verify the finding, and only then report it. On a self-hosted
worker, that agent is *your* Codex, Claude Code, or OpenCode - your
authentication, your configuration, your provider usage.

```text
inspect → question → execute → verify → fix → re-prove
```

**Status:** Pre-implementation. The [PRD](docs/prd.md) is the spec of record;
no code has been written yet.

## Why

Your reviewer should be the agent you already trust to write the code. Most AI
reviewers make the model and the review architecture the vendor's choice;
Reprove makes them yours:

- **The agents you already use** - the same Codex, Claude Code, or OpenCode
  your team builds with, reviewing the pull request with the same
  capabilities: repository exploration, shell access, builds, tests, and
  one-off reproduction scripts.
- **The plan you already pay for** - on a self-hosted worker, Reprove runs
  your configured harness using authentication you manage. Where that
  authentication is backed by an existing subscription or included usage
  allowance, reviews consume that allowance rather than requiring separate
  metered API usage from Reprove. Subject to your provider's current terms,
  limits, and guidance on automated use; hosted reviews use managed
  API/Gateway authentication instead.
- **Harness choice** - Codex, Claude Code, or OpenCode, behind one adapter.
- **Model choice** - wherever the harness supports it, including OpenCode's
  broad provider support.
- **Verified findings** - the agent runs code to confirm a hypothesis before
  it becomes a review comment, and a finding carries how far that got.
- **Hosted or self-hosted** - a hosted worker running the same harnesses as a
  managed service on brokered API/Gateway authentication, or a self-hosted
  worker on your infrastructure that invokes your installed, unmodified CLI
  with authentication you manage. That authentication never reaches the
  control plane.
- **Credential isolation** - untrusted repository code never shares an
  execution environment with a password-equivalent agent credential. It is
  what makes the rest safe to run on code you did not write.

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

TypeScript, Node.js 22+ (ESM), Octokit, and two invocation routes behind one
adapter - AI SDK 7 `@ai-sdk/harness` with a brokered credential, or the
installed CLI with authentication you manage. Vercel Sandbox and AI Gateway
for hosted execution. Control-plane framework,
database, and queue are still open - see the [PRD](docs/prd.md).

## Docs

- [Product Requirements Document](docs/prd.md) - full product definition,
  architecture, roadmap, and open questions.
- [Competitive landscape](docs/research/competitive-landscape.md) - a dated
  survey of who else reviews pull requests with coding agents.
- [Provider auth and usage](docs/research/provider-auth-and-usage.md) - what
  OpenAI, Anthropic, and OpenCode actually document about subscription
  authentication, included usage, and automated use.

## Contributing

Reprove is open source and contributions are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for how the repo is organized and how
decisions get made. There is no CLA and no sign-off to remember - open a pull
request. Everyone participating is held to the
[Code of Conduct](CODE_OF_CONDUCT.md).

Found a security problem? Do not open an issue - see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the attribution notice
Apache-2.0 expects downstream distributions to carry.

Reprove is developed as open core: the project in this repository is
Apache-2.0, and Reprove Cloud adds unpublished billing and multi-tenant
management on top of it. The boundary is drawn by what gets published, not by
license restrictions - nothing here is licensed to discourage self-hosting.
