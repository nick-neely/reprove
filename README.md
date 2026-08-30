# Reprove

**Open-source agentic code review for GitHub pull requests.**

Reprove combines the experience of manually asking Codex or Claude Code to
deeply review your code with the automation and GitHub workflow of a dedicated
PR review bot.

Instead of piping a diff into a review-only Model, it gives a Reviewer a real
Workspace: inspect the code, question the change, run the build
and tests, verify the Finding, and only then report it. On a self-hosted
Worker, that Reviewer uses *your* Codex, Claude Code, or OpenCode - your
authentication, your configuration, your provider usage.

```text
inspect → question → execute → verify → fix → re-prove
```

**Status:** Pre-implementation. The [PRD](docs/prd.md) is the spec of record;
no code has been written yet.

## Why

Your Reviewer should use the Harness you already trust to write the code. Most AI
reviewers make the model and the review architecture the vendor's choice;
Reprove makes them yours:

- **The Harnesses you already use** - the same Codex, Claude Code, or OpenCode
  your team builds with, reviewing the pull request with the same
  capabilities: Repository exploration, shell access, builds, tests, and
  one-off reproduction scripts.
- **The plan you already pay for** - on a self-hosted Worker, Reprove runs
  your configured Harness using authentication you manage. Where that
  authentication is backed by an existing subscription or included usage
  allowance, reviews consume that allowance rather than requiring separate
  metered API usage from Reprove. Subject to your provider's current terms,
  limits, and guidance on automated use; hosted reviews use managed
  API/Gateway authentication instead.
- **Harness choice** - Codex, Claude Code, or OpenCode, behind one Adapter.
- **Model choice** - wherever the Harness supports it, including OpenCode's
  broad provider support.
- **Verified Findings** - the Reviewer runs code to confirm a hypothesis before
  it becomes a Finding, and its Verification records how far that got.
- **Hosted or self-hosted** - a hosted Worker running the same Harnesses as a
  managed service on brokered API/Gateway authentication, or a self-hosted
  Worker on your infrastructure that invokes your installed, unmodified CLI
  with authentication you manage. That authentication never reaches the
  control plane.
- **Credential isolation** - the Brokered Route keeps usable credentials out of
  the Sandbox. The Native Route necessarily places its credential inside, so
  Reprove gates execution on Exposure, Isolation, and Provenance and never
  weakens that posture quietly.

## How it works

```text
GitHub PR
   ↓
GitHub App → Control Plane → Run
   ↓
Self-Hosted Worker  |  Hosted Worker
   ↓
Adapter → Codex / Claude Code / OpenCode
   ↓
Result → GitHub Review
```

Three levels of increasing Autonomy:

| Autonomy | The Reviewer... |
|---|---|
| `inspect` | reads the diff, Repository, and history to form Findings |
| `verify` | additionally runs builds, tests, and scripts to confirm or discard each hypothesis |
| `fix` | additionally edits the Workspace, proposes a Patch, and verifies it |

## Roadmap

| Phase | Goal |
|---|---|
| 0 | Foundation - GitHub App, control-plane boundaries, Run / Result |
| 1 | MVP - hosted `inspect` + `verify` end to end on one Harness |
| 2 | Multi-Harness, Model choice, Strategies |
| 3 | Self-hosted Worker |
| 4 | `fix` Autonomy and cross-Harness workflows |
| 5 | Hardening and productization |

## Stack

TypeScript, Node.js 22+ (ESM), Next.js on Vercel, Neon + Drizzle, Better Auth,
Octokit, and Vercel Workflows. One Adapter per Harness hides two invocation
Routes: AI SDK 7 `@ai-sdk/harness` with a brokered credential, or the installed
CLI with authentication you manage. Hosted Workers use Vercel Sandbox and AI
Gateway.

## Docs

- [Product Requirements Document](docs/prd.md) - full product definition,
  architecture, roadmap, foundation decisions, and explicit deferrals.
- [Competitive landscape](docs/research/competitive-landscape.md) - a dated
  survey of who else reviews pull requests with coding-agent Harnesses.
- [Provider auth and usage](docs/research/provider-auth-and-usage.md) - what
  OpenAI, Anthropic, and OpenCode actually document about subscription
  authentication, included usage, and automated use.

## Contributing

Reprove is open source and contributions are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for how the Repository is organized and how
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
