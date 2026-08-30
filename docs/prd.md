# PRD: Reprove

**Product:** Reprove  
**Domain:** `reprove.dev`  
**Status:** Draft  
**Primary platform:** GitHub  
**Initial harnesses:** Codex, Claude Code, OpenCode  
**Primary use case:** AI pull request review, validation, and optional remediation using full coding-agent runtimes.

---

# 1. Product Identity

## Reprove

**Reprove** is an open-source agentic code review system that turns established coding agents into autonomous PR reviewers, validators, and optional fixers.

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

Build an open-source GitHub code review system powered by established coding-agent harnesses rather than a proprietary review-only LLM pipeline.

Initial agent targets:

- Codex
- Claude Code
- OpenCode

AI SDK 7 exposes Codex, Claude Code, OpenCode, Pi, and other established agent runtimes through the common `HarnessAgent` abstraction.

The product supports two execution modes:

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
Review + validation + optional fixes
```

Goals:

- run the Harnesses the user already has installed and authenticated;
- use the authentication the user manages, whatever form it takes;
- consume the provider usage that authentication already carries, rather than requiring
  separate Reprove-metered API usage;
- allow OpenCode provider/model configuration;
- keep provider credentials on user-controlled infrastructure, and out of the control plane.

### Hosted sandbox

Reviews run in isolated Vercel Sandboxes.

```text
GitHub
   ↓
Control Plane
   ↓
Vercel Sandbox
   ↓
HarnessAgent
   ↓
Codex / Claude Code / OpenCode
   ↓
AI Gateway
```

Hosted execution uses machine-oriented API/Gateway authentication rather than consumer subscription credentials.

---

# 3. Product Thesis

This should not be built as:

```text
PR diff
   ↓
LLM prompt
   ↓
Markdown comments
```

The coding agent gets an actual repository environment.

```text
PR
 ↓
Coding Agent
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

The reviewer should have the same general class of capabilities that makes Codex, Claude Code, and OpenCode useful as coding agents.

HarnessAgent is specifically designed to preserve capabilities above the model layer such as sandboxing, skills, sessions, permission flows, compaction, tools, and runtime configuration instead of reducing a harness to a single model call.

---

# 4. Core Differentiation

## 4.1 General-purpose coding agents are the review runtime

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

The product supplies the GitHub workflow, review strategy, isolation, result normalization, and product experience around those agents.

---

## 4.2 Harness choice belongs to the user

```text
Review with:

○ Codex
○ Claude Code
○ OpenCode
```

The user decides which coding-agent runtime they trust for the repository or individual review.

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

The UI/config should only expose models actually available through the selected harness/provider.

Exact discovery and configuration mechanism is harness-specific:

**[Needs Validation per harness]**

OpenCode explicitly supports selecting models from any provider available to the current project, including per-run model selection.

This is a meaningful competitive distinction. CodeRabbit intentionally does not expose underlying LLM selection to users and instead selects/blends models internally.

---

## 4.4 Use the coding agents you already work with

The reviewer is not a new tool to evaluate. It is the Harness your team already builds with,
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

OpenCode Go currently provides a low-cost subscription path focused on open coding models, while OpenCode itself allows model selection across connected providers.

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

A suspected problem does not need to immediately become a comment.

```text
Suspected issue
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

In fix-enabled modes:

```text
Confirmed issue
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

A model/harness that did not produce the implementation may challenge assumptions the original agent made.

The system should allow explicit configuration such as:

```yaml
review:
  harness: codex
```

even if another agent generated the PR.

Automatically determining which agent authored a change:

**[Undecided / Needs Info]**

Potential inputs could eventually include explicit configuration or metadata from integrations, but the product should not assume this metadata always exists.

---

# 6. Review Strategies

`reviewStrategy` should be treated separately from `harness`.

Potential strategies:

## Standard

```text
One harness
→ inspect
→ verify
→ report
```

Initial default.

## Adversarial

```text
Implementation agent A
        ↓
Reviewer agent B
```

The reviewer intentionally differs from the implementation agent.

## Reviewer + Verifier

```text
Agent A
→ generate findings

Agent B
→ challenge/verify high-value findings
```

Potentially useful for reducing false positives.

**[Future / Undecided]**

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

**[Future / Undecided]**

## Cost-optimized escalation

Example:

```text
Lower-cost model
→ initial scan
→ suspicious/high-risk area
→ stronger model/harness
```

OpenCode's broad provider/model support makes this particularly possible.

**[Future / Undecided]**

The architecture should allow these strategies without requiring them in the MVP.

---

# 7. Review Controls

The product should eventually separate four major choices:

```text
Execution
Self-hosted / Hosted

Harness
Codex / Claude Code / OpenCode

Model
Harness-dependent

Strategy
Standard / Adversarial / ...
```

Plus review autonomy:

```text
Mode
Review / Verify / Fix
```

Conceptual configuration:

```yaml
review:
  execution: self-hosted
  harness: codex
  model: [harness-supported-model]
  strategy: standard
  mode: verify
```

Exact configuration format:

Settled by [ADR 0011](adr/0011-repository-configuration-contract.md). Note that `mode` is not the
key: `CONTEXT.md` bans the word, and the three choices above are `worker`, `autonomy` and
`strategy`. `execution` is `worker`. See §30.

---

# 8. Goals

## Core

- Automatically review GitHub pull requests.
- Use real coding-agent harnesses.
- Initial support:
  - Codex
  - Claude Code
  - OpenCode
- Allow users to choose the harness.
- Allow users to choose the model where supported.
- Allow the agent to investigate the entire repository.
- Allow executable validation of findings.
- Support optional agent-driven fixes.
- Support cross-harness/adversarial review.
- Produce structured GitHub reviews and inline comments.
- Support self-hosted and hosted execution.
- Keep self-hosted provider credentials outside the control plane.
- Treat PR code as untrusted.
- Remain open source.
- Keep GitHub integration independent from execution backend and harness.

## Quality

Reduce speculative review findings by allowing the agent to validate claims where practical.

Instead of:

```text
"This may fail when X occurs."
```

the agent should be capable of attempting:

```text
1. reproduce X
2. execute affected code
3. observe behavior
4. report evidence
```

Not every finding must be executable.

---

# 9. Review Modes

## Mode A: Review

Primary goal:

```text
Find issues.
```

Capabilities:

- inspect diff;
- inspect repository;
- search references;
- inspect related code;
- reason about behavior.

Whether arbitrary execution is enabled in this lowest mode:

**[Undecided]**

No persistent source changes.

---

## Mode B: Verify

Primary goal:

```text
Find issues and validate them.
```

Agent may:

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
Execute validation
      ↓
Confirmed / rejected
```

Rejected hypotheses should not become review comments.

---

## Mode C: Fix

Primary goal:

```text
Find, validate, and repair issues.
```

Agent may additionally:

- edit source;
- modify tests;
- generate patches;
- rerun builds/tests;
- iterate until the proposed fix is validated.

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

How fixes reach GitHub:

- suggested patch;
- generated commit;
- separate branch;
- direct PR commit;
- follow-up PR.

**[Undecided]**

---

# 10. Agentic Validation

Validation is a first-class architectural capability.

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

Dependency issue
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

Where verification occurred, a finding should be able to include evidence.

Potential evidence:

- command executed;
- relevant test output;
- build output;
- stack trace;
- reproduction steps;
- temporary validation script;
- relevant logs.

Conceptual result:

```text
Finding
 ├── issue
 ├── location
 ├── explanation
 ├── severity
 ├── verified
 └── evidence
```

How much evidence is surfaced directly on GitHub:

**[Undecided]**

Large raw logs should not be dumped into PR comments.

---

# 12. Non-Goals / Future Scope

Not initially committed:

- automatic commit/push of fixes: **[Undecided]**
- auto-merge: **[Out of Initial Scope]**
- GitLab: **[Future]**
- Bitbucket: **[Future]**
- Pi harness: **[Future]**
- additional harnesses: **[Future]**
- multi-agent consensus review: **[Future]**
- team analytics dashboard: **[Undecided]**
- organization management depth: **[Undecided]**

Initial product stays focused on:

```text
GitHub PR
→ Agent review
→ Validation
→ Findings
→ Optional fix
```

---

# 13. Core Architecture

```text
                    GitHub
                       │
                       ▼
                   GitHub App
                       │
                       ▼
                 Control Plane
                       │
                  ReviewJob
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
      Self-Hosted Worker    Hosted Executor
             │                   │
             │             Vercel Sandbox
             │                   │
             └─────────┬─────────┘
                       ▼
                  HarnessAgent
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
        Codex      Claude Code    OpenCode
                       │
                       ▼
                 ReviewResult
                       │
                       ▼
                 Control Plane
                       │
                       ▼
                  GitHub Review
```

---

# 14. Technology

| Component | Decision |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 22+ / ESM |
| GitHub integration | Chat SDK GitHub adapter |
| GitHub-specific API | Octokit |
| Agent abstraction | AI SDK `HarnessAgent` |
| Harnesses | Codex, Claude Code, OpenCode |
| Hosted isolation | Vercel Sandbox |
| Hosted AI routing | Vercel AI Gateway |
| Control-plane framework | **[Undecided]** |
| Database | **[Undecided]** |
| Queue | **[Undecided]** |
| Authentication | **[Undecided]** |
| Control-plane hosting | **[Undecided]** |

AI SDK 7 requires Node.js 22+ and ESM and provides HarnessAgent adapters for Codex, Claude Code, OpenCode and other runtimes.

---

# 15. GitHub Integration

Use a GitHub App.

```text
GitHub event
    ↓
Webhook
    ↓
Chat SDK GitHub adapter / webhook handling
    ↓
Review orchestrator
```

Responsibilities:

- identify installation;
- identify repository;
- identify PR;
- receive PR lifecycle events;
- publish summaries;
- publish inline comments;
- optionally publish fixes.

Use Octokit where functionality exceeds Chat SDK's common abstraction.

Whether PR lifecycle events should flow entirely through Chat SDK or through a parallel direct GitHub webhook handler:

**[Needs Validation]**

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

**[Undecided]**

Likely MVP:

```text
PR opened / synchronize
→ automatically review
```

---

# 17. Normalized Review Job

```text
ReviewJob
 ├── repository
 ├── installation
 ├── PR
 ├── baseSHA
 ├── headSHA
 ├── executionMode
 ├── harness
 ├── model
 ├── strategy
 ├── reviewMode
 └── repositoryConfiguration
```

Everything after job creation should be largely independent of GitHub webhook implementation.

---

# 18. Review Executor

```text
ReviewExecutor
   │
   ├── HostedExecutor
   └── SelfHostedExecutor
```

The executor decides **where** the agent runs.

Harness configuration decides **what agent** performs the work.

Review strategy decides **how agents are composed**.

---

# 19. Harness Abstraction

```text
ReviewAgent
 ├── Codex
 ├── Claude Code
 └── OpenCode
```

Normalize where practical:

- session creation;
- instructions;
- skills;
- tools;
- repository workspace;
- model configuration;
- streaming;
- cancellation;
- result capture.

Do not force false uniformity.

Provider-specific behavior should remain behind adapter boundaries.

---

# 20. Why These Three Harnesses

## Codex

Covers the OpenAI coding-agent ecosystem.

Relevant capabilities include repository exploration, shell execution, file editing, testing/build workflows, and persistent agent sessions.

## Claude Code

Covers Anthropic's coding-agent ecosystem.

Provides another strong general-purpose coding runtime and enables cross-lab review against Codex-generated work.

## OpenCode

Provides the broader provider/model path.

OpenCode allows clients to select among models exposed by connected providers and supports custom/provider-specific configuration.

This keeps initial scope narrow while avoiding a product tied entirely to OpenAI and Anthropic.

---

# 21. Execution Mode A: Self-Hosted Worker

```text
Control Plane
      ↓
ReviewJob
      ↓
User Worker
      ↓
Repository Sandbox
      ↓
Harness
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

**[Undecided]**

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
Register worker
    ↓
Receive review jobs
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

- **OpenAI documents non-interactive Codex for automation.** *"Non-interactive mode lets you
  run Codex from scripts (for example, continuous integration (CI) jobs)… You invoke it with
  `codex exec`"*, and its own use-case list names *"Run as part of a pipeline (CI, pre-merge
  checks, scheduled jobs)."* This is the mechanism the Native Auth Route uses.
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

Unsafe:

```text
Sandbox
 ├── malicious PR
 └── provider credentials
```

Requirement:

> Repository code must not have direct access to long-lived AI/provider credentials.

Potential architecture:

```text
Worker Host
 ├── Authenticated Agent / Broker
 │
 └── restricted tool bridge
          ↓
    Repository Sandbox
```

Alternatives:

- agent outside sandbox;
- credential broker;
- runtime-specific isolation;
- provider-specific execution path.

**[Needs Research]**

This remains one of the primary technical blockers for production-safe self-hosted execution.
It is not a subscription problem: an API key worth thousands a month is as password-equivalent
as a consumer login, and both are equally exposed by sharing an environment with untrusted
repository code.

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
question rather than a terms question, and it is the same one this section already poses: the
credential and the untrusted repository code must not share an execution environment. That is
sharper when the repository is public and anyone may open a pull request, which makes
repository visibility a **risk input to the isolation design**, not a policy gate on the Route.

---

# 24. Execution Mode B: Hosted Sandbox

```text
Control Plane
      ↓
Vercel Sandbox
      ↓
HarnessAgent
      ↓
Codex / Claude Code / OpenCode
      ↓
AI Gateway
```

Hosted execution uses Gateway/API credentials rather than consumer sessions.

AI SDK's harness layer is designed to run these established harnesses in sandboxed environments while presenting a common agent interface.

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

Review-specific model overrides may still be useful.

---

# 26. Review Workflow

```text
1. Receive PR event

2. Resolve repository configuration

3. Create ReviewJob

4. Choose execution backend

5. Choose harness

6. Choose model

7. Choose review strategy

8. Prepare exact base/head commits

9. Start agent

10. Agent inspects change

11. Agent explores relevant repository context

12. Agent forms potential findings

13. Agent validates findings where useful

14. Agent rejects unsupported hypotheses

15. If Fix Mode:
      modify code
      run verification
      return patch

16. Normalize result

17. Publish GitHub review

18. Persist run metadata
```

For multi-agent strategies, steps 9 through 15 may execute through more than one harness.

---

# 27. Normalized Review Result

```text
ReviewResult
 ├── summary
 ├── verificationSummary
 └── findings[]
```

Potential finding:

```text
ReviewFinding
 ├── file
 ├── line/range
 ├── title
 ├── explanation
 ├── severity
 ├── confidence
 ├── verificationStatus
 ├── evidence
 └── proposedFix
```

Exact schema:

**[Undecided]**

Do not make parsing arbitrary Markdown the core integration contract.

---

# 28. Verification Status

Potential statuses:

```text
STATIC
```

Detected through analysis only.

```text
VERIFIED
```

Reproduced or otherwise demonstrated through execution.

```text
PARTIALLY_VERIFIED
```

Supporting evidence exists, but full reproduction was not possible.

Exact names:

**[Undecided]**

This can provide an important trust signal to reviewers.

---

# 29. Fix Workflow

```text
Finding
   ↓
Create working-tree change
   ↓
Run targeted verification
   ↓
Run broader checks
   ↓
Generate verified patch
```

Possible outcomes:

```text
Fix verified

Fix generated but validation failed

Unable to safely fix
```

The system should never claim a fix was verified when validation failed.

GitHub delivery method:

**[Undecided]**

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

Each run binds to:

```text
base SHA
head SHA
```

Requirements:

- avoid stale results;
- cancel/supersede old runs;
- avoid duplicate findings;
- reconcile resolved findings;
- handle duplicate webhooks idempotently.

Finding reconciliation algorithm:

**[Undecided]**

---

# 33. Worker Protocol

Worker responsibilities:

- register;
- authenticate to control plane;
- advertise harnesses;
- advertise models/capabilities;
- report health;
- receive jobs;
- execute reviews;
- stream progress;
- return structured results;
- support cancellation.

Transport:

- polling;
- WebSocket;
- SSE/callback;
- queue protocol.

**[Undecided]**

---

# 34. GitHub Repository Access

Private repositories require temporary worker access.

Preferred:

```text
Control Plane
      ↓
Short-lived GitHub installation token
      ↓
Worker
      ↓
Clone repository
```

Do not distribute the GitHub App private key.

Preferred ownership:

```text
Worker:
- clone/read repository
- execute review

Control Plane:
- own GitHub App
- publish reviews/comments
```

Final implementation:

**[Needs Validation]**

---

# 35. Security Requirements

## Both modes

Treat PR code as untrusted.

Protect against:

- malicious build scripts;
- malicious dependencies;
- repository prompt injection;
- credential exfiltration;
- arbitrary network access;
- cross-repository leakage;
- webhook replay;
- agent tool abuse;
- stale jobs.

## Self-hosted

- provider credentials remain worker-owned;
- sandbox cannot read provider credentials;
- GitHub credentials are temporary;
- workspace isolated per job;
- worker tokens are revocable.

## Hosted

- isolated sandbox per review;
- temporary repository credentials;
- Gateway credentials isolated from repository code;
- sandbox destroyed/reset after execution.

Network policy:

**[Undecided]**

---

# 36. Persistence

Likely entities:

```text
Account
GitHubInstallation
Repository
RepositorySettings

Worker
WorkerCapabilities

ReviewJob
ReviewRun
ReviewFinding
ReviewArtifact
```

Exact schema:

**[Undecided]**

Private repository contents should not be permanently stored unless required.

---

# 37. Observability

Each run should record:

```text
repository
PR
base SHA
head SHA
execution backend
harness
model
review strategy
review mode
worker/sandbox
status
duration
validation commands
failure reason
```

Hosted:

```text
provider
AI Gateway usage
estimated cost
```

Self-hosted usage visibility:

**[Depends on provider / Needs Validation]**

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

> **Turn the coding agents you already use into autonomous reviewers.**

Reprove then supplies the product layer that a coding agent does not have on its own:

- GitHub-native automatic review on a pull request;
- structured Findings anchored to a location;
- Verification and Evidence semantics, so a claim's standing reflects what the Reviewer did;
- Harness and Model choice;
- cross-harness and adversarial Strategies;
- hosted and self-hosted Workers;
- credential isolation between the Reviewer's authentication and the code it executes;
- review UX that fits how the team already reads a pull request;
- fix and re-verify workflows.

## The category is pull-request review

Reprove is a **PR review bot**: it arrives automatically on a pull request and leaves
anchored, severity-tagged, threshold-filtered Findings in a GitHub Review. That is the
category, and it is the only set Reprove positions against.

This matters because a naive search for "multi-harness plus cross-agent review" surfaces
projects that are **not in the category** - agent orchestrators and session managers that let
you drive Codex, Claude Code and OpenCode from one place, and that may expose a GitHub
surface where a mention summons an agent onto a pull request. That is orchestration, not
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

| Reviewer | Who chooses the reviewing agent |
|---|---|
| CodeRabbit | Vendor. Managed models, blended internally; explicitly argues users should not have to choose. |
| Greptile | Vendor. External coding agents are handed a *fix*, never the review. |
| PR-Agent | User picks a **Model**, but the agent loop is PR-Agent's own. |
| shippie | User picks a **Model**; single agent loop, not a Harness. |
| Claude Code Review | Anthropic. Claude only, by construction. |
| Codex automatic reviews | OpenAI. Codex only, by construction, and diff-only. |
| **Reprove** | **You. The reviewing agent is your Harness, on your authentication.** |

**Not one reviewer in the category lets the Reviewer be the coding agent the team already
uses.** That is the unclaimed position, and everything else Reprove offers - cross-harness
Strategies, execution-backed Findings, hosted and self-hosted Workers - is what makes that
continuity useful rather than a novelty.

One asymmetry is structural rather than a matter of feature parity: **the vendor-native
reviewers cannot offer Harness choice.** A single-vendor reviewer that let a user pick a
competitor's coding agent would be shipping that competitor's product. That axis is closed to
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

Reprove's strongest architectural claim is that untrusted repository code never shares an
execution environment with a password-equivalent Harness credential (§23,
[`SECURITY.md`](../SECURITY.md)). That is a real differentiator, and it is deliberately not
the lead.

It is an *enabling* property: it is the reason the product can be trusted, not the reason a
developer wants it. The first-order reason to want Reprove is that the coding agents you
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
model slotted into somebody else's agent loop.

This is the right primary comparison. The managed reviewers are the incumbents in the
category, and the disagreement with them is genuine rather than a feature gap: they hold that
the reviewing agent should be the vendor's problem, and Reprove holds that it should be the
agent the team already works with.

### Core message

> Use the coding agents you already work with as autonomous PR reviewers, validators, and
> optional fixers - with real repository execution behind every finding.

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
Coding agent investigates repository
      ↓
Agent verifies selected findings
      ↓
Structured review posted
```

Initial harness targets:

```text
Codex
Claude Code
OpenCode
```

Required modes:

```text
Review
Verify
```

Fix Mode:

**[Target, exact GitHub write behavior undecided]**

Even before GitHub write-back exists, the agent should be allowed to modify its temporary workspace when needed to determine whether a potential fix actually works.

---

# 40. Development Roadmap

## Phase 0: Foundation

Establish the architecture before optimizing product behavior.

- initialize project/repository structure;
- define control-plane boundaries;
- create GitHub App;
- integrate Chat SDK / GitHub webhooks;
- define `ReviewJob` and `ReviewResult`;
- define `ReviewExecutor` and `ReviewAgent` interfaces;
- establish database/job foundations;
- establish sandbox/security boundaries;
- create minimal local development workflow.

**Exit condition:** GitHub events can enter the system and produce a normalized review job.

---

## Phase 1: MVP, Hosted Review + Verify

Build the first complete vertical slice using one harness.

Suggested first target:

```text
GitHub
→ HostedExecutor
→ Vercel Sandbox
→ HarnessAgent
→ Codex
→ Review/Verify
→ GitHub Review
```

Scope:

- automatic/manual PR trigger;
- exact PR checkout;
- repository inspection;
- run builds/tests/scripts;
- structured findings;
- inline comments;
- review summary;
- basic repository configuration;
- basic run status/error handling.

**Exit condition:** A real GitHub PR can be reviewed and selectively validated end to end.

---

## Phase 2: Multi-Harness, Model Choice, Review Strategies

Turn the MVP into the actual product architecture.

Add:

- Claude Code;
- OpenCode;
- harness selection;
- model selection where supported;
- OpenCode provider/model delegation;
- standard review strategy;
- manual cross-harness/adversarial review;
- normalized capability discovery;
- harness-specific configuration boundaries.

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

**Exit condition:** The same PR workflow works through all three initial harnesses without leaking harness-specific logic throughout the application.

---

## Phase 3: Self-Hosted Worker

Add the second execution model.

Scope:

- worker installation;
- worker registration;
- worker authentication;
- capability/model advertisement;
- review job transport;
- local harness configuration;
- subscription-backed authentication where validated;
- repository sandboxing;
- credential isolation;
- health/status reporting;
- cancellation and failures.

Security is the main concern in this phase.

**Exit condition:** A GitHub review can execute entirely on user-controlled infrastructure without the control plane receiving AI provider credentials.

---

## Phase 4: Fix Mode + Advanced Agentic Workflows

Move beyond review-only behavior.

Add:

- temporary source modifications;
- proposed patches;
- targeted fix verification;
- broader post-fix validation;
- GitHub fix delivery mechanism;
- reviewer + verifier strategies;
- optional cross-harness verification;
- evidence-backed findings;
- richer review strategies.

Potential:

```text
Codex finds issue
→ Codex proposes fix
→ Claude verifies fix
```

or:

```text
Claude reviews
→ Codex challenges high-severity findings
```

Exact workflows remain configurable rather than hard-coded.

**Exit condition:** The system can find, validate, repair, and re-validate an issue through a controlled agent workflow.

---

## Phase 5: Hardening + Productization

Make the system safe and practical for sustained usage.

Scope:

- incremental review reconciliation;
- duplicate detection;
- stale-job cancellation;
- concurrency;
- retries;
- queue hardening;
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
- multi-agent consensus;
- automatic reviewer selection;
- cost-aware routing;
- deeper organization/team features.

---

# 41. Major Open Questions

## Blocking

1. **Self-hosted credential isolation**
   - How can the harness authenticate without exposing credentials to repository processes?

2. **Self-hosted sandbox**
   - Common sandbox or runtime-specific implementation?

3. ~~**Subscription automation**~~ - **Resolved.** Reprove states the mechanism and records
   each provider's published position rather than ruling on their terms; whether a given
   subscription permits an unattended Run is between the user and their provider. The
   unattended, webhook-triggered Claude Code subscription case stays marked unvalidated.
   See §22, *Provider authentication constraints*.

4. **OpenCode configuration**
   - Which provider/model settings should be delegated versus overridden?

5. **Model discovery**
   - How should each harness expose currently usable models to the control plane?

6. **GitHub lifecycle**
   - Chat SDK only or Chat SDK plus direct webhook layer?

## Review strategy

7. How is the authoring agent identified for adversarial review?
8. Should adversarial review be manually configured initially?
9. When should a second reviewer be invoked?
10. How should conflicting agent findings be reconciled?
11. Should different models within the same harness count as independent reviewers?
12. Should higher-risk findings automatically escalate to another harness?

## Agent behavior

13. What does Review Mode allow?
14. When should verification execute?
15. How aggressively can agents create temporary tests/scripts?
16. How much evidence is required for `VERIFIED`?
17. What network access is allowed?
18. What execution timeouts apply?

## Fixing

19. Does Fix Mode ship immediately after MVP?
20. Suggested patch, commit, branch, or follow-up PR?
21. Human approval before write-back?
22. What checks must pass before a fix can be called verified?

## Product

23. Automatic review default: **[Undecided]**
24. Severity model: **[Undecided]**
25. Confidence model: **[Undecided]**
26. Configuration format: **Resolved** - `.reprove.yml`, base ref only, `review:` / `security:` sections ([ADR 0011](adr/0011-repository-configuration-contract.md)).
27. Dashboard scope: **[Undecided]**
28. Hosted billing: **[Undecided]**

## Infrastructure

29. Framework: **[Undecided]**
30. Database: **[Undecided]**
31. Queue: **[Undecided]**
32. Worker protocol: **[Undecided]**
33. Worker OS support: **[Undecided]**
34. Observability: **[Undecided]**
35. Data retention: **[Undecided]**

## Open Source

36. License: **[Undecided]**
37. OSS-only versus hosted offering: **[Undecided]**
38. Third-party harness extension API: **[Future / Undecided]**

---

# 42. Core Design Principles

## 1. The harness is not just a model backend

Do not reduce Codex, Claude Code, or OpenCode to:

```text
prompt → response
```

Preserve their agent capabilities.

## 2. Harness and model are separate choices

```text
Harness
→ runtime behavior

Model
→ underlying intelligence
```

Expose both where the harness permits it.

## 3. Give the agent an environment

The reviewer should be able to interact with the repository and prove claims through execution.

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

## 5. Different agents can challenge each other

The implementation agent does not need to be the review agent.

```text
Claude writes
→ Codex reviews
```

is a feature, not an edge case.

## 6. Fixes should be verifiable

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
ReviewJob
   ↓
ReviewExecutor
  /          \
Self-hosted   Hosted
```

## 8. GitHub remains independent

GitHub ultimately receives a normalized result regardless of:

- harness;
- model;
- provider;
- worker;
- sandbox;
- review strategy.

## 9. OpenCode is the initial flexibility layer

Codex covers OpenAI.

Claude Code covers Anthropic.

OpenCode covers the broader provider/open-model ecosystem.

That is enough initial coverage without expanding scope into additional harnesses.

## 10. Do not compete on capabilities competitors already have

"Runs your code" is not sufficient positioning.

The product identity is:

> **An open-source orchestration layer that turns user-selected coding agents and models into autonomous PR reviewers, validators, and fixers, with self-hosted or hosted execution and support for cross-agent review workflows.**