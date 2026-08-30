# Reprove

Reprove turns established coding-agent harnesses into autonomous reviewers of GitHub
pull requests, giving each reviewer a real repository environment so that a claim about
the code can be proved by execution rather than asserted.

This file is a glossary and nothing else. Specifications live in [docs/prd.md](docs/prd.md);
decisions live in [docs/adr/](docs/adr/).

## Naming rules

1. **No `Review` prefix.** The whole system is review, so `ReviewJob`, `ReviewAgent`,
   `ReviewExecutor`, `ReviewResult` and `ReviewFinding` all stutter. The nouns are bare.
2. **"Agent" is not a Reprove noun.** It survives as an adjective ("agentic review") and
   inside third-party API names. The things it used to mean are Harness, Reviewer and Author.
3. **"Reprove" is a product name, never a verb and never a state.** The verb is *review*.
   The re-prove wordplay belongs in positioning, not in the schema.
4. **A dependency's name gets qualified at the seam, not ours.** Where a library already
   occupies a word Reprove needs, Reprove keeps the bare name in its own domain and renames
   the foreign one where it enters: Vercel Workflow's `runId` becomes `workflowRunId` on
   arrival, and Better Auth keeps `account`, `organization` and `member` to itself.

## Language

### Reviewing

**Run**:
One bounded attempt to review a pull request at a fixed base and head SHA, with harness,
model, strategy and autonomy pinned at creation. A new push or a retry produces a new Run
rather than mutating an existing one.
_Avoid_: Job, ReviewJob, ReviewRun, task

**Review**:
The review submission a Run publishes to GitHub, carrying GitHub's own meaning. A Run
publishes at most one, and a Run that fails publishes none.
_Avoid_: report, verdict, result

**Result**:
The normalized payload a Run returns - a summary and its Findings - absorbed into the Run
once accepted. It is what crosses the Worker boundary, not something that outlives the crossing.
It is either `complete` or `partial`; a partial Result is still acceptable and still publishes
its Findings, so a Run that returns one is `incomplete` rather than a Failure. A partial Result
carrying no Findings publishes no Review at all, because an unfinished review must never read
as a clean bill of health.
_Avoid_: ReviewResult, output, report

**Pass**:
One harness invocation inside a Run. A Run is not assumed to be a single Pass; composing
several is what a Strategy does.
_Avoid_: step, stage, leg, turn

**Finding**:
A claim about the code at exactly one location that its Reviewer did not disprove. Verification
raises a Finding's standing; it does not admit it, so a claim reached by reasoning alone is still
a Finding. A hypothesis that verification disproved never becomes one.
_Avoid_: issue, problem, ReviewFinding, comment

**Severity**:
The consequence of a Finding if it merges, assigned by the Reviewer from a fixed ladder: `critical`
(data loss, a security breach or an outage), `high` (incorrect behavior on a normal path), `medium`
(incorrect behavior on an edge case, or a maintainability hazard with a concrete cost), `low` (style,
naming, nits). It describes the defect, never a Repository's policy about it, and there is no `info`.
_Avoid_: priority, impact, info

**Verification**:
How far a Reviewer got in proving a Finding: `verified` (it executed something whose output
demonstrates the claim), `inconclusive` (execution was attempted and failed to settle it), `static`
(reasoned only). This is the whole trust signal a Finding carries; Reprove has no confidence axis.
_Avoid_: verificationStatus, confidence, partially verified

**Comment**:
The line-anchored artifact GitHub renders. It is a projection of at most one Finding, and a
Finding may be suppressed by thresholds or by dedupe against an earlier Run - dedupe suppresses
a Comment, never a Finding. Line-anchoring is what the word means, so a Finding at a location
GitHub cannot anchor - one outside the diff - is not projected as a Comment at all; it renders
structurally in the Review body under the same thresholds.
_Avoid_: annotation, note

**Patch**:
An optional proposed change carried by a Finding. A GitHub suggestion block is one way to
render a Patch, not another name for it.
_Avoid_: suggestion, fix, diff

**Evidence**:
The structured record of what a Reviewer executed while verifying a Finding - the command, its exit
code and its output - captured whether the attempt settled the claim or not. A Finding cannot be
`verified` without it.
_Avoid_: proof, artifact, logs

**Verify**:
To demonstrate a claim by executing code, whether the claim is a Finding's or a Patch's.
This is the only word for the act; *validate* means schema validation and nothing else.
_Avoid_: validate, prove, confirm

### The reviewer

**Harness**:
A coding-agent runtime Reprove drives as a reviewer: Codex, Claude Code or OpenCode. A named,
installable program, not a model.
_Avoid_: agent, runtime, engine

**Model**:
The language model a Harness drives, chosen separately from the Harness.
_Avoid_: LLM

**Provider**:
The service that serves a Model to a Harness.
_Avoid_: vendor

**Reviewer**:
A resolved Harness, Model and set of instructions that performs one Pass. A Reviewer's
independence from the Author is the point of cross-harness review.
_Avoid_: ReviewAgent, agent, bot

**Adapter**:
Reprove's per-Harness code, driving a Harness by whichever Route applies and supplying what no
Route provides: the capability descriptor, the Reviewer's instructions, and validation of the
Result. It runs Worker-side, outside the Sandbox, and treats model identifiers as opaque strings -
the catalogue is the control plane's. A Route is an implementation detail of an Adapter, not
something its callers choose between.
_Avoid_: driver, plugin, integration

**Author**:
The agent or human that produced the pull request under review, as distinct from the Reviewer
examining it.
_Avoid_: authoring agent, implementation agent

### Execution

**Worker**:
The process that executes a Run and returns its Result. A hosted Worker is operated by Reprove
and provisioned per Run, holds no durable identity, and neither enrolls nor advertises anything;
a self-hosted Worker is operated by the user, is long-lived, and enrolls once before advertising
its capabilities and health. Both drive one Worker core, so neither is a different kind of thing.
_Avoid_: executor, ReviewExecutor, runner, backend, execution mode

**Enrollment**:
The one-time exchange by which a self-hosted Worker binds to an Owner and receives the durable
identity and credential it keeps across restarts. A Worker enrolls once and registers repeatedly;
a restarted Worker is the same Worker.
_Avoid_: registration, onboarding, pairing

**Lease**:
A Worker's live hold on a Run, taken when it claims one and renewed while it executes. Renewal is
the single mechanism that retains the claim, proves the Run's executor is alive, and carries a
cancellation back to the Worker, so a Run cannot be actively held twice and a silent Pass is not
mistaken for a dead one.
_Avoid_: lock, reservation, heartbeat

**Route**:
How an Adapter invokes a Harness, and which credential that invocation carries: `brokered` drives
it through `@ai-sdk/harness` with an API or Gateway credential the Sandbox never holds, `native`
drives the installed CLI with authentication the user manages. A Route is a property of the
invocation, not of who operates the Worker; both are open to a self-hosted Worker.
_Avoid_: mode, path, transport, invocation method

**Sandbox**:
The isolation boundary a Run executes inside, defined by properties rather than by a technology:
its own network, PID and mount namespaces, no host bind mounts and no runtime socket, seccomp and
resource limits, ephemeral storage, egress only through Reprove's proxy, and teardown after the
Run. Repository code must not cross it outward; whether a credential sits inside it is what
Exposure records. A Harness's own sandbox is never this boundary.
_Avoid_: container, VM, jail

**Isolation**:
How strongly a Sandbox is separated from its host and from the credential, as a ladder the Worker
computes and advertises rather than declares: `microvm`, `container-rootless`, `container`. Below
`container` there is no Sandbox and no Run.
_Avoid_: isolation level, hardening, security level

**Workspace**:
The repository checkout inside a Sandbox, pinned to a Run's base and head SHA, which a Reviewer
may mutate only under `fix` autonomy. It is self-contained and sandbox-owned: the Worker
materializes it with every remote and host reference stripped, so it carries no authority to reach
GitHub and nothing inside the Sandbox can fetch what the Worker did not put there.
_Avoid_: working tree, clone, repo

**Project commands**:
The install, build, test and typecheck commands a repository declares for its own toolchain,
which a Reviewer may run while verifying.
_Avoid_: checks, validation commands, scripts

**Usage**:
What a Run consumed from its Provider, normalized by Reprove from what the Harness reports. Cost
is derived from Usage only where a marginal price exists: a Run on the Native Route draws on
allowance the user already holds, so quoting an API-equivalent price for it would state a cost
nobody pays.
_Avoid_: cost, spend, tokens

**Refusal**:
A decision not to dispatch, made before execution begins, because a requirement was not met: a
missing hard Sandbox property, an ineligible combination of Exposure, Isolation and Provenance, or
a capability probe too stale to trust. It names the requirement that failed rather than degrading
quietly, and it is a protocol message rather than a log line.
_Avoid_: rejection, denial, error

**Failure**:
The outcome of a Run or Pass that began executing and could not produce an acceptable Result. It is
distinct from a Refusal, which happens before dispatch, and from a Review carrying no Findings,
which is a success.
_Avoid_: error, crash, abort

### Controls

**Autonomy**:
What a Reviewer is permitted to do, as a ladder: `inspect` may read, `verify` may execute,
`fix` may mutate the Workspace. A level is offered only where it can be enforced, so a Harness
that cannot be restricted does not advertise the levels it cannot honour.
_Avoid_: mode, review mode, permission level

**Strategy**:
How Reviewers are composed within a Run - one Reviewer, or several arranged to challenge
each other.
_Avoid_: mode, review strategy

**Provenance**:
Where the code under review came from, as a risk classification: `internal` when the head is a
branch of the same Repository and its Author is an owner, member or collaborator of it, and
`external` otherwise. It is computed from the pull request rather than configured, and it
classifies risk rather than conferring safety - `internal` means an attacker would have to be a
collaborator, not that there is no attacker.
_Avoid_: trust level, trusted, author association

**Exposure**:
What a fully compromised Sandbox would yield, as a ladder: `none` (no usable credential is inside
it), `scoped` (a model-only credential revocable without disturbing the user's own login),
`account` (a credential that can act as the user beyond this Run). It is computed from the
resolved credential rather than configured, and it is the mirror of Provenance: one classifies the
risk coming in, the other the blast radius going out.
_Avoid_: credential class, blast radius, risk level

**Threshold**:
A Repository's policy about which Findings reach GitHub, expressed over Severity and Verification.
It is applied when a Review is published rather than when a Finding is made, so changing it never
requires a new Run.
_Avoid_: filter, gate, minimum severity

### Tenancy

**Owner**:
The GitHub user or organization that owns repositories, and Reprove's tenant. Runs, Workers
and settings hang off an Owner, which survives an Installation being removed and re-added.
An Owner has no identity independent of GitHub, so it is identified by GitHub's durable
numeric id rather than by a login, which may change.
_Avoid_: Account, organization, team, tenant

**Installation**:
A live grant of the Reprove GitHub App on an Owner, carrying the source of short-lived
repository tokens. It may be removed and re-added, and it is not the tenant. Removing it
revokes the grant and destroys nothing, so a reinstall resumes the same Owner rather than
starting a new one.
_Avoid_: GitHubInstallation, app install, connection

**Repository**:
A repository owned by an Owner, in scope when an Installation grants it, carrying its own
settings directly.
_Avoid_: repo, project, RepositorySettings

**User**:
A human authenticated to Reprove, identified by their GitHub user. What a User may see derives
from their GitHub permissions; Reprove keeps no membership of its own.
_Avoid_: member, account, customer
