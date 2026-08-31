# The worker protocol and its trust direction

> **Clarified by [ADR 0010](0010-package-graph-and-open-core-boundary.md):** "what the two lifecycles
> share is the **Result and progress contract and the acceptance code path**" was ambiguous, because
> "acceptance" named two different operations at two different trust boundaries. What the lifecycles
> share is the Worker core's Result construction and **Evidence cross-check**, plus the Result and
> progress contracts. **Acceptance** - the stale-result boundary below - is control-plane-side only
> and is not something a Worker participates in; both words are now defined in `CONTEXT.md`. This
> clarifies rather than changes the decision: the boundary was always control-plane-side, which is
> what makes it hold against a hostile Worker. ADR 0010 also fixes how the compatibility window is
> expressed (version-family subpaths in `@reprove/protocol`) and splits the two execution lifecycles
> into sibling packages, `@reprove/worker` and `@reprove/worker-hosted`.

[ADR 0001](0001-one-worker-concept.md) collapsed `ReviewExecutor` and the worker protocol into a
single **Worker** concept and left one question open: which parts of the protocol the hosted path
exercises. [ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) then fixed where the
Sandbox boundary sits and handed four consequences here, and
[ADR 0005](0005-adapter-boundary.md) fixed what an Adapter exposes and deliberately declined to
settle what the Worker forwards upward. This ADR decides the contract between Reprove's control
plane and a Worker: how a Worker comes into existence, how work reaches it, what crosses in each
direction, and what happens when it stops answering.

It is the most expensive decision in this map to change, because a self-hosted Worker is software
running on someone else's machine that will lag the control plane by months.

The premise, stated once: **a self-hosted Worker is not trusted infrastructure.** It is operated by
the user, and the protocol is designed so that a Worker which is buggy, partitioned, or hostile
cannot corrupt a Run's outcome. Trust flows outward from the control plane, never inward from a
Worker's claims about itself.

## Shape: one Worker core, two drivers

ADR 0001 states that the hosted path "runs the same Worker implementation as the self-hosted path,
inside a Sandbox that Reprove provisions." That is no longer true and this ADR **amends it**. ADR
0004 requires the Worker to run outside the Sandbox, and ADR 0005 requires the Adapter and Result
validation to run outside it too; a Worker *inside* the Sandbox would put the Adapter, the
reconciliation step and the GitHub token in the same box as repository code.

The correct shape is one **Worker core** - Adapter, Sandbox provisioning, Workspace materialization,
Result validation and Evidence reconciliation - with two execution lifecycles driving it:

- **self-hosted**: a long-lived daemon on the user's host;
- **hosted**: Vercel Workflow steps, using the Adapter's internal `detach` / `resume` across step
  boundaries ([ADR 0005](0005-adapter-boundary.md)) so that no process must stay alive for the
  duration of a Pass. This is what makes hosted execution possible on Vercel at all: Pro Functions
  cap at 800s GA (1800s in a gated beta since 2026-07-24), and a Pass may exceed both.

In both lifecycles the Adapter runs outside the Run Sandbox, the Workspace is materialized outside
it, the Sandbox contains only the Harness and the Workspace, and Result and Evidence reconciliation
happen outside it.

**A hosted Worker is not a persisted Worker.** It does not enroll, register, advertise capabilities,
hold a durable identity, poll, claim, hold a lease, or heartbeat. It exercises none of the
scheduling half of this protocol. `CONTEXT.md`'s `Worker` entry is amended accordingly.

What the two lifecycles share is the **Result and progress contract and the acceptance code path** -
one schema, one validation, one dedupe, one place where "whatever leaves the Sandbox is
attacker-controlled" is enforced. Requiring the hosted path to reach that path over a public HTTP
endpoint was considered and rejected: it would add a network failure mode purely for symmetry.
Dogfooding the public endpoint from hosted is a legitimate implementation choice and must not be a
foundation requirement.

## Transport and trust direction

**The Worker is always the HTTP client. The control plane is always the HTTP server.** Every
message - claim, progress, lease renewal, refusal, repository-access request, Result - is an
outbound HTTPS request from the Worker. The control plane never opens a connection toward a Worker
and never learns a Worker's address.

Push was rejected outright: a Worker on a developer's laptop is behind NAT, and the PRD's own
environment list starts with "developer workstation." WebSocket and SSE were rejected because a
persistent connection terminated by a Vercel Function burns an invocation for the connection's
whole lifetime and still dies at the Function ceiling, so "persistent" would mean adding stateful
connection infrastructure that nothing else in the architecture needs.

What outbound-only buys is not latency - a few seconds is irrelevant against a twenty-minute
review - but the absence of an entire class of surface: **no inbound port on the Worker, no NAT
traversal, no certificate on a laptop, one Worker-authentication story, and one retry story.**

Self-hosted Workers learn about work by polling an authenticated claim endpoint backed by a durable
assignment store. **This ADR does not name that store.** [#6](https://github.com/nick-neely/reprove/issues/6)
already settled Vercel Workflow as the durable Run orchestrator, and the protocol must not
accidentally introduce a second job system beside it. The required flow is:

```
GitHub webhook -> durably start Run / Workflow -> Workflow makes the assignment claimable
```

Ingress must not write a parallel queue that bypasses the Workflow. Polling cadence is adaptive and
is implementation policy, not protocol.

**Vercel Workflow's `createWebhook()` URL is not the public protocol.** It is wired at
`/.well-known/workflow/v1/webhook/:token` with the token as its sole authorization: it authenticates
a URL rather than a Worker, cannot be revoked independently of the Run, and would pin Reprove's
public contract to Vercel Workflow's internals. Reprove owns stable authenticated endpoints, and the
ingest handler resumes the underlying Workflow internally. This also removes a dependency on the one
thing [#6](https://github.com/nick-neely/reprove/issues/6)'s research left **unverified** - whether
racing a webhook against a `sleep` watchdog stays deterministic under Workflow replay - by keeping
that race out of the protocol entirely.

## Enrollment, identity and credentials

A Worker is headless, long-lived, and must survive restarts as the same Worker; otherwise every
restart orphans a Worker record and "is this Worker online" stops meaning anything.

```
dashboard -> short-lived single-use enrollment code, scoped to an Owner
          -> Worker exchanges it once
          -> durable workerId + Worker credential
          -> persisted locally
```

The OAuth device flow was considered and rejected: it buys browser UX that a daemon on a VPS does
not want.

- The credential is a bearer token over HTTPS, scoped to Worker-protocol operations for **one
  Owner**, consistent with `CONTEXT.md`'s rule that Workers hang off an Owner.
- **The control plane stores only a hash of the Worker secret.**
- Rotation is Worker-initiated, with a short overlap during which the predecessor remains valid, so
  rotation cannot brick a Worker mid-Run.
- Revocation is immediate control-plane side. A revoked Worker receives a structured response and
  **stops** rather than retry-looping.

**Worker labels are deliberately deferred.** A generic routing primitive with no settled scheduling
use case would create configuration semantics this protocol does not need, and the additive-field
rules below make an optional field cheap to add when Repository/Worker affinity becomes a real
product requirement.

## Scheduling: offer, claim, lease

Dispatch gates on `Exposure` x `Isolation` x `Provenance` (ADR 0004). ADR 0004 also establishes that
`Exposure` is resolved at dispatch rather than registration and that a stale probe is a refusal
rather than an assumption - which puts the authoritative view on the Worker, while accountability
for the decision stays with the control plane.

Scheduling is therefore **two-phase**:

1. **The control plane selects candidates coarsely** from registration data - Harness installed,
   advertised `Isolation` ceiling, Repository eligibility. This data is **stale by design**, and
   that is acceptable precisely because it is not the gate.
2. **The claiming Worker performs a fresh resolved probe** - credential resolution, `Exposure`,
   current `Isolation`, resolved Adapter capability at the pinned Model - and either commits or
   returns a structured Refusal.

**A claim takes a lease**, so a Run cannot be actively held by two Workers.

A Worker may publish a capability update when it detects change. Making that push load-bearing - a
capability hash the control plane must trust - was rejected: the dispatch-time probe is
authoritative, so perfect filesystem and version-change detection is an optimization, not a
requirement.

## Refusal

A Worker knows only **"I cannot serve this Run, for reason X."** It cannot know that no Worker can:
that determination requires the candidate pool, Repository policy, fallback configuration and prior
Refusals, all of which are control-plane state.

So a Refusal carries a **reason code and the relevant resolved facts**, never a global verdict:

```
reason:   isolation_insufficient
required: container-rootless
actual:   container
```

and the control plane decides what it means - re-offer to another candidate, or terminate the Run's
scheduling. This preserves ADR 0004's rule that a Refusal is a first-class protocol message naming
the requirement that failed, and it keeps Refusal consistent with `CONTEXT.md`'s definition as a
pre-dispatch decision.

## Waiting, and the absence of a capable Worker

The PRD states no position on this at all. The decision is **bounded visible waiting, then a
terminal scheduling failure**:

- The Run posts a Check immediately, naming **what it is waiting for**.
- The Run stays claimable until a scheduling deadline (`claimableUntil`).
- On expiry the Run reaches a terminal scheduling failure carrying the accumulated Refusal reasons.

The default wait duration is product and configuration policy, not protocol; what this ADR fixes is
the existence of a scheduling deadline and a terminal expiry.

Accumulated reason codes let the Check distinguish two situations that would otherwise both read as
"pending": **no matching Worker is currently online** (transient, likely to resolve itself) versus
**matching Workers exist and each resolved ineligible** (will not resolve without operator action).

**Hosted fallback is never implicit.** Falling back changes execution location, credential model,
`Isolation` and `Exposure` simultaneously - it is a change of security posture, not a scheduling
convenience, and ADR 0004 already bans anything that warns and runs. It exists only as explicit
Repository policy read from the **base ref**, so a pull request cannot grant itself one, and when it
fires the Check says so. **A fallback still honours the Run's pinned Harness and Model**; ADR 0005
forbids silent Model substitution and scheduling is not an exception to it.

## Liveness: three signals, not two clocks

- **Any authenticated Worker contact refreshes Worker liveness.** Idle polling is the heartbeat when
  a Worker is idle; while executing, lease renewal and progress traffic serve the same purpose. There
  is no separate heartbeat message, and a busy Worker never looks offline for lack of polling.
- **Lease renewal proves the Run's executor is alive.** It is distinct from progress because a
  legitimate build or test suite may run silently for many minutes; **silence is not death**, and
  equating "no semantic progress event" with a wedged Run would fail exactly the Runs that are doing
  the most work.
- **A progress event means something meaningful changed.** Its content is fixed by ADR 0005:
  sanitized lifecycle boundaries, tool activity, usage, terminal state. No reasoning deltas, no model
  prose, no raw output.

Progress events are **monotonically sequenced and idempotent on `(runId, seq)`**, delivered in
batches. Sequence numbers make retries harmless and gaps detectable, which matters because the
client is a laptop.

**Amended by [ADR 0015](0015-execution-ownership-and-worker-liveness.md): the three signals above
are the *self-hosted* liveness story.** This ADR gives the liveness of an executing Run to the Lease
while also stating that a hosted Worker holds no Lease, which left hosted execution with no owner at
all - a gap that would have survived the full implementation of lease renewal. Hosted liveness
belongs to the control plane, which bounds it directly with `executionExpiresAt`. Both placements
carry `executionToken` and `executionExpiresAt`; only a self-hosted Worker holds a Lease, and a
Lease is precisely the renewable hold permitted to advance that boundary.

When a Worker dies mid-Run the Run fails as `worker_lost`. That is a **Failure**, not a Refusal -
`CONTEXT.md` reserves Refusal for pre-dispatch. The Run is **not** silently re-dispatched to another
Worker: a Run is a bounded attempt at fixed SHAs with `worker`, `Isolation` and `Exposure` recorded
on it, and moving it between Workers would make those fields a lie about what actually happened. A
retry creates a **new Run**. Bounded automatic retry can arrive later as Repository policy without
changing this protocol.

## Cancellation and supersession

With no inbound channel the control plane cannot interrupt anything, so cancellation rides responses
the Worker is already soliciting:

```
Worker -> renew Run lease
response -> continue | cancel(reason)
        -> AbortSignal -> stop Pass -> tear down Sandbox -> report terminal state
```

The Worker observes cancellation on **any relevant control-plane response**; lease renewal is the
*guaranteed* mechanism, but a progress POST that returns `cancel` must be honoured immediately
rather than waiting for the next renewal. Abort uses the `AbortSignal` the Adapter already carries
for Pass budget enforcement (ADR 0005). Cancellation latency is bounded by the lease interval, which
is a direct argument for keeping that interval short - and because one mechanism carries claim
retention, Run liveness and cancellation delivery, there is no separate control channel to design,
authenticate or debug.

**Supersession is control-plane-owned**, because only the control plane sees the sequence of pushes:
a new head SHA creates a new Run, marks the prior Run superseded, and the cancellation is returned on
the superseded Run's next lease renewal.

**Cancellation cooperation is not the stale-result boundary. Result acceptance is.** A Worker runs on
someone else's machine and may ignore a cancel, lose its network, or return from a partition holding
a Run that was declared `worker_lost` twenty minutes earlier. Therefore:

> Once a Run is terminal or superseded, the control plane rejects any later Result or progress that
> would change its outcome.

This is what satisfies PRD §32's "avoid stale results", and it holds against a Worker that is buggy
or hostile rather than merely slow. The business invariant is **at most one accepted terminal Result
for the current Run state**, enforced control-plane side; a Worker-supplied idempotency key on Result
submission is a convenience for network retry and **must not** be what enforces it.

Run-creation idempotency against GitHub webhook replay remains
[#5](https://github.com/nick-neely/reprove/issues/5)'s concern, which already established that the
key must not be `X-GitHub-Delivery` alone, since a manual redelivery reuses the GUID.

## What crosses, and what never does

The invariant is scoped to the **self-hosted Worker protocol**. It is not a claim about what may
exist anywhere in Reprove's infrastructure: a hosted Worker already runs on Reprove infrastructure,
and what is retained there is a retention and observability decision owned by
[#14](https://github.com/nick-neely/reprove/issues/14).

Never transported by the self-hosted Worker protocol:

- Harness or Provider credentials, in any form;
- credential caches and authentication files (`~/.codex/auth.json` and equivalents);
- Worker or Sandbox transcripts;
- unbounded Evidence - raw stdout and stderr;
- bulk Workspace content: no archive, no file tree, no full diff beyond what a Comment renders.

Evidence crosses as bounded structured metadata - command, exit code, duration, the bounded excerpt
the Reviewer cited, and truncation metadata where it applies. That is enough to publish and explain
why a Finding is `verified` without making Reprove Cloud the recipient of arbitrary program output,
which can contain a staging connection string, a customer record or an environment dump. This settles
the Evidence egress question ADR 0005 explicitly declined to settle by default.

One public-wording correction, recorded because getting it wrong would put a false promise in
`SECURITY.md`: **Reprove must not claim that the control plane cannot read repository source.** The
Reprove GitHub App holds `contents: read`, and a published Comment necessarily quotes code. The
meaningful, falsifiable promise is about **credentials and bulk Worker-originated data**, not about a
theoretical inability to access source.

## Repository access

PRD §34's preferred flow stands, with one change to *when* the token is issued:

```
Worker claims Run
  -> Worker requests repository access (dedicated authenticated endpoint)
  -> control plane mints an installation token: single Repository, contents:read, short-lived
  -> Worker materializes the Workspace host-side
  -> strip remotes, credential helpers, hooks and host references (ADR 0004)
  -> destroy the token
  -> Sandbox starts
```

**The token is minted just in time and never persisted inside a queued assignment payload**, where it
would end up in logs, storage and retries.

Requiring every self-hosted Worker to configure its own GitHub credential was rejected as security
theatre: the App installation already grants the control plane `contents: read` on that repository,
so a Worker-owned credential removes no control-plane capability while adding significant setup
burden to the path that already carries the hardest security requirements. It remains available as a
future optional topology for operators who want Reprove to hold no minting right, but it is not the
default and not the shape of the protocol.

The one-hour installation-token ceiling does **not** constrain long Runs. GitHub authority is needed
only to materialize the Workspace, which completes before the Sandbox starts; a Run that still holds
a GitHub token once execution begins is a bug, not a refresh case. Only if materialization itself
exceeded the token lifetime would the Worker request another.

## Result

**There is no artifact upload in the self-hosted Worker protocol, and `Artifact` is not a
worker-protocol concept.** Once transcripts, raw Evidence and bulk Workspace content do not cross,
nothing large remains, and an entire subsystem the ticket assumed - signed Blob URLs, chunked
transfer, credential distribution for uploads - is deleted rather than designed.

A Result is submitted as **one atomic, strictly size-bounded payload**: summary, Findings, bounded
Evidence metadata and excerpts, usage, and execution metadata. The exact byte limit is an
implementation choice and may be versioned; what this ADR fixes is the invariant:

> Result payloads are strictly size-bounded, Evidence excerpts are individually bounded and
> truncated, and an oversized submission is **rejected** rather than upgraded into a streaming or
> artifact protocol.

The bound is what makes "no bulk data crosses" enforceable at the edge instead of resting on good
behaviour: a Worker cannot drift into shipping test output.

The protocol must be able to transport a **non-complete Result** for the case where the Worker is
alive and knows it has hit its budget or been cancelled. Its exact shape is
[#13](https://github.com/nick-neely/reprove/issues/13)'s decision, not this one. A Worker that dies
suddenly sends nothing, and that is `worker_lost`.

`Artifact` may still exist as a Reprove persistence concept for hosted execution;
[#14](https://github.com/nick-neely/reprove/issues/14) owns its storage and retention.

**Usage crosses; cost is Route-aware.** The Worker reports normalized usage. The control plane may
derive cost where that concept is meaningful, but must not label API-price-table arithmetic as actual
cost for a subscription-backed Native Route Run: token usage is real, and API-equivalent price is not
that user's marginal cost. Presenting one as the other would also breach
[#9](https://github.com/nick-neely/reprove/issues/9)'s guardrails on how the Native Route's usage
model is described.

## Versioning

Two versions, advertised separately and both recorded on the Run for the same auditability reason
`Isolation` and `Exposure` are:

- `protocolVersion` - a **single integer**, not semver. Semver invites arguing about whether a change
  is minor; an integer does not.
- `workerBuildVersion` - the Worker's own build.

Rules:

- unknown additive fields are ignored; missing optional fields are tolerated;
- the integer bumps **only** for genuinely incompatible changes;
- the control plane advertises `current` and `minimum`;
- a Worker below `minimum` receives a structured `upgrade_required` naming the minimum, does not
  claim Runs, and surfaces it in `reprove status` - it never silently degrades;
- a compatibility window serves both versions during a migration.

**There is no control-plane-initiated auto-update mechanism.** Reprove may advertise that a newer
Worker version exists; installing it is the operator's action. A channel by which Reprove can push
code onto a machine holding Codex and Claude credentials would materially expand Reprove's
supply-chain authority over the exact hosts this architecture exists to protect, for very little
benefit. It is trivial to add casually and very hard to remove once deployed Workers accept it.

## Consequences

- **ADR 0001 is amended**: the hosted path does not run the Worker inside a Sandbox. One Worker core,
  two execution lifecycles; hosted exercises the Result and progress contract and none of the
  scheduling half.
- **`CONTEXT.md` gains `Lease` and `Enrollment`**, amends `Worker` to state that a hosted Worker
  holds no durable identity, and gains `Usage` to keep usage and cost from collapsing into one word.
- **ADR 0005's declined question is settled**: bulk Evidence does not leave a self-hosted Worker.
- **PRD §33 (`[Undecided]`) and §34 (`[Needs Validation]`) are resolved**, along with open question
  32. PRD §36's `ReviewArtifact` no longer implies a worker-protocol upload path. Edits land on
  [#17](https://github.com/nick-neely/reprove/issues/17).
- **[#13](https://github.com/nick-neely/reprove/issues/13) inherits** the requirement that `Result`
  have a transportable non-complete form, and that Findings carry bounded Evidence metadata rather
  than raw output.
- **[#14](https://github.com/nick-neely/reprove/issues/14) inherits** `Artifact` storage and
  retention for hosted execution, and the Worker record implied by enrollment: `workerId`, hashed
  credential, Owner, registration data, liveness.
- **Repository configuration gains two keys**: the hosted-fallback opt-in and the scheduling
  deadline.
- **`SECURITY.md` needs one correction and one addition**: it must not imply the control plane cannot
  read repository source, and it should state that stale-result rejection is enforced by acceptance
  state rather than by Worker cooperation.
- A self-hosted Worker needs **no inbound network exposure of any kind**, which is now a documented
  property of the product rather than an implementation detail.
