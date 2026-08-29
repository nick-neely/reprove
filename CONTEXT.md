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
Finding may be suppressed by thresholds or by dedupe against an earlier Run.
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
Reprove's per-Harness code, wrapping the third-party harness layer and supplying what that
layer does not: the model catalogue and the capability descriptor.
_Avoid_: driver, plugin, integration

**Author**:
The agent or human that produced the pull request under review, as distinct from the Reviewer
examining it.
_Avoid_: authoring agent, implementation agent

### Execution

**Worker**:
The process that executes a Run and returns its Result. A hosted Worker is operated by Reprove
and provisioned per Run; a self-hosted Worker is operated by the user, is long-lived, and
registers its capabilities and health.
_Avoid_: executor, ReviewExecutor, runner, backend, execution mode

**Sandbox**:
The isolation boundary a Run executes inside: the boundary untrusted repository code must not
cross outward, and a harness credential must not cross inward. Vercel Sandbox is one implementation.
_Avoid_: container, VM, jail

**Workspace**:
The repository checkout inside a Sandbox, pinned to a Run's base and head SHA, which a Reviewer
may mutate only under `fix` autonomy.
_Avoid_: working tree, clone, repo

**Project commands**:
The install, build, test and typecheck commands a repository declares for its own toolchain,
which a Reviewer may run while verifying.
_Avoid_: checks, validation commands, scripts

### Controls

**Autonomy**:
What a Reviewer is permitted to do, as a ladder: `inspect` may read, `verify` may execute,
`fix` may mutate the Workspace.
_Avoid_: mode, review mode, permission level

**Strategy**:
How Reviewers are composed within a Run - one Reviewer, or several arranged to challenge
each other.
_Avoid_: mode, review strategy

**Threshold**:
A Repository's policy about which Findings reach GitHub, expressed over Severity and Verification.
It is applied when a Review is published rather than when a Finding is made, so changing it never
requires a new Run.
_Avoid_: filter, gate, minimum severity

### Tenancy

**Owner**:
The GitHub user or organization that owns repositories, and Reprove's tenant. Runs, Workers
and settings hang off an Owner, which survives an Installation being removed and re-added.
_Avoid_: Account, organization, team, tenant

**Installation**:
A live grant of the Reprove GitHub App on an Owner, carrying the source of short-lived
repository tokens. It may be removed and re-added, and it is not the tenant.
_Avoid_: GitHubInstallation, app install, connection

**Repository**:
A repository owned by an Owner, in scope when an Installation grants it, carrying its own
settings directly.
_Avoid_: repo, project, RepositorySettings

**User**:
A human authenticated to Reprove, identified by their GitHub user. What a User may see derives
from their GitHub permissions; Reprove keeps no membership of its own.
_Avoid_: member, account, customer
