# PRD: Reprove

**Product:** Reprove  
**Domain:** `reprove.dev`  
**Status:** Draft  
**Primary platform:** GitHub  
**Initial harnesses:** Codex, Claude Code, OpenCode  
**Primary use case:** AI pull request review, verification, and optional remediation using full coding-agent Harnesses.

---

# 1. Product Identity

## Reprove

**Reprove** is an open-source agentic code review system that turns established coding-agent
Harnesses into autonomous Reviewers that inspect, verify, and optionally fix pull requests.

The name fits the product in two ways:

1. **Reprove** means to criticize or express disapproval, directly matching the code review function.
2. It also naturally reads as **“re-prove”**, matching the product's core philosophy of testing an implementation's assumptions and proving correctness again through inspection, execution, verification, and, where enabled, remediation.

```text
inspect
→ question
→ execute
→ verify
→ fix
→ re-prove
```

**Primary domain:** `reprove.dev`

The `.dev` domain fits the project as developer infrastructure without adding “AI,” “code,” or another modifier to the product name.

---

# 2. Summary

Build an open-source GitHub code review system powered by established coding-agent Harnesses rather
than a proprietary review-only Model pipeline.

Initial Harnesses:

- Codex
- Claude Code
- OpenCode

AI SDK 7 exposes Codex, Claude Code, OpenCode, Pi, and other established Harnesses through its
`HarnessAgent` abstraction. That is a dependency API, not Reprove's domain layer: Reprove owns one
Adapter per Harness.

The product supports two Worker lifecycles:

### Self-hosted worker

The user runs a worker they control.

```text
GitHub
   ↓
Control Plane
   ↓
Self-Hosted Worker
   ↓
Codex / Claude Code / OpenCode
   ↓
Review + Verification + optional Patches
```

Goals:

- run the Harnesses the user already has installed and authenticated;
- use the authentication the user manages, whatever form it takes;
- consume the provider usage that authentication already carries, rather than requiring
  separate Reprove-metered API usage;
- allow OpenCode provider/model configuration;
- keep provider credentials on user-controlled infrastructure, and out of the control plane.

### Hosted worker

Reviews run in isolated Vercel Sandboxes.

```text
GitHub
   ↓
Control Plane
   ↓
Hosted Worker
 ├── Adapter
 └── Vercel Sandbox
      ├── Harness + Workspace
      └── brokered AI Gateway access
   ↓
Result
```

Hosted execution uses machine-oriented API/Gateway authentication rather than consumer subscription credentials.

---

# 3. Product Thesis

This should not be built as:

```text
PR diff
   ↓
Model prompt
   ↓
Markdown comments
```

The Reviewer gets an actual Workspace inside a Sandbox.

```text
PR
 ↓
Reviewer
 ├── inspect repository
 ├── inspect diff
 ├── search code
 ├── inspect git history
 ├── run build
 ├── run tests
 ├── start services
 ├── execute commands
 ├── write temporary tests/scripts
 ├── reproduce suspected bugs
 ├── modify code
 ├── verify modifications
 └── produce review findings
```

The Reviewer should preserve the capabilities that make Codex, Claude Code, and OpenCode useful as
coding-agent Harnesses.

AI SDK's `HarnessAgent` is specifically designed to preserve capabilities above the Model layer such
as sandboxing, skills, sessions, permission flows, compaction, tools, and runtime configuration
instead of reducing a Harness to a single Model call. Reprove's Adapter owns the product contract
above that dependency.

---

# 4. Core Differentiation

## 4.1 General-purpose coding-agent Harnesses are the review runtime

The product is not primarily building another proprietary reviewer.

```text
Our orchestration
       ↓
User-selected harness
       ↓
Codex / Claude Code / OpenCode
```

The runtime brings existing capabilities such as:

- filesystem navigation;
- repository search;
- shell execution;
- code editing;
- test execution;
- context management;
- skills;
- sessions;
- tool usage;
- runtime configuration.

The product supplies the GitHub workflow, Strategy, Isolation, Result normalization, and product
experience around those Reviewers.

---

## 4.2 Harness choice belongs to the user

```text
Review with:

○ Codex
○ Claude Code
○ OpenCode
```

The user decides which Harness they trust for the Repository or individual Review.

This is configured at two authored layers, settled by
[ADR 0011](adr/0011-repository-configuration-contract.md):

```text
Reprove defaults
  -> Owner layer          (the GitHub user or organization; "account" and "organization"
                           above are one thing, and Reprove's tenant is the Owner)
  -> Repository file      (.reprove.yml, read whole from the base ref)
```

For ordinary quality keys the Repository value wins. For security keys the effective value is the
narrowest the layers permit, and the Owner layer is a **Ceiling** rather than a default: it lets a
Repository request something, and can never switch it on.

**Per-run configuration is not a layer.** A Run pins `harness`, `model`, `strategy` and `autonomy`
at creation and a re-run is a new Run, so a per-run override needs a dashboard surface that is out
of the foundation map's scope.

---

## 4.3 Model choice belongs to the user

When the selected harness supports multiple models, the product should expose that choice instead of hiding it.

Conceptually:

```text
Harness: Codex
Model: [models supported by Codex]

Harness: Claude Code
Model: [models supported by Claude Code]

Harness: OpenCode
Provider: OpenCode Go
Model: [available OpenCode Go models]
```

The control plane owns a curated Model catalogue keyed by Harness and Provider. None of the initial
Harnesses exposes reliable runtime Model enumeration through `@ai-sdk/harness`, so the Adapter treats
Model ids as opaque strings and, where the Harness reports the resolved Model, verifies that the
pinned Model was honored. The UI and configuration expose only catalogue entries available for the
selected Harness and Provider.

OpenCode explicitly supports selecting Models from any Provider available to the current project,
including per-run Model selection.

This is a meaningful competitive distinction. CodeRabbit intentionally does not expose underlying Model selection to users and instead selects and blends Models internally.

---

## 4.4 Use the coding-agent Harnesses you already work with

The Reviewer is not a new tool to evaluate. It is the Harness your team already builds with,
pointed at the pull request.

```text
Codex        → the Codex you already use
Claude Code  → the Claude Code you already use
OpenCode     → the OpenCode you already use
```

What "already use" covers depends on which Worker runs the Run:

- **Self-hosted Worker.** The Harness, the Model, the authentication you manage, your
  configuration, your environment, **and your provider usage**. The Native Auth Route invokes
  the installed, unmodified CLI; Reprove never receives that authentication. See §22.
- **Hosted Worker.** The same Harnesses and the same Model choice, run as a managed service
  with brokered API/Gateway authentication and no setup to operate.

The continuity that matters is the Harness. A Reviewer that is the same program your team
already trusts to write code inherits its judgment about your repository - its conventions,
its build, its tests - rather than approximating them from a diff.

That continuity extends to how the Run is paid for. On the Native Auth Route, a Run consumes
the provider usage the configured Harness already has - the same account and the same plan,
triggered by a pull request instead of by a person - rather than requiring separate
Reprove-metered API usage. This is a current capability of that Route and not a guarantee
about future provider pricing, limits, or authentication policy, and it does not apply to
hosted Runs. See §22 and §38.

OpenCode additionally supports a broad provider catalog, custom providers, and local models.

## 4.5 Open model/provider path through OpenCode

OpenCode provides the broad model/provider option alongside the two major lab-specific harnesses.

```text
OpenCode
   ↓
Provider
   ↓
Model
```

This can include:

- OpenCode Go;
- direct providers;
- OpenRouter;
- locally hosted models;
- custom OpenAI-compatible endpoints;
- other OpenCode-supported providers.

OpenCode Go currently provides a low-cost subscription path focused on open coding Models, while
OpenCode itself allows Model selection across connected Providers.

This gives the initial product three clean categories:

```text
Codex       → OpenAI ecosystem
Claude Code → Anthropic ecosystem
OpenCode    → broader/open provider ecosystem
```

---

## 4.6 Self-hosted or hosted

Users can choose:

```text
Use my infrastructure + authentication
```

or:

```text
Run it for me in an isolated hosted sandbox
```

The same GitHub experience should sit above both execution paths.

---

## 4.7 Review, verification, and fixing are one loop

A hypothesis does not immediately become a Finding.

```text
Hypothesis
      ↓
Inspect related implementation
      ↓
Run relevant code
      ↓
Write targeted test/script if needed
      ↓
Reproduce behavior
      ↓
Confirm or reject finding
```

Under `fix` Autonomy:

```text
Verified Finding
      ↓
Modify code
      ↓
Run tests/build
      ↓
Verify behavior
      ↓
Return verified patch
```

This inspect → verify → fix → re-verify loop is a core product primitive.

---

# 5. Adversarial and Cross-Harness Review

Harness choice allows review strategies that are difficult to implement cleanly in a single opaque review engine.

## Cross-harness adversarial review

Example:

```text
Implementation
Claude Code
     ↓
Pull Request
     ↓
Codex Reviewer
```

or:

```text
Implementation
Codex
     ↓
Pull Request
     ↓
Claude Code Reviewer
```

The goal is reviewer independence.

A Model/Harness that did not produce the implementation may challenge assumptions the Author made.

The system should allow explicit configuration such as:

```yaml
review:
  harness: codex
```

even if another Author generated the pull request.

Automatically determining the Author of a change:

**Deferred to the per-phase Strategy map.**

Potential inputs could eventually include explicit configuration or metadata from integrations, but the product should not assume this metadata always exists.

---

# 6. Review Strategies

`strategy` is separate from `harness`.

Potential strategies:

## Standard

```text
One Reviewer
→ inspect
→ verify
→ report
```

Initial default.

## Adversarial

```text
Author A
        ↓
Reviewer B
```

The Reviewer intentionally differs from the Author.

## Reviewer + Verifier

```text
Reviewer A
→ generate findings

Reviewer B
→ challenge/verify high-value findings
```

Potentially useful for reducing false positives.

**Deferred to the per-phase Strategy map.**

## Multi-reviewer

```text
Codex ─────┐
Claude ────┼→ reconcile
OpenCode ──┘
```

Potential use cases:

- high-risk PRs;
- security-sensitive changes;
- release candidates;
- explicit manual deep review.

**Deferred to the per-phase Strategy map.**

## Cost-optimized escalation

Example:

```text
Lower-cost model
→ initial scan
→ suspicious/high-risk area
→ stronger model/harness
```

OpenCode's broad provider/model support makes this particularly possible.

**Deferred to the per-phase Strategy map.**

The architecture should allow these strategies without requiring them in the MVP.

---

# 7. Review Controls

The product should eventually separate four major choices:

```text
Worker
self-hosted / hosted

Harness
Codex / Claude Code / OpenCode

Model
Harness-dependent

Strategy
Standard / Adversarial / ...
```

Plus Autonomy:

```text
Autonomy
inspect / verify / fix
```

Conceptual configuration:

```yaml
review:
  worker: self-hosted
  harness: codex
  model: [harness-supported-model]
  strategy: standard
  autonomy: verify
```

The exact configuration format is settled by
[ADR 0011](adr/0011-repository-configuration-contract.md). See §30.

---

# 8. Goals

## Core

- Automatically review GitHub pull requests.
- Use real coding-agent Harnesses.
- Initial support:
  - Codex
  - Claude Code
  - OpenCode
- Allow users to choose the harness.
- Allow users to choose the model where supported.
- Allow the Reviewer to investigate the entire Repository.
- Allow executable Verification of Findings.
- Support optional Reviewer-driven Patches.
- Support cross-harness/adversarial review.
- Produce structured GitHub reviews and inline comments.
- Support self-hosted and hosted execution.
- Keep self-hosted provider credentials outside the control plane.
- Treat PR code as untrusted.
- Remain open source.
- Keep GitHub integration independent from Worker and Harness.

## Quality

Reduce speculative Findings by allowing the Reviewer to verify claims where practical.

Instead of:

```text
"This may fail when X occurs."
```

the Reviewer should be capable of attempting:

```text
1. reproduce X
2. execute affected code
3. observe behavior
4. report evidence
```

Not every Finding can be verified by execution.

---

# 9. Review Autonomy

Autonomy is an enforcement ladder, not a preferred behavior:

```text
inspect < verify < fix
```

A level is offered only where the Adapter can enforce it for the resolved Harness, Model, Route,
and Sandbox.

## `inspect`

Primary goal:

```text
Find potential defects through reading and reasoning.
```

Capabilities:

- inspect diff;
- inspect repository;
- search references;
- inspect related code;
- reason about behavior.

The Reviewer may read but may not execute project code or mutate the Workspace.

---

## `verify`

Primary goal:

```text
Find potential defects and verify them.
```

The Reviewer may additionally:

- run existing tests;
- run type checks;
- run linters;
- build the project;
- start services;
- execute CLI commands;
- make API requests;
- write temporary scripts;
- write targeted temporary tests;
- reproduce suspected edge cases.

```text
Finding hypothesis
      ↓
Can it be verified?
      ↓
Execute verification
      ↓
Confirmed / rejected
```

Rejected hypotheses never become Findings.

---

## `fix`

Primary goal:

```text
Find, verify, and repair defects.
```

The Reviewer may additionally:

- edit source;
- modify tests;
- generate patches;
- rerun builds/tests;
- iterate until the proposed Patch is verified.

```text
Detect
  ↓
Reproduce
  ↓
Modify
  ↓
Test
  ↓
Re-verify
  ↓
Return fix
```

How Patches reach GitHub:

- suggested patch;
- generated commit;
- separate branch;
- direct PR commit;
- follow-up PR.

**Deferred to the per-phase fix workflow map.**

---

# 10. Agentic Verification

Verification is a first-class architectural capability.

Examples:

```text
Type error
→ run type checker

Potential build failure
→ run build

Logic bug
→ write focused test/script

Broken API behavior
→ start service + make request

Database behavior
→ run isolated reproduction

Dependency defect
→ inspect/install/run dependency

Claim about function behavior
→ write one-off reproduction
```

The important distinction is moving from:

```text
reasoning about code
```

to:

```text
testing reasoning against code
```

when useful.

---

# 11. Evidence-Based Findings

Where Verification occurred, a Finding carries structured Evidence.

Evidence records:

- command executed;
- exit code and duration;
- a bounded head-and-tail excerpt of output;
- truncation metadata including original byte length.

Conceptual result:

```text
Finding
 ├── path + line/range + anchored source
 ├── title + body
 ├── severity
 ├── verification: static | inconclusive | verified
 ├── evidence[]
 └── patch?
```

GitHub renders each bounded Evidence excerpt inside a collapsed `<details>` block. Raw stdout,
stderr, transcripts, and bulk Workspace content do not cross the self-hosted Worker protocol or
enter GitHub comments. A Finding cannot be `verified` without Evidence, and a `static` Finding
cannot carry it.

---

# 12. Non-Goals / Future Scope

Not initially committed:

- automatic commit/push of Patches: **[Deferred to the per-phase fix workflow map]**
- auto-merge: **[Out of Initial Scope]**
- GitLab: **[Future]**
- Bitbucket: **[Future]**
- Pi harness: **[Future]**
- additional harnesses: **[Future]**
- multi-Reviewer consensus review: **[Future]**
- team analytics dashboard: **[Deferred to a product phase map]**
- Owner management depth: **[Deferred to a product phase map]**

Initial product stays focused on:

```text
GitHub PR
→ Review
→ Verification
→ Findings
→ Optional fix
```

---

# 13. Core Architecture

```text
GitHub -> GitHub App -> Control Plane -> Run

Run
 ├── self-hosted Worker
 │    ├── Adapter
 │    └── local Sandbox
 │         ├── Workspace
 │         └── Harness
 └── hosted Worker
      ├── Adapter
      └── Vercel Sandbox
           ├── Workspace
           └── Harness

Result -> Control Plane -> GitHub Review
```

---

# 14. Technology

| Component | Decision |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 22+ / ESM |
| Monorepo | pnpm workspaces + Turborepo |
| GitHub ingress and API | Direct Octokit webhooks and API |
| Dependency abstraction | AI SDK `HarnessAgent` on the Brokered Route |
| Reprove abstraction | One Adapter per Harness, with brokered and native Routes |
| Harnesses | Codex, Claude Code, OpenCode |
| Hosted isolation | Vercel Sandbox |
| Hosted AI routing | Vercel AI Gateway |
| Control-plane framework | Next.js |
| Database | Neon Postgres + Drizzle |
| Durable orchestration | Vercel Workflows |
| Authentication | Better Auth |
| Rate limiting | Upstash |
| Schema validation | zod |
| Testing | Vitest + Playwright |
| Lint and format | Oxlint + Oxfmt, through Ultracite |
| Product analytics | PostHog, bounded non-content facts only |
| Control-plane hosting | Vercel |

AI SDK 7 requires Node.js 22+ and ESM. Its `HarnessAgent` implementations are confined behind
Reprove's Adapter on the Brokered Route; the Native Route invokes the installed CLI directly.

---

# 15. GitHub Integration

Use a GitHub App.

```text
GitHub event
    ↓
Webhook
    ↓
Direct Octokit webhook handling
    ↓
Control Plane
```

Responsibilities:

- identify installation;
- identify repository;
- identify PR;
- receive PR lifecycle events;
- publish summaries;
- publish inline comments;
- optionally publish fixes.

Use Octokit directly for pull-request lifecycle events, Checks, Reviews, Comments, and repository
access. `@chat-adapter/github` does not route `pull_request` events or publish Reviews, so it is not
part of ingress.

---

# 16. Review Triggers

Potential triggers:

- PR opened;
- PR updated;
- manual request;
- GitHub label;
- `@mention`;
- dashboard request;
- CLI request.

Default:

```text
PR opened / synchronize
→ automatically review
```

Manual requests remain an additional trigger. A new push creates a new Run at the new head SHA and
supersedes the prior Run.

---

# 17. Run

```text
Run
 ├── spec                         fixed at creation
 │    ├── Owner / Repository / Installation / pull request
 │    ├── baseSha / headSha
 │    ├── provenance + provenanceBasis
 │    ├── harness / model / strategy / autonomy
 │    ├── placement + allowHostedFallback
 │    ├── resolvedConfig + configDigest
 │    └── claimableUntil
 ├── resolution                   written once at claim
 │    ├── workerId? / route
 │    ├── isolation / exposure
 │    └── protocolVersion / workerBuildVersion
 └── state                        mutable
      ├── status / executionToken / executionExpiresAt / timestamps
      ├── Refusals / failure reason + detail
      └── accepted Result + publication record
```

A Run is one bounded attempt at fixed base and head SHAs. A new push or retry creates a new Run;
there is no intermediary layer. Nothing in the Run references a webhook delivery, so everything after
creation is independent of GitHub ingress.

Status moves from `queued` to `claimed` to `executing`, then terminates as `completed`, `incomplete`,
`failed`, `superseded`, `cancelled`, or `unscheduled`. A complete accepted Result makes the Run
`completed` whether or not it contains Findings; a partial accepted Result makes it `incomplete`;
execution without an acceptable Result is a Failure. The Check reports that execution outcome, not
the Review's verdict.

---

# 18. Worker

```text
Worker core
   ├── hosted lifecycle: one Vercel Workflow-backed Run, no durable Worker identity
   └── self-hosted lifecycle: long-lived daemon, enrollment, polling, claim, and Lease
```

The Worker executes a Run and returns its Result. The hosted and self-hosted lifecycles drive the
same core and share one Result, progress, and Acceptance path; neither is a different domain thing.

The Worker placement decides **where** the Run executes.

Harness and Model decide **which Reviewer** performs a Pass.

Strategy decides **how Reviewers are composed**.

---

# 19. Adapter

```text
Adapter
 ├── CodexAdapter
 ├── ClaudeCodeAdapter
 └── OpenCodeAdapter

each Adapter
 ├── Brokered Route: AI SDK `HarnessAgent`
 └── Native Route: installed CLI
```

One Adapter per Harness normalizes what callers must reason about and absorbs what they must not:

- a single Pass invocation with progress and cancellation;
- resolved capabilities, including supported Autonomy and instruction-boundary enforcement;
- Reprove-owned Reviewer instructions;
- opaque Model identifiers pinned by the control plane;
- strict Result and Evidence validation outside the Sandbox;
- bounded repair of malformed output;
- typed Harness options, with unknown raw configuration rejected.

The Adapter runs Worker-side, outside the Sandbox. Route is its private implementation detail;
callers gate dispatch on Exposure, Isolation, and Provenance rather than Route.

Do not force false uniformity. Harness-specific behavior stays behind the Adapter boundary, and a
missing enforceable capability produces a Refusal rather than a silent downgrade.

---

# 20. Why These Three Harnesses

## Codex

Covers the OpenAI coding-agent ecosystem.

Relevant capabilities include Repository exploration, shell execution, file editing, testing/build workflows, and persistent Harness sessions.

## Claude Code

Covers Anthropic's coding-agent ecosystem.

Provides another strong general-purpose coding runtime and enables cross-lab review against Codex-generated work.

## OpenCode

Provides the broader provider/model path.

OpenCode allows clients to select among models exposed by connected providers and supports custom/provider-specific configuration.

This keeps initial scope narrow while avoiding a product tied entirely to OpenAI and Anthropic.

---

# 21. Self-Hosted Worker

```text
Control Plane
      ↓
Run
      ↓
Self-Hosted Worker
      ↓
Sandbox
 ├── Workspace
 └── Harness
      ↓
Result
```

Possible environments:

- developer workstation;
- home server;
- VPS;
- dedicated server;
- self-hosted CI runner.

Supported platforms:

Linux kernel plus Docker or Podman, with rootless containers preferred. A self-hosted Worker is a
host process, not a process inside the Sandbox. macOS and Windows are supported only through a
Linux VM; native Windows containers are not supported.

---

# 22. Self-Hosted Authentication

Provider credentials remain on the Worker.

The control plane knows:

```text
Worker ID
Online status
Supported harnesses
Supported models/capabilities
Concurrency
```

The control plane does not receive:

```text
ChatGPT credentials
Claude credentials
OpenCode provider keys
```

Conceptual setup:

```text
Install worker
    ↓
Configure harnesses
    ↓
Authenticate locally
    ↓
Enroll Worker
    ↓
Receive Runs
```

Example:

```text
$ reprove status

Codex       ✓ authenticated
Claude Code ✓ authenticated
OpenCode    ✓ configured

Worker      ✓ connected
```

## Provider authentication constraints

State the mechanism plainly, and state what each provider has actually published. Reprove
neither interprets a provider's terms on the user's behalf nor promises that any
authentication path is cheaper, permanent, or guaranteed to remain supported.

**What Reprove does.** A self-hosted Worker invokes the user's installed, unmodified Codex,
Claude Code, or OpenCode CLI using authentication the user manages - the Native Auth Route
([ADR 0003](adr/0003-two-invocation-routes.md)). Reprove does not receive, store, proxy, or
intermediate that authentication: no ChatGPT token, no Claude token, no `~/.codex/auth.json`,
no provider key, no credential cache reaches the control plane. Hosted Runs never use this Route; they use the Brokered Harness
Route with managed API/Gateway authentication.

**The usage model.** A Run on this Route consumes the provider usage the configured Harness
already carries. Where that authentication is subscription-backed, the Run draws on the plan's
included allowance rather than requiring separate Reprove-metered API usage. Both major
providers document this directly - OpenAI: *"Your plan's included usage is used first"*, and
*"When you sign in with an API key, Codex uses standard API pricing instead of included ChatGPT
plan credits"*; Anthropic documents the inverse, that an `ANTHROPIC_API_KEY` in the environment
diverts Claude Code onto API billing *"rather than using your subscription's included usage"*.

Two operational consequences follow, and both are product concerns rather than footnotes:

- **A Worker on this Route must not set `ANTHROPIC_API_KEY` in the Harness environment**, and
  should warn when one is present. Otherwise a user who chose the Native Route specifically to
  use their subscription is silently billed API rates.
- **Claude limits are pooled across Claude Code and Claude.ai.** An unattended Run consumes the
  same allowance the developer uses interactively, so concurrency and rate limits on this Route
  affect a human's own experience, not just Reprove's throughput.

**What the providers have documented.** Verbatim sources are collected in
[`docs/research/provider-auth-and-usage.md`](research/provider-auth-and-usage.md); cite that
file rather than restating terms from memory.

- **OpenAI documents non-interactive Codex for automation.** Its documentation says `codex exec`
  runs Codex from scripts, including CI jobs, and explicitly lists pipelines, pre-merge checks, and
  scheduled jobs. This is the mechanism the Native Auth Route uses.
- **`codex exec` reuses the user's existing login:** *"`codex exec` reuses saved CLI
  authentication by default."* No credential is supplied by Reprove.
- **API keys are OpenAI's recommended default for automation:** *"The right way to authenticate
  automation is with an API key"*, and *"API keys are still the recommended option for most
  CI/CD jobs."* **Reprove describes the Native Auth Route as documented and supported, never as
  the provider's recommendation.**
- **A separate advanced page** documents a different pattern - creating `auth.json` on a trusted
  machine, placing it on a CI runner, and persisting the refreshed file between jobs - and warns
  that *"this workflow"* must not be used for public or open-source repositories. **That warning
  is bound to that pattern**, and the Native Auth Route is not it: nothing is seeded onto a
  runner, persisted, or refreshed on Reprove's behalf. **Do not generalize it into a
  repository-visibility restriction.** See §23.
- **Anthropic** restricts OAuth subscription authentication to ordinary use of native
  applications, and forbids developers from offering Claude.ai login in their own applications,
  routing requests on a user's behalf, or collecting, storing or intermediating credentials or
  session tokens. It then carves out precisely the case Reprove implements: *"Nor does it
  prevent an end user from signing in to the unmodified Claude Code binary with their own Claude
  subscription, including where a platform hosts Claude Code"*, provided the binary is
  unmodified and each end user authenticates with their own credentials, billed directly to
  them. **The Native Auth Route satisfies every one of those conditions by construction.**
- **The unattended, webhook-triggered Run** remains the gap. Neither vendor's documentation uses
  the words "unattended" or "webhook-triggered", and Anthropic notes that advertised limits
  *"assume ordinary, individual usage"*. Reprove records this combination as **unaddressed
  rather than blessed or prohibited**, and does not resolve it on the user's behalf.
- **This ground moves.** Anthropic changed position four times between January and June 2026 -
  client blocks, then formal terms language, then full enforcement against third-party tools,
  then an announced reversal, then a pause on the day that reversal was to take effect, still
  unresolved. Its live documentation currently contradicts itself on whether subscription
  credentials may back third-party Agent SDK usage. **None of that touches the clause Reprove
  relies on** - the Native Auth Route runs the unmodified CLI, not the Agent SDK - but it is
  why no Reprove document may describe any of this as settled, and why the constraints here
  cite URLs rather than dates.

**What Reprove does not claim.** That subscription authentication is a cost-avoidance
strategy, that it will remain available, or that any Route is safe for `external` Provenance
before the isolation boundary in §23 establishes and verifies it.

---

# 23. Self-Hosted Security Boundary

Reprove assumes repository code executes arbitrary code inside the Sandbox. One Sandbox contains
both the Harness and the Workspace for one Pass; Reprove does not claim to isolate repository
execution from the Reviewer.

The Sandbox contract is shared across hosted and self-hosted Workers and defined by properties,
not by a runtime:

```text
Sandbox
 ├── private network, PID, and mount namespaces
 ├── no host bind mounts or container-runtime socket
 ├── seccomp, resource limits, and ephemeral storage
 ├── egress only through Reprove's policy proxy
 └── teardown after the Pass
```

Implementations differ: Vercel Sandbox supplies `microvm` Isolation for hosted Workers; the local
Docker/Podman provider supplies `container-rootless` or `container` Isolation. Below `container`
there is no Sandbox and no Run.

Credential handling depends on the resolved Route:

```text
Brokered Route
  usable credential remains outside the Sandbox
  placeholder is replaced only by the egress proxy
  Exposure = none

Native Route
  user-managed authentication is inside the Sandbox
  Exposure is computed from that credential
  risk is bounded by Provenance, Isolation, and revocability
```

Dispatch gates on `Exposure × Isolation × Provenance`, never on Route. `Exposure` and `Isolation`
are computed and recorded on the Run; `Provenance` is computed from the pull request and recorded
with its basis. A stale capability probe or a missing hard property produces a visible Refusal.
Nothing warns and runs.

Three public promises are intentionally narrow and testable:

```text
1. On the Brokered Route, no usable credential enters the Sandbox.
2. The Sandbox has no GitHub authority.
3. A weakened posture never runs quietly.
```

On the Brokered Route, a compromised Sandbox may still spend the Run's remaining budget against an
allowed endpoint or attempt exfiltration through an explicitly permitted destination. Brokering
prevents credential theft; it does not eliminate bounded authorized-service abuse.

## A note on provider automation guidance

OpenAI's guidance for account-authenticated Codex is worth reading precisely, because it is
easy to over-generalize - an earlier draft of this document did exactly that. What the
documentation establishes is four narrow facts:

1. **Non-interactive Codex is explicitly supported for automation**, named for CI, pre-merge
   checks and scheduled jobs.
2. **`codex exec` reuses saved CLI authentication by default.**
3. **API keys are OpenAI's recommended default** for automation.
4. **A separate advanced page** documents seeding a ChatGPT-managed `auth.json` onto a CI runner
   and persisting the refreshed file between jobs, and warns that *"this workflow"* must not be
   used for public or open-source repositories.

Reprove's Native Auth Route is fact 1 and 2, not fact 4. The user authenticates their Codex
installation normally, on infrastructure they control, and the Worker invokes the already
authenticated CLI:

```text
The warned-against pattern              The Native Auth Route
──────────────────────────              ─────────────────────
codex login on a trusted machine        user logs in to their own Codex
copy auth.json onto the CI runner       nothing is copied
persist it between jobs                 nothing is persisted by Reprove
Codex refreshes it on the runner        the already-authenticated CLI is invoked
```

One sentence on OpenAI's general auth page - *"Don't expose Codex execution in untrusted or
public environments"* - is genuinely ambiguous between execution infrastructure and repository
visibility, and the documentation never disambiguates it. Reprove records both readings rather
than resolving it in its own favour.

**Nothing in the provider guidance found so far establishes a repository-visibility restriction
that Reprove must enforce**, and this document does not invent one. What survives is a security
question rather than a terms question. Repository visibility is not a Route gate; the durable risk
input is Provenance, combined at dispatch with Exposure and Isolation.

---

# 24. Hosted Worker

```text
Control Plane
      ↓
Hosted Worker
 ├── Adapter                           outside the Sandbox
 └── Vercel Sandbox                    one per Pass
      ├── Workspace
      ├── Codex / Claude Code / OpenCode
      └── brokered access to AI Gateway
```

Hosted execution uses Gateway/API credentials rather than consumer sessions.

The hosted Worker is provisioned per Run and has no durable Worker identity, enrollment, claim,
Lease, or polling lifecycle. Adapter-side Result and Evidence schema validation stays outside the
Sandbox; the Harness and Workspace share it.

---

# 25. OpenCode Configuration

For self-hosted OpenCode users, provider configuration should preferably remain OpenCode's responsibility.

```text
OpenCode
 ├── OpenCode Go
 ├── OpenAI
 ├── Google
 ├── OpenRouter
 ├── local model
 └── custom provider
```

OpenCode supports selecting models from the providers available to the current project, including per-run selection.

Preferred direction:

> Do not rebuild OpenCode's provider-management system.

At launch Reprove owns only the pinned Repository-configured Model. OpenCode's provider management
and any interactive per-run selection remain OpenCode concerns; Reprove does not rebuild them.

---

# 26. Review Workflow

```text
1. Receive PR event

2. Resolve repository configuration

3. Create Run

4. Choose Worker

5. Choose Harness

6. Choose Model

7. Choose Strategy

8. Prepare exact base/head commits

9. Start Reviewer

10. Reviewer inspects change

11. Reviewer explores relevant Repository context

12. Reviewer forms hypotheses

13. Reviewer verifies hypotheses where useful

14. Reviewer rejects unsupported hypotheses

15. If Autonomy is `fix`:
      modify code
      run verification
      return Patch

16. Normalize Result

17. Publish GitHub review

18. Persist Run metadata
```

For multi-Reviewer Strategies, steps 9 through 15 may execute through more than one Harness.

---

# 27. Result and Finding

```text
Result
 ├── completeness: complete | partial
 ├── stoppedBy?                  required only when partial
 ├── summary
 └── findings[]
```

Finding:

```text
Finding
 ├── path
 ├── line/range + anchoredText
 ├── title
 ├── body
 ├── severity
 ├── verification
 ├── evidence[]
 └── patch?
```

A partial Result is acceptable and publishes its Findings, but leaves the Run `incomplete`. A
partial Result with no Findings publishes no Review, because an unfinished review must never read
as a clean bill of health. A Result is one strictly size-bounded atomic payload and has no table;
Acceptance absorbs it into the Run.

Do not make parsing arbitrary Markdown the core integration contract.

---

# 28. Verification

The fixed ladder is:

```text
static
```

Reasoned only. Carries no Evidence.

```text
inconclusive
```

Execution was attempted but did not settle the claim. Carries Evidence.

```text
verified
```

Execution demonstrated the claim. Requires Evidence.

Verification is the whole trust signal a Finding carries. There is no confidence field.

---

# 29. Fix Workflow

```text
Finding
   ↓
Create Workspace change
   ↓
Run targeted verification
   ↓
Run broader checks
   ↓
Generate verified Patch
```

Possible outcomes:

```text
Patch verified

Patch generated but Verification failed

Unable to safely fix
```

The system never claims a Patch was verified when Verification failed. Acceptance rejects a Patch
unless the Run's Autonomy is `fix`.

GitHub delivery method:

**Deferred to the per-phase fix workflow map.**

---

# 30. Repository Configuration

Settled by [ADR 0011](adr/0011-repository-configuration-contract.md). `.reprove.yml` at the
repository root: inert YAML 1.2 core schema, no custom tags, merge keys or aliases, size- and
depth-bounded, one strict zod schema in which **unknown keys are rejected**. Executable
configuration is ruled out, because base configuration is read host-side on the Worker, outside
the Sandbox. The normative schema is [`docs/spec/repository-configuration.ts`](spec/repository-configuration.ts).

**The whole file is read from the base ref.** There is no split rule:

> A pull request cannot change the configuration used to review itself.

Two sections carry two resolution rules, so the rule follows the section rather than a list kept
in merge code:

```yaml
review:                      # Repository value beats Owner value beats Reprove default
  enabled: true
  worker: self-hosted        # resolves onto the Run's spec.placement
  harness: codex
  model: [catalogue id]
  strategy: standard
  autonomy: verify
  budget: [number]
  deadline: [duration]
  event: COMMENT             # REQUEST_CHANGES is opt-in
  threshold:
    severity: medium
    verification: any
  ignore:
    - generated/**
  commands:                  # Project commands; see §31
    install: pnpm install
    build: pnpm build
    test: pnpm test
    typecheck: pnpm typecheck
  baseConventions: true      # ADR 0009's re-admission switch
  harnessOptions: {}         # ADR 0005's typed options; empty at launch
  overrides:                 # last match wins; path-local keys only
    - paths: [packages/web/**]
      threshold: { severity: high }

security:                    # meet(Reprove boundary, Owner ceiling, Repository request)
  maxExposure: account
  allowExternalProvenance: false
  installScripts: deny
  allowHostedFallback: false
  egress: []
```

In `security:` the Owner layer is a **Ceiling, never a default**: it permits a Repository to
request something, and never switches it on. A key belongs there only if its type has a defined
narrowing operation, which is why Threshold does not.

`ignore` binds at publication: matching Findings are kept internally and not projected onto
GitHub. It does not remove files from the Workspace, restrict what the Reviewer reads, or change
verification. Cost belongs to `budget`.

**Route is deliberately absent.** An Owner constrains `maxExposure`, not which Routes are
permitted; configuration constrains the properties Reprove gates on, never how an Adapter
achieves them.

Invalid configuration is a `Refusal` with a failing Check and no Run, never a fall back to
defaults. A pull request that changes `.reprove.yml` gets an independent **`Reprove config`**
Check validating the head file prospectively without applying it, which runs even where review
execution does not.

---

# 31. Project Commands

Repositories may already know the correct commands for their own toolchain. `CONTEXT.md` calls
these **Project commands**; the word `validation` is reserved for zod schema validation and is not
used here.

```yaml
review:
  commands:
    install: pnpm install
    build: pnpm build
    test: pnpm test
    typecheck: pnpm typecheck
```

Settled by [ADR 0011](adr/0011-repository-configuration-contract.md):

- a **fixed set of four keys**, never an open map, because an open map is an arbitrary-string
  escape hatch and every field in the configuration snapshot must declare a retention class;
- **resolved from the base ref**, like the rest of the file;
- **hygiene, not a control.** Under `verify` Autonomy the Reviewer holds a shell and can run
  anything the head contains. The control is the Sandbox ([ADR 0004](adr/0004-sandbox-boundary-and-credential-isolation.md)).
  Configured commands save the Reviewer from rediscovering the toolchain; they do not constrain it,
  and a Reviewer may still run additional targeted checks;
- the **only content-bearing fields** in the configuration. Command strings can carry credentials,
  URLs or literal data, so they are purged from the Run's stored `resolvedConfig` at 90 days under
  [ADR 0008](adr/0008-persistence-tenancy-and-retention.md)'s clock while the rest of the
  configuration is preserved indefinitely.

---

# 32. Incremental Reviews

Each Run binds to:

```text
base SHA
head SHA
```

Requirements:

- reject stale Results through control-plane Acceptance;
- cancel and supersede old Runs;
- suppress duplicate Comments without deleting Findings;
- reconcile against prior published Findings;
- handle duplicate webhooks idempotently.

Reconciliation compares the current Run against the most recent prior Run for the pull request that
successfully published a Review. Findings enter candidate buckets by `path + normalized anchored
source hash`; exactly one prior and one current Finding in a bucket match as `recurring`. Every
ambiguous cardinality fails open to `new`.

The candidate set contains only prior Findings that actually produced an inline Comment. Dedupe
suppresses the current Comment, never the Finding. On the prior side, `anchor_changed` and
`not_reproduced` are internal facts and never claims that a defect was fixed.

---

# 33. Worker Protocol

Worker responsibilities:

- enroll once, then register repeatedly;
- authenticate to the control plane;
- advertise harnesses;
- advertise models/capabilities;
- report health;
- poll for claimable Runs;
- claim a Run and hold its Lease;
- execute Passes;
- stream progress;
- return a structured Result;
- support cancellation.

The self-hosted Worker is always the HTTPS client and the control plane is always the server. There
is no inbound Worker port, push channel, WebSocket, or SSE connection:

```text
Worker polls
  → claim + Lease
  → progress and Lease renewal
  → continue | cancel response
  → atomic Result or terminal Failure
```

Scheduling is two-phase. The control plane selects candidates from deliberately stale advertised
capabilities; the claiming Worker performs the fresh resolved probe and either commits the claim or
returns a structured Refusal. A bounded `claimableUntil` makes waiting visible and terminal.

`protocolVersion` is an integer compatibility family and `workerBuildVersion` identifies the
implementation. Both are recorded on the Run. Hosted Workers share the Result, progress, and
Acceptance contract but do not exercise enrollment, registration, polling, claim, or Lease.

---

# 34. GitHub Repository Access

Private repositories require temporary worker access.

Settled flow:

```text
Worker claims Run
      ↓
Worker requests repository access
      ↓
Control plane mints a short-lived, single-Repository installation token
      ↓
Worker materializes the Workspace host-side
      ↓
Worker strips remotes, credential helpers, hooks, and host references
      ↓
Token is destroyed before the Sandbox starts
```

Do not distribute the GitHub App private key.

Preferred ownership:

```text
Worker:
- materialize the Workspace
- execute the Run

Control Plane:
- own GitHub App
- publish Reviews and Comments
```

The GitHub App private key is never distributed. Installation tokens are minted just in time and
never persisted in a queued assignment. The Sandbox has no GitHub credential or authority.

---

# 35. Security Requirements

## Both Worker placements

Treat pull-request code and narrative as untrusted. Reprove assumes repository code executes
arbitrary code inside the Sandbox.

Protect against:

- malicious build scripts;
- malicious dependencies;
- repository-controlled privileged instructions;
- Author-controlled narrative steering;
- credential exfiltration;
- arbitrary network access;
- cross-repository leakage;
- webhook replay;
- Reviewer tool abuse;
- stale Runs.

Repository-controlled text never enters a channel the Harness treats as privileged configuration,
permissions, instructions, or authorization. Native Harness suppression is provisioned in the
Sandbox environment; targeted sanitization covers only surfaces suppression provably cannot reach.
Trusted base-ref prose conventions are re-admitted through a Reprove-controlled, subordinate
channel. Dispatch requires a fresh behavioral probe of this boundary for the exact Harness builds.

Pull-request title and description are supplied as bounded protected JSON with `authority: none`,
never interpolated into instructions or the initial prompt. These controls prevent Author content
from increasing a Run's authority; they do not promise that a Model cannot be persuaded within the
authority it already has.

## Self-hosted

- provider credentials remain worker-owned;
- Brokered Route credentials remain outside the Sandbox;
- Native Route credentials are inside the Sandbox, with risk bounded by Exposure, Isolation,
  Provenance, and revocability;
- GitHub credentials are temporary;
- Workspace isolated per Run;
- Worker credentials are revocable.

## Hosted

- one Sandbox per Pass;
- temporary Repository credentials;
- Gateway credentials brokered outside the Sandbox;
- Sandbox destroyed after execution.

Egress is default-deny and phased, restricted by host, method, and path. Install may reach configured
package registries. Verification may reach the resolved Model or Gateway endpoint and explicit
Repository-approved destinations. There is no ordinary allow-all. The proxy always enforces request
count and size, body size, wall-clock, concurrency, and denial of unmatched requests; provider-level
token, Model, or spend limits apply only where the resolved credential supports them.

---

# 36. Persistence

Persisted entities:

```text
Better Auth, untouched: user, session, account, verification

owner
installation
repository
worker
worker_credential
enrollment_code
run
finding
publication
```

Every Owner-scoped Reprove table is protected by application scoping plus Postgres RLS. GitHub's numeric
Owner id is the tenant key. Runtime connections use a restricted non-`BYPASSRLS` role and
transaction-local tenant context; boot refuses if the boundary is misconfigured. Better Auth has no
Reprove membership relation, and authorization is answered live by GitHub.

Result has no table: Acceptance absorbs it into `run`. Evidence, Patch, Passes, and Refusals are
bounded JSONB; Findings are rows because Reconciliation queries them across Runs. Repository stores
no review configuration; each Run stores `resolvedConfig` plus `configDigest`.

One 90-day clock purges content-bearing fields in place: anchored source, Finding title and body,
Evidence excerpt and command text, and the content-bearing part of resolved Project commands. Run
metadata, Severity, Verification, paths, dispositions, counts, bucket keys, and audit facts remain.
Installation removal revokes the grant and deletes nothing; explicit Owner deletion removes all
Owner-scoped Reprove data.

---

# 37. Observability

The Run is the durable audit record. It records bounded terminal facts including:

```text
repository
PR
base SHA
head SHA
placement
harness
model
strategy
autonomy
worker/sandbox
route
isolation
exposure
provenance + provenance basis
protocol and worker build versions
status
duration
Project commands, purged after 90 days
failure reason
```

Hosted:

```text
Provider
Usage
derived cost where a marginal price exists
```

Normalized Usage crosses the Worker protocol. A Native Route Run may consume an allowance the user
already holds, so Reprove does not present API-price-table arithmetic as that user's actual cost.

Progress events cross the protocol for liveness and cancellation but are not persisted. There is no
event table or stored Run timeline. Product analytics may contain bounded non-content facts, never
source, Finding prose, Evidence, command text, transcripts, or raw progress events.

---

# 38. Competitive Positioning

## The thesis

> **Reprove combines the experience of manually asking Codex or Claude Code to deeply review
> your code with the automation and GitHub workflow of a dedicated PR review bot.**

Two things developers already do separately, joined:

```text
What you do by hand today          What a review bot does today
─────────────────────────          ────────────────────────────
open Codex / Claude Code           arrives on every pull request
point it at the repository         posts anchored comments
ask it to review the change        applies severity and policy
it explores, builds, tests         dedupes across pushes
you read its answer                a review a team already reads

              ↓ Reprove is both ↓

PR opened
 → Reprove dispatches the Run
 → your existing Codex / Claude Code / OpenCode performs it
 → with its full normal capabilities and your provider usage
 → Findings return as a GitHub Review
```

Not "another AI reviewer with a better model," and not "an orchestrator that can also touch a
pull request." The claim is continuity: the Harness your team already trusts to *write* the
software becomes the Reviewer that examines it, keeping the general capabilities that made it
useful in the first place - repository exploration, shell execution, builds, tests, one-off
scripts, reproduction, verification, and eventually fixes.

The short form, for a headline rather than a spec:

> **Turn the coding-agent Harnesses you already use into autonomous Reviewers.**

Reprove then supplies the product layer that a Harness does not have on its own:

- GitHub-native automatic review on a pull request;
- structured Findings anchored to a location;
- Verification and Evidence semantics, so a claim's standing reflects what the Reviewer did;
- Harness and Model choice;
- cross-harness and adversarial Strategies;
- hosted and self-hosted Workers;
- explicit credential posture: Brokered isolation, or Native gating by Exposure, Isolation, and
  Provenance;
- review UX that fits how the team already reads a pull request;
- fix and re-verify workflows.

## The category is pull-request review

Reprove is a **PR review bot**: it arrives automatically on a pull request and leaves
anchored, severity-tagged, threshold-filtered Findings in a GitHub Review. That is the
category, and it is the only set Reprove positions against.

This matters because a naive search for "multi-Harness plus cross-Harness review" surfaces
projects that are **not in the category** - Harness orchestrators and session managers that let
you drive Codex, Claude Code and OpenCode from one place, and that may expose a GitHub
surface where a mention summons a Harness onto a pull request. That is orchestration, not
review. A reviewer is defined by the workflow it fits into: unprompted arrival on every pull
request, one Finding per location, Severity and Verification a team can set policy on, dedupe
across pushes, and a Review a human reads the way they read any other.

Those projects are **adjacent prior art, not competitors.** Some of them independently built
multi-harness plumbing, and that is worth knowing and acknowledging honestly. It is not worth
positioning against, and their existence does not weaken the claim below.

## Do not position solely around code execution

Execution is no longer a differentiator. Managed reviewers already run code: at least one
runs its reviews inside an isolated microVM where it writes and executes shell scripts. The
product must not rely on:

> "We run tests and they don't."

## Do not position on being multi-harness for its own sake

Supporting several Harnesses is plumbing, not a product claim - and *multi-harness
orchestration* is a different category, not a competing one. What matters is not that Reprove
speaks to three Harnesses; it is that the Reviewer performing the review **is the Harness you
already use**, with your Model, your authentication and your configuration. Harness choice is
the mechanism. Harness *continuity* is the claim.

## What is actually unclaimed

Within the category, every reviewer either brings its own model or locks you to one vendor:

| Reviewer | Who chooses the Reviewer |
|---|---|
| CodeRabbit | Vendor. Managed models, blended internally; explicitly argues users should not have to choose. |
| Greptile | Vendor. External coding-agent Harnesses are handed a *fix*, never the Review. |
| PR-Agent | User picks a **Model**, but the Reviewer loop is PR-Agent's own. |
| shippie | User picks a **Model**; single Reviewer loop, not a Harness. |
| Claude Code Review | Anthropic. Claude only, by construction. |
| Codex automatic reviews | OpenAI. Codex only, by construction, and diff-only. |
| **Reprove** | **You. The Reviewer is your Harness, on your authentication.** |

**Not one Reviewer in the category lets the Reviewer be the coding-agent Harness the team already
uses.** That is the unclaimed position, and everything else Reprove offers - cross-harness
Strategies, execution-backed Findings, hosted and self-hosted Workers - is what makes that
continuity useful rather than a novelty.

One asymmetry is structural rather than a matter of feature parity: **the vendor-native
reviewers cannot offer Harness choice.** A single-vendor reviewer that let a user pick a
competitor's Harness would be shipping that competitor's product. That axis is closed to
the largest incumbents permanently, not until they get around to it.

The current state of both the category and the adjacent orchestrators is recorded in
[`docs/research/competitive-landscape.md`](research/competitive-landscape.md), a dated
snapshot that should be re-verified rather than trusted indefinitely.

## Hosted and self-hosted state the claim differently

The unifying claim is the **Harness**, not the local setup. Say both halves rather than
blurring them:

- **Hosted Reprove** runs the same coding-agent Harnesses as a managed service, using
  brokered API/Gateway authentication.
- **Self-hosted Reprove** runs those same Harnesses on infrastructure you control, and can
  use the authentication and configuration you manage.

Hosted preserves the Harness experience; self-hosted additionally preserves your environment
and authentication. Neither is the lesser tier - hosted targets the same developers with less
operational work.

### The Native Auth Route's usage model is a first-class benefit

On the Native Auth Route, the Run consumes the provider usage the user's Harness already has.
This is a real and deliberate property of the design, not an incidental side effect, and it
belongs in the positioning:

> A self-hosted Worker on the Native Auth Route uses the authentication and provider usage
> model of the user's configured Harness. Where that authentication is backed by an existing
> subscription or included usage allowance, review Runs consume that allowance rather than
> requiring Reprove-specific metered API usage.

It is the economic consequence of the thesis rather than a separate pitch: if the Reviewer
really is the Codex or Claude Code you already run, then it bills the way that Codex or Claude
Code already bills. Nothing is being circumvented - the same account, the same plan, the same
provider terms, triggered by a pull request instead of by a person.

The mechanics are verified rather than assumed - OpenAI documents that a plan's *"included
usage is used first"* and that API-key sign-in bills *"standard API pricing instead of included
ChatGPT plan credits"*; Anthropic documents the same boundary from the other side. Sources are
in [`docs/research/provider-auth-and-usage.md`](research/provider-auth-and-usage.md).

Five limits on the claim, all of which must survive any rewording:

1. **It is a current capability, not a guarantee** about future provider pricing, limits, or
   authentication policy. This is evidenced rather than cautious boilerplate: one provider
   changed its position on subscription-backed third-party usage four times in seven months and
   is currently paused mid-change (§22).
2. **It does not apply to the Brokered Harness Route.** Hosted Runs use managed API/Gateway
   authentication and are metered accordingly.
3. **It is not a claim that Reprove is cheaper**, and never a comparison against a named
   competitor's pricing. What the user's plan allows is between the user and their provider.
4. **Reprove does not exist to circumvent API billing.** The mechanism is the user's own
   authenticated Harness on their own infrastructure; the usage model follows from that,
   rather than being the goal it was designed to reach.
5. **API keys are the provider's recommended default for automation.** Reprove presents the
   Native Auth Route as a documented and supported path, never as the one the provider
   recommends. It does not claim provider endorsement it has not been given - and equally,
   does not invent restrictions the provider has not stated. See §23.

Never quote a numeric usage allowance. Both vendors deliberately publish limits on pricing
pages rather than in documentation, precisely because they change.

## Why credential isolation is not the headline

Reprove's strongest architectural claim is narrower and testable: the Brokered Route keeps usable
credentials outside the Sandbox, the Sandbox has no GitHub authority, and a weakened posture never
runs quietly (§23, [`SECURITY.md`](../SECURITY.md)). The Native Route necessarily carries its
credential inside the Sandbox and is gated by Exposure, Isolation, and Provenance. This boundary is
deliberately not the lead.

It is an *enabling* property: it is the reason the product can be trusted, not the reason a
developer wants it. The first-order reason to want Reprove is that the coding-agent Harnesses you
already work with become your reviewers. Isolation is what makes that safe to run on code you
did not write. Lead with the promise; support it with the architecture.

## Positioning against managed reviewers

### Traditional managed reviewer

```text
Proprietary Review System
        ↓
Provider-selected models
        ↓
Provider-selected review architecture
        ↓
Provider infrastructure
```

### Reprove

```text
Reprove
   ↓
User chooses:
  worker
  harness
  model
  strategy
  autonomy
   ↓
Codex / Claude Code / OpenCode
```

CodeRabbit explicitly takes a managed-model approach and argues that its users should not need
to choose the underlying model. Reprove intentionally makes that choice available - and goes
further than model choice, because the thing the user selects is the whole Harness, not a
Model slotted into somebody else's Reviewer loop.

This is the right primary comparison. The managed reviewers are the incumbents in the
category, and the disagreement with them is genuine rather than a feature gap: they hold that
the Reviewer should be the vendor's problem, and Reprove holds that it should be the Harness the
team already works with.

### Core message

> Use the coding-agent Harnesses you already work with as autonomous PR Reviewers that inspect,
> verify, and optionally fix - with real repository execution behind every Finding.

---

# 39. MVP

Minimum useful loop:

```text
Install GitHub App
      ↓
Configure repository
      ↓
Open PR
      ↓
Review dispatched
      ↓
Reviewer investigates Repository
      ↓
Reviewer verifies selected Findings
      ↓
Structured review posted
```

Initial Harnesses:

```text
Codex
Claude Code
OpenCode
```

Required Autonomy:

```text
inspect
verify
```

`fix` Autonomy:

**Target for a later phase; GitHub write behavior is deferred to its phase map.**

A Reviewer may mutate the Workspace only under `fix` Autonomy. A Patch may be returned before any
GitHub write-back surface exists.

---

# 40. Development Roadmap

## Phase 0: Foundation

Establish the architecture before optimizing product behavior.

- initialize the pnpm/Turborepo package graph and enforce its dependency boundaries;
- define control-plane boundaries;
- create GitHub App;
- integrate direct Octokit webhooks;
- define Run, Result, and Finding;
- define Worker and Adapter interfaces;
- establish Neon, Drizzle, and Vercel Workflow foundations;
- establish Sandbox, instruction, credential, and Acceptance boundaries;
- create minimal local development workflow.

**Exit condition:** GitHub events can enter the system and create a Run ready for a Worker.

---

## Phase 1: MVP, Hosted `inspect` + `verify`

Build the first complete vertical slice using one Harness.

Suggested first target:

```text
GitHub
→ hosted Worker
→ Adapter + Vercel Sandbox
→ Codex
→ inspect/verify
→ GitHub Review
```

Scope:

- automatic/manual PR trigger;
- exact PR checkout;
- repository inspection;
- run builds/tests/scripts;
- structured Findings;
- inline comments;
- review summary;
- basic repository configuration;
- basic Run status, Refusal, and Failure handling.

**Exit condition:** A real GitHub pull request can be reviewed and selectively verified end to end.

---

## Phase 2: Multi-Harness, Model Choice, Review Strategies

Turn the MVP into the actual product architecture.

Add:

- Claude Code;
- OpenCode;
- Harness selection;
- Model selection where supported;
- OpenCode provider/model delegation;
- standard Strategy;
- manual cross-harness/adversarial review;
- normalized capability discovery;
- Harness-specific configuration boundaries.

Example supported workflow:

```text
Claude-generated PR
→ Codex review
```

or:

```text
Codex-generated PR
→ Claude Code review
```

**Exit condition:** The same pull-request workflow works through all three initial Harnesses without
leaking Harness-specific logic beyond their Adapters.

---

## Phase 3: Self-Hosted Worker

Add the self-hosted Worker lifecycle.

Scope:

- worker installation;
- Worker enrollment and registration;
- Worker authentication;
- capability/model advertisement;
- Run polling, claim, and Lease renewal;
- local Harness configuration;
- Native Route authentication where supported;
- Sandbox provisioning;
- credential isolation;
- health/status reporting;
- cancellation and failures.

Security is the main concern in this phase.

**Exit condition:** A GitHub review can execute entirely on user-controlled infrastructure without the control plane receiving AI provider credentials.

---

## Phase 4: `fix` Autonomy + Advanced Agentic Workflows

Move beyond review-only behavior.

Add:

- temporary source modifications;
- proposed Patches;
- targeted Patch Verification;
- broader post-Patch Verification;
- GitHub Patch delivery mechanism;
- Reviewer + verifier Strategies;
- optional cross-harness verification;
- Evidence-backed Findings;
- richer Strategies.

Potential:

```text
Codex produces a Finding
→ Codex proposes fix
→ Claude verifies fix
```

or:

```text
Claude reviews
→ Codex challenges high-severity findings
```

Exact workflows remain configurable rather than hard-coded.

**Exit condition:** The system can find, verify, repair, and re-verify a defect through a controlled
Reviewer workflow.

---

## Phase 5: Hardening + Productization

Make the system safe and practical for sustained usage.

Scope:

- incremental review reconciliation;
- duplicate detection;
- stale-Run cancellation;
- concurrency;
- retries;
- orchestration hardening;
- observability;
- hosted usage/cost tracking;
- security review;
- network controls;
- data retention;
- configuration UX;
- documentation;
- installer/setup UX;
- hosted billing **[if applicable]**;
- extension points for future harnesses.

Potential future work begins after this phase:

- Pi;
- GitLab;
- Bitbucket;
- multi-Reviewer consensus;
- automatic reviewer selection;
- cost-aware routing;
- deeper organization/team features.

---

# 41. Foundation Decisions and Deferrals

The foundation map resolved every structurally load-bearing question. Product behavior beyond that
boundary is explicitly deferred to the per-phase maps.

## Resolved foundation questions

1. **Self-hosted credential isolation:** Brokered credentials stay outside the Sandbox; Native
   credentials do not. Dispatch gates on Exposure, Isolation, and Provenance (§23).
2. **Self-hosted Sandbox:** one property-based Sandbox contract with runtime-specific
   implementations (§23).
3. **Subscription automation:** Reprove states the mechanism and provider evidence without ruling
   on a user's terms; the unattended webhook-triggered case remains unaddressed by providers (§22).
4. **OpenCode configuration:** Provider and authentication configuration remain Harness-owned;
   Reprove supplies typed Adapter options and a pinned Model (§19, §25).
5. **Model discovery:** the control plane owns a curated catalogue because the Harnesses expose no
   reliable runtime enumeration (§4.3).
6. **GitHub lifecycle:** direct Octokit webhooks and API (§15).
13. **`inspect` Autonomy:** read-only; no project execution or Workspace mutation (§9).
16. **Evidence for `verified`:** no Evidence, no `verified`; the Worker cross-checks claimed Evidence
   against Adapter-observed tool activity (§11, §28).
17. **Network access:** default-deny phased egress restricted by host, method, and path (§35).
23. **Automatic review:** pull-request open and synchronize events create Runs by default (§16).
24. **Severity:** `critical`, `high`, `medium`, `low`, consequence-anchored; no `info`.
25. **Confidence:** no field. Verification is the only trust signal (§28).
26. **Configuration:** `.reprove.yml`, base ref only, with structurally distinct `review:` and
   `security:` resolution rules (§30).
29. **Framework:** Next.js on Vercel.
30. **Database:** Neon Postgres + Drizzle, application scoping plus RLS, numeric Owner id tenant key.
31. **Durable orchestration:** Vercel Workflows, not Queue.
32. **Worker protocol:** outbound HTTPS polling, claim, Lease, bounded Result, and control-plane
   Acceptance (§33).
33. **Worker OS:** Linux kernel plus Docker or Podman; macOS and Windows through a Linux VM (§21).
34. **Observability:** terminal facts on the Run; no durable event stream (§37).
35. **Retention:** one 90-day content-field purge clock (§36).
36. **License:** Apache-2.0.
37. **Offering:** open core, with self-hosted Worker first-class and self-hosted control plane
   best-effort.

## Deferred to per-phase maps

- **Strategy:** Author identification, adversarial defaults, Reviewer composition, conflicting
  Findings, independence, and escalation (questions 7-12).
- **Reviewer behavior:** when Verification runs, temporary test and script policy, and execution
  deadlines (questions 14, 15, 18).
- **Fix workflow:** sequencing, GitHub delivery, human approval, and the bar for a verified Patch
  (questions 19-22).
- **Product:** dashboard scope and hosted billing (questions 27-28).
- **Extension surface:** support for third-party Harnesses and independently implemented Workers
  (question 38).

---

# 42. Core Design Principles

## 1. The harness is not just a model backend

Do not reduce Codex, Claude Code, or OpenCode to:

```text
prompt → response
```

Preserve their Harness capabilities.

## 2. Harness and model are separate choices

```text
Harness
→ runtime behavior

Model
→ underlying intelligence
```

Expose both where the harness permits it.

## 3. Give the Reviewer an environment

The Reviewer should be able to interact with the Workspace and verify claims through execution.

## 4. Reason, then verify

Prefer:

```text
hypothesis
→ experiment
→ evidence
→ finding
```

over:

```text
hypothesis
→ comment
```

when verification is practical.

## 5. Different Reviewers can challenge each other

The Reviewer does not need to use the same Harness or Model as the Author.

```text
Claude writes
→ Codex reviews
```

is a feature, not an edge case.

## 6. Patches should be verifiable

```text
change
→ test
→ report
```

not:

```text
change
→ assume
```

## 7. Execution location is replaceable

```text
Run
 ↓
Worker
 ├── self-hosted lifecycle
 └── hosted lifecycle
```

## 8. GitHub remains independent

GitHub ultimately receives a normalized Review regardless of:

- harness;
- model;
- provider;
- worker;
- sandbox;
- Strategy.

## 9. OpenCode is the initial flexibility layer

Codex covers OpenAI.

Claude Code covers Anthropic.

OpenCode covers the broader provider/open-model ecosystem.

That is enough initial coverage without expanding scope into additional harnesses.

## 10. Do not compete on capabilities competitors already have

"Runs your code" is not sufficient positioning.

The product identity is:

> **An open-source review system that turns user-selected coding-agent Harnesses and Models into
> autonomous pull-request Reviewers that inspect, verify, and optionally fix, with self-hosted or
> hosted Workers and cross-Harness Strategies.**
