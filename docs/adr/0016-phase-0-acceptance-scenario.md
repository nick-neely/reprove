# What proves the Phase 0 exit

[ADR 0013](0013-github-ingress-and-run-creation-idempotency.md) fixed how a delivery becomes a Run.
[ADR 0014](0014-workflow-orchestration-seam.md) fixed where Workflow lives, made Acceptance name its
rejections, and mandated a CI check that builds from clean and executes a workflow.
[ADR 0015](0015-execution-ownership-and-worker-liveness.md) gave execution ownership a name and
bounded the executing window. Each handed something to
[Fix the observable Phase 0 acceptance seam](https://github.com/nick-neely/reprove/issues/39).

This decides the scenario that proves the whole of it, and three things earlier ADRs got wrong.

The decisions below were reached against a prototype whose logic module was executed rather than
read. Two of the three corrections were found by running it, not by reasoning about it.

## "A single scenario" is a spine, not a walk

One linear walk cannot be the answer, because accepting a Result **terminalizes the Run it was
accepted into**, and every rejection needs a Run that has not yet terminalized. What is single is
the **spine**:

```text
signed delivery -> Run creation -> lifecycle scheduling -> claim
```

Nine further cases fork off it at defined points, through the same seam, against the same database,
in one harness. Ten walkthroughs total.

## The seam is HTTP at both ends of a clean build

```text
pnpm build (clean)
  -> boot the built apps/control-plane
  -> POST /api/github/webhook            real HMAC over the exact received bytes
  -> the real workflow runtime schedules the lifecycle
  -> POST /api/worker/runs/claim         authenticated
  -> POST /api/worker/runs/:id/result    authenticated
  -> read the run row back through withOwner() on the pooled runtime role
```

ADR 0014 required that this scenario submit through the **Worker-facing endpoint** rather than
calling Acceptance directly, and that requirement is met at both ends: the webhook and the two
Worker endpoints are all real HTTP against a real build. Calling exported handlers in-process was
rejected because it proves neither that the routes are mounted nor that the workflow bundle survived
the build, which is precisely the failure ADR 0014 built its check to catch.

**Only GitHub's own API is substituted, and only at the transport.** Signature verification is
Reprove's own code and runs for real, on real bytes, with a timing-safe comparison. The canonical
fetch is intercepted below Octokit, so the App-auth exchange, the request shape and the response
parsing all execute; what is canned is the response body. A live App against a fixture repository
was rejected: it needs credentials in CI and a public ingress URL, it is nondeterministic, and it
cannot inject the `403`, `429` and contention cases whose typed classification ADR 0013 fixed.

## The database is local, and Neon is a deployment concern

Postgres 17 behind PgBouncer in transaction mode, the stack
[#37](https://github.com/nick-neely/reprove/issues/37) already chose.

**The persistence invariants under test are standard Postgres, RLS and transaction-pooling
behaviour.** All three ADR 0008 failures #37 found exist on a pooled connection generally, not on
Neon specifically. Running them locally keeps the Phase 0 exit deterministic, offline and
secret-free, and lets a contributor run the whole thing with Docker and nothing else.

Neon remains the production target. **Neon deployment compatibility is a separate production check**,
not part of this canonical scenario. The one fact it would add - that a Neon runtime role really can
be provisioned without `BYPASSRLS` - is a property of the deployment, not of the control plane, and
coupling it here would put an API key in the gate that proves Reprove's own behaviour.

## `livenessFor` joins `Phase0RunProfile`

ADR 0015 fixed `executionExpiresAt = claimedAt + livenessFor` and never said where `livenessFor` is
configured. Left unplaced it lands inline in the claim path, which is exactly the hazard ADR 0013
created `Phase0RunProfile` to prevent: a Phase 0 fixture silently becoming product selection policy
that Phase 1 inherits unexamined.

```text
Phase0RunProfile
  harness, model, strategy, autonomy
  placement, allowHostedFallback
  a real bounded normalized fixed config, and its canonical digest
  claimableFor    5 minutes    (ADR 0014)
  livenessFor    10 minutes    (ADR 0015, placed here)
```

The scenario then runs the **real** lifecycle loop, the **real** durable sleep and the **real**
conditional UPDATE, with only the two durations moved. An injectable clock was rejected: Workflow's
own `sleep` runs on wall time, so a control plane advancing a fake clock would disagree with the
durable schedule it is supposed to be testing. Calling the terminal transition directly was rejected
because it proves the predicate while proving nothing about the loop that fires it.

## Acceptance's re-probe had its order backwards

Acceptance is one conditional UPDATE whose eligibility window and write are the same statement. When
it matches zero rows it re-probes **only to name** what happened. That naming order is load-bearing,
and the prototype found it wrong:

```text
was            unknown_run -> wrong_tenant -> token mismatch -> not_eligible
is             unknown_run -> not eligible -> token mismatch
```

Testing the token first reports `execution_mismatch` - a rotated token - for a Run whose actual
problem is that it **ended**. ADR 0015 requires the opposite: *"the Run is terminal, which is a
stronger and clearer fact than token rotation."* So the eligibility half of the predicate is
disambiguated first and token identity second.

This is a one-line reordering that no unit test would have caught: both orders return a rejection,
both look correct, and only the **name** differs. It is the argument for the scenario existing.

## `wrong_tenant` is removed, because RLS makes it unreachable

Acceptance's re-probe runs inside `withOwner()`. A Run belonging to another Owner is therefore not
merely ineligible - it is **invisible**. The probe returns nothing, and the only answer available
from inside the boundary is `unknown_run`.

**ADR 0014 is amended: `wrong_tenant` leaves the rejection set.**

```text
oversized  upgrade_required  malformed  unknown_run  execution_mismatch  not_eligible
```

A cross-tenant submission and a nonsense Run id are now indistinguishable, **deliberately**. That is
also the safer disclosure: the response stops confirming that a Run exists under an Owner the caller
cannot see.

Two alternatives were considered and rejected. Probing outside `withOwner()` would cross the tenancy
boundary in the hot path to produce a better error message, which is the wrong trade for a boundary
ADR 0008 enforces in Postgres precisely so it does not rest on discipline. Raising it at the
authentication layer instead would preserve the name, but only where a request carries an Owner the
credential can be checked against, so it would guarantee less than it appears to.

ADR 0014's reason for naming rejections stands - *"'rejected' alone cannot distinguish a superseded
Run from a forged tenant, and the distinction is what makes the boundary auditable"* - and the
consequence is accepted rather than hidden: **the forged-tenant case is no longer named anywhere in
Acceptance.** Where it needs an audit record, that record belongs to authentication, which knows
which credential presented which Run id. Nothing in Phase 0 produces one.

## The two cases ADR 0015 handed forward

Both end `failed(worker_lost)`; both reject a late **same-token** Result as `not_eligible`.

**The hosted `start()` orphan is the mandatory one.** The dispatch path claims the Run, `start()`
succeeds so a durable pass is genuinely running, and the process dies before `markExecuting` records
its id:

```text
status                claimed
executionToken        assigned
hostedWorkflowRunId   null          <- nothing knows the pass exists
claimableUntil        never fires   <- it writes only over `queued`
```

Without ADR 0015 this Run stays Result-eligible forever. Liveness closes it on the `executionToken`
alone, `lostFrom: claimed`, and there is nothing to cancel - which is fine, because a pass that
emerges afterward cannot change a Run whose Acceptance has already closed.

**This case costs something, and the cost is named rather than hidden.** The crash is inside
Reprove's own dispatch path, between `start()` and `markExecuting`, so no misbehaving Worker can
reach it: the scenario needs an injection point at the composition seam, which is a test-only branch
inside shipped orchestration. It is paid because ADR 0015 names this window as the hole that widened
[#41](https://github.com/nick-neely/reprove/issues/41) from `executing` to Acceptance's whole
eligibility window. A scenario that skipped it would not exercise what #39 inherited.

**Self-hosted silence is kept alongside it, at no cost.** A self-hosted Worker claims over the
authenticated endpoint and goes quiet; nothing in Phase 0 moves it to `executing`, because there is
no progress message. Same terminal state, different cause, no injection. The **pair** is what shows
the eligibility window is placement-neutral rather than a hosted special case.

## Exactly-once is proven concurrently or not at all

Two identical valid Results are submitted **at the same time**, both reaching Acceptance before
either commits, both aiming the same conditional UPDATE at the same row. Postgres serializes them on
the row lock: one matches a row and commits, the other re-evaluates its `WHERE` against the committed
row and matches zero.

Two sequential submissions would prove only that a terminal Run rejects a Result, which is a much
weaker claim and is already covered by the supersession case. The invariant ADR 0006 states -
*"at most one accepted terminal Result for the current Run state"* - is a property of the statement,
and only a concurrent submission tests it as one. A Worker-supplied idempotency key remains a
convenience for network retry and is never what enforces it.

## One gate, and one thing it does not re-prove

The scenario is the **payload of ADR 0014's real-builder check**, not a second gate beside it. That
check already builds from clean, asserts the workflow bundle requires no external module, asserts
the output trace carries what the steps need, and starts the built application - which is exactly
the fixture this scenario needs. The Phase 0 exit is one fact and gets one signal.

**The ingress re-drive is cited, not re-proven.** ADR 0013 made automatic re-drive of `contended`
and `transient` dispositions a Phase 0 exit condition and ADR 0014 discharged it as Workflow's own
step retry, which #38's scenarios already exercise. Re-proving it here would widen this scenario
past the acceptance seam it exists to prove.

## What the scenario observes, and what it asserts absent

Observed:

- Webhook route status and body for a valid signature, a tampered one, and an oversized body.
- The intercepted GitHub request shape: App JWT, installation token, `GET /repos/…/pulls/{n}`.
- Claim endpoint status and body, for both placements.
- Result endpoint status and the **named** rejection, for every reachable rejection.
- Two concurrent Result submissions: exactly one `200`, one `409 not_eligible`.
- A Run left at `claimed` with a null pass id, terminalized by liveness alone.
- The `run` row read back under `withOwner()`: status, token, `acceptedAt`, structured failure detail.
- The ingress ledger row's terminal state and disposition.
- The build gate's own assertions: no external module in the workflow bundle, `pg` in the output
  trace, the application boots.

Asserted absent, because Phase 1 owns them:

- No checkout, no Workspace, no Sandbox, no Harness. The Result is `worker-core`'s fixture.
- No Review published, no Comment, no Reconciliation, no Threshold or Ignore.
- No Check run, and no Refusal path - ADR 0013 makes neither reachable in Phase 0.
- No Enrollment, and no Lease renewal transport.
- No progress messages and no cancellation delivery.
- No narrative supplied to any Reviewer, so ADR 0013's inherited constraint stays inherited.

## What this deliberately does not claim

- **A green gate is not a working reviewer.** It proves a delivery becomes a tenant-safe Run that is
  ready for a Worker, and that Acceptance holds its boundary. Every claim about review quality is
  Phase 1's.
- **Nothing here was run on Vercel.** The build gate runs a local build of the application.
- **The injection point is a known impurity.** A test-only branch in shipped orchestration is a real
  cost, accepted for one case, and it is the second thing ADR 0014's orchestration package carries
  that would be better behind a private surface - `reportHostedFailure` being the first.
- **`worker_lost` is still never observed against a real Worker.** All three of ADR 0015's detectors
  remain exercised against fixtures.

## Consequences

- **ADR 0014 is amended twice.** `wrong_tenant` leaves Acceptance's rejection set. Its real-builder
  CI check gains this scenario as its payload rather than acquiring a sibling.
- **ADR 0015 is amended twice.** `livenessFor` is placed in `Phase0RunProfile`, and the re-probe's
  disambiguation order is fixed so that terminal state is named before token identity.
- **ADR 0013 is unchanged.** `Phase0RunProfile` gains a field, which is what it exists for.
- **`CONTEXT.md` is unchanged.** No noun is added: the scenario is verification machinery, and
  `Acceptance`, `Result`, `Run`, `Lease` and `Failure` already carry every meaning it relies on.
- **The map's destination is now fully specified.** What remains before implementation is
  [#40](https://github.com/nick-neely/reprove/issues/40), which is an authoring-time concern rather
  than a behavioural one.
- The prototype is a primary source on `prototype/39-acceptance-seam`; its logic module is the state
  model the harness lifts.
