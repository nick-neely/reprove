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

- use existing coding-agent authentication where supported;
- allow existing Codex or Claude subscriptions where supported;
- allow OpenCode provider/model configuration;
- keep provider credentials on user-controlled infrastructure;
- avoid forcing users to purchase separate model usage from Reprove.

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

This can be configured at:

- account level;
- organization level;
- repository level;
- individual review run.

Exact precedence: **[Undecided]**

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

## 4.4 Bring your existing AI setup

Self-hosted users can potentially use:

```text
Codex
→ existing Codex / ChatGPT authentication

Claude Code
→ existing Claude authentication

OpenCode
→ existing provider configuration
```

OpenCode additionally supports a broad provider catalog, custom providers, and local models.

Exact unattended subscription usage remains:

**[Needs Validation per provider]**

---

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

**[Undecided]**

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

Provider credentials remain on the worker.

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
$ review-agent status

Codex       ✓ authenticated
Claude Code ✓ authenticated
OpenCode    ✓ configured

Worker      ✓ connected
```

---

# 23. Subscription-Backed Self Hosting

Desired:

```text
Codex
→ existing Codex/ChatGPT account

Claude Code
→ existing Claude account

OpenCode
→ existing provider configuration
```

Whether consumer subscription authentication can be used safely and permissibly for unattended workers:

**[Needs Validation per provider]**

Do not assume consumer subscriptions are interchangeable with API credentials.

---

# 24. Self-Hosted Security Boundary

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

This remains one of the primary technical blockers for production-safe self-hosted subscription execution.

---

# 25. Execution Mode B: Hosted Sandbox

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

# 26. OpenCode Configuration

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

# 27. Review Workflow

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

# 28. Normalized Review Result

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

# 29. Verification Status

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

# 30. Fix Workflow

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

# 31. Repository Configuration

Potential configuration:

```yaml
review:
  enabled: true

  execution: self-hosted
  harness: codex
  model: [optional]
  strategy: standard
  mode: verify

  ignore:
    - generated/**
    - vendor/**
```

Potential additional settings:

- review instructions;
- validation commands;
- timeout;
- allowed tools;
- network permissions;
- model/provider override;
- adversarial reviewer.

Exact schema:

**[Undecided]**

---

# 32. Repository-Specific Validation

Repositories may already know the correct verification commands.

Potential:

```yaml
validation:
  install: pnpm install
  build: pnpm build
  test: pnpm test
  typecheck: pnpm typecheck
```

Likely direction:

```text
configured commands take priority
+
agent may discover additional targeted checks
```

Final behavior:

**[Undecided]**

---

# 33. Incremental Reviews

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

# 34. Worker Protocol

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

# 35. GitHub Repository Access

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

# 36. Security Requirements

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

# 37. Persistence

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

# 38. Observability

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

# 39. Competitive Positioning

## Do not position solely around code execution

Modern competitors are increasingly adding execution, verification, and autofix capabilities.

The product should not rely on:

> "We run tests and they don't."

as its primary differentiation.

## Position around openness, control, and composable general-purpose agents

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
  execution
  harness
  model
  strategy
  autonomy
   ↓
Codex / Claude Code / OpenCode
```

Key differentiators:

- open source;
- harness choice;
- model choice where supported;
- self-hosted or hosted execution;
- existing subscriptions/configuration where supported;
- broad provider/model flexibility through OpenCode;
- agentic repository execution;
- targeted verification;
- optional remediation;
- cross-harness/adversarial review;
- ability to compose multiple agents later;
- normalized GitHub workflow independent of the runtime.

CodeRabbit explicitly takes a managed-model approach and argues that its users should not need to choose the underlying LLM. Reprove intentionally makes that choice available.

### Core message

> Use the coding agents and models you already trust as autonomous PR reviewers, validators, and optional fixers.

---

# 40. MVP

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

# 41. Development Roadmap

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

# 42. Major Open Questions

## Blocking

1. **Self-hosted credential isolation**
   - How can the harness authenticate without exposing credentials to repository processes?

2. **Self-hosted sandbox**
   - Common sandbox or runtime-specific implementation?

3. **Subscription automation**
   - Which Codex and Claude authentication workflows are appropriate for unattended workers?

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
26. Configuration format: **[Undecided]**
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

# 43. Core Design Principles

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