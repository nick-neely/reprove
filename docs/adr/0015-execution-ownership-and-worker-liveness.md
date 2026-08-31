# What ends an executing Run, and who owns execution identity

[ADR 0006](0006-worker-protocol.md) made **Acceptance** the stale-result boundary and gave the
liveness of an executing Run to the **Lease**. [ADR 0007](0007-run-result-and-finding.md) fixed the
Run's status set and put lease expiry in mutable `state`.
[ADR 0014](0014-workflow-orchestration-seam.md) scoped `claimableUntil` to the unclaimed window
alone and stated, rather than papered over, the consequence: **nothing ends an executing Run whose
Worker stops answering.**

[Decide who ends an executing Run whose Worker stops answering](https://github.com/nick-neely/reprove/issues/41)
decides that, and one thing ADR 0006 got wrong.

## The gap is in ADR 0006, not in Phase 0

ADR 0006 says two things that cannot both hold:

- *"When a Worker dies mid-Run the Run fails as `worker_lost`"*, detected by lease renewal.
- A hosted Worker *"does not enroll, register, advertise capabilities, hold a durable identity,
  poll, claim, hold a lease, or heartbeat."*

So executing-Run liveness was assigned to a mechanism the hosted Worker never holds. **This is not a
Phase 0 sequencing gap.** It would survive the full implementation of protocol v1 lease renewal,
because renewal is not something a hosted Worker was ever going to do.

It is in scope for Phase 0 because the Phase 0 exit requires Acceptance to reject stale Results, and
eligibility is a function of Run status. A Run that can never leave the active window has an
eligibility window that never closes, so a Result arriving three days late is **accepted**. That is
precisely the failure ADR 0006 built Acceptance to prevent: *"a Worker ... may return from a
partition holding a Run that was declared `worker_lost` twenty minutes earlier."*

## Execution ownership is not a Lease

The control plane needs one identity for *the execution currently authorized to submit against a
Run*. It has one already, but under a name that is false for half the Workers that hold it: the
prototype mints a `lease_token` for hosted Workers and rejects mismatches as `stale_lease`, for a
Worker kind ADR 0006 says holds no Lease.

**`executionToken` and `executionExpiresAt` are written at claim** and span `claimed` and
`executing`. Both placements have them. A **Lease** is what a *self-hosted* Worker holds on top:
the renewable hold that is permitted to advance `executionExpiresAt`. A hosted Worker cannot renew,
so its boundary is fixed at claim.

```
executionToken       identifies the execution authorized to submit. Both placements.
executionExpiresAt   the control-plane liveness boundary for that execution. Both placements.
Lease                a self-hosted Worker's renewable hold, allowed to advance the boundary.
```

That separates the capability from the mechanism without inventing a hosted heartbeat, and without
modelling an ignorance Reprove does not have: a Run dispatched to Reprove's own infrastructure is
not a Run it must ask a stranger about.

**`stale_lease` becomes `execution_mismatch`,** because the rejected condition is a submitted token
that is not the Run's current one, not an expired Lease.

**`Attempt` was considered and rejected as the noun.** `CONTEXT.md` already defines a **Run** as
"one bounded attempt to review a pull request", so a second attempt underneath it would collide on
sight with Run, Pass, and itself. The token and the deadline are control-plane machinery and get no
domain noun at all, exactly as the lifecycle and pass workflow ids get none.

## The watchdog's window is Acceptance's window

Acceptance is eligible over `status IN ('claimed','executing') AND acceptedAt IS NULL`. A detector
scoped more narrowly than that leaves the guarantee holed, and the hole is reachable rather than
theoretical: `markExecuting` records `hostedWorkflowRunId` **after** `start()` returns, so a crash
inside ADR 0014's unclosable orphan window leaves a Run at `claimed` with a live, unrecorded pass.
`claimableUntil` does not touch it, because it writes only over `queued`.

So the eligibility predicate is defined **once** and shared, never restated:

```
Result-eligible Run
  = status IN (claimed, executing)
  + acceptedAt IS NULL
  + executionToken matches
```

and two competing conditional updates race over it:

```
Acceptance             eligible + valid Result       -> completed / incomplete
liveness termination   eligible + liveness expired   -> failed(worker_lost)
```

Whichever wins closes the other path. The invariant this buys:

> **A Run may remain eligible for Acceptance only while Reprove still considers its assigned
> execution live.**

A Run abandoned at `claimed` still ends as `failed(worker_lost)`, not `unscheduled` and not a
Refusal. Once a claim succeeded, scheduling succeeded and execution responsibility exists, even if
the Reviewer never started. `lostFrom: claimed | executing` records which.

## One transition, three detectors

```
prompt    hosted, in-process   an uncaught throw in the pass          milliseconds
watchdog  hosted, lifecycle    no usable terminal signal by deadline  bounded
Lease     self-hosted, later   renewal stops                          bounded
```

All three call the same control-plane transition on the same predicate. The detectors differ
because the **evidence** differs; the terminal write does not fork.

A hosted pass cannot report its own death when the Function is killed, cancelled, or exhausts its
retries, so the watchdog is not optional. But an uncaught throw is a moment Reprove's own code is
running, and waiting out a ten-minute deadline for a crash it witnessed is a choice, not a
constraint. The prompt detector costs one `try`/`catch`.

**The database transition is the correctness boundary; `cancel()` is reclamation.** The watchdog
therefore terminalizes **first** and cancels the still-running pass **second**, best-effort, only if
its transition won. Cancelling first would make a resource operation load-bearing for correctness.
Where no pass id was ever recorded there is nothing to cancel, and that is fine: a pass that emerges
afterward cannot change the Run, because Acceptance has already closed.

## The Run's schedule owns the clock

`runLifecycle` already calls itself the Run's durable schedule that outlives any Worker, but it
scheduled only the claim window: one `Promise.race`, then it returned. It becomes a **state-driven
loop over two phases** - claim window, then execution liveness - re-reading authoritative Run state
on every wake rather than trusting the timestamp it slept toward:

```
wake
  -> read authoritative Run state
     terminal            -> return
     queued              -> claim-window branch
     claimed | executing -> liveness branch, using the CURRENT executionExpiresAt
                            expired?  attempt worker_lost
                            advanced? sleep again
```

The re-read is what makes self-hosted renewal work later without a new mechanism: renewal advances
a column, and a stale wake-up sleeps again.

**One durable run per Run.** A separate watchdog workflow was rejected: it would add a third
`start()` orphan window of exactly the kind that created the `claimed` hole above. A periodic
sweeper was rejected because ADR 0014 discharged ADR 0013's re-drive specifically so that no second
job system appears beside the one ADR 0006 settled. Every lifecycle-side mutation keeps ADR 0014's
ownership guard: an orphan lifecycle stays inert.

The cost is one additional pending `sleep` per lost race - an un-cancelled `graphile_worker` job
that fires later as an early-return no-op. Additive, not compounding, and measured in the
[Workflow SDK build-constraints research](../research/workflow-sdk-build-constraints.md).

## Failure vocabulary

One reason code, `worker_lost`, for both Worker kinds and all three detectors:

```
status:         failed
failureReason:  worker_lost
failureDetail:  detector    hosted_prompt | hosted_watchdog | lease_expired
                observation uncaught_throw | workflow_failed | workflow_cancelled
                            | workflow_terminal_without_result
                            | workflow_state_unavailable | deadline_elapsed
                lostFrom    claimed | executing
```

This fits ADR 0007's existing `failed` - *"execution began and produced no acceptable Result"* - so
no new status is introduced. Parallel reason codes (`hosted_pass_failed`, `workflow_lost`) were
rejected: ADR 0001's single Worker concept is load-bearing, and the operational question "my daemon
or your infrastructure?" is answered by `detector`, which is evidence, not domain vocabulary.

**`worker_lost` is the fallback for an execution that ended without a more specific acceptable
terminal report reaching the control plane.** An uncaught throw qualifies even though Reprove
witnessed it, because a crash is not an acceptable terminal report. A structured Failure from
worker-core does **not** qualify: `reportHostedFailure` remains preferred and keeps its own specific
reason, so `sandbox_teardown_incomplete` is never collapsed into `worker_lost`.

## Phase 0 fixtures

```
claimableFor  5 minutes   from Run creation
livenessFor  10 minutes   from claimedAt
```

`executionExpiresAt = claimedAt + livenessFor`. Not from Run creation, not from `claimableUntil`,
and not from whenever `markExecuting` happens to succeed.

Ten minutes is **as arbitrary as five**, and the rationale is deliberately modest: it differs from
the claim window so that deadline-confusion bugs are observable, and it preserves the real ordering
in which execution takes substantially longer than claiming, so Phase 1 does not inherit an inverted
intuition. It is not a claim that ten minutes is a realistic review timeout. Phase 1 replaces it
with a measured value.

The input is named `livenessFor`, not `executionTimeout`, because the deadline detects **loss of the
execution owner**, not a maximum legitimate review duration. A healthy self-hosted Run may renew past
it. It never means "reviews may run for at most ten minutes"; it means "without renewed or otherwise
valid liveness evidence, this execution becomes ineligible."

## What this deliberately does not claim

- **A cancelled pass is not a torn-down Sandbox.** `cancel()` is a single `run_cancelled` event
  write and runs no `finally` in the workflow body. Once Phase 1 has a real hosted Sandbox, an
  abandoned pass needs independently reliable teardown and reaping. Nothing here provides it, and
  nothing here should be read as providing it.
- **Self-hosted liveness is contract only.** Lease renewal transport is unimplemented. What this
  fixes is that the terminal transition, the eligibility predicate and the deadline field are
  already placement-neutral, so renewal becomes a column write rather than a second liveness system.
- **The Refusal return path is unexercised.** `acceptRefusal` returns a Run from `claimed` to
  `queued`, clearing `executionToken` and `executionExpiresAt`, since both belong to the execution
  ownership that just ended; a Run returned to `queued` after `claimableUntil` has passed goes
  straight to `unscheduled` rather than receiving a manufactured claim window. ADR 0013 settled that
  no Refusal is reachable in Phase 0, so the loop handles this by construction and Phase 0 does not
  test it.
- **Nothing here was measured on Vercel, against a real Pass, or against a real Worker.** The SDK
  behaviour it rests on was read from the pinned `workflow@4.8.5` source and is recorded in the
  build-constraints research.

## Consequences

- **ADR 0006 is amended.** Its assignment of executing-Run liveness to the Lease holds for
  self-hosted Workers only; hosted liveness belongs to the control plane. Its `worker_lost` Failure
  becomes reachable in Phase 0 by a path that is not lease renewal.
- **ADR 0007 is amended.** `state` carries `executionExpiresAt` rather than "lease expiry", and
  `failed` carries the structured detail above.
- **ADR 0014's handoff is discharged.** `claimableUntil` keeps its single transition and its
  five-minute fixture; the executing window is now owned rather than stated as a gap.
- **Acceptance's rejection set changes**: `stale_lease` becomes `execution_mismatch`. A Result
  arriving after a `worker_lost` transition has won is rejected as `not_eligible`, not
  `execution_mismatch` - the Run is terminal, which is a stronger and clearer fact than token
  rotation, and it is what proves terminal state rather than token rotation is the stale-result
  boundary.
- **`CONTEXT.md` gains no noun.** Its `Lease` entry sharpens to a self-hosted Worker's renewable
  hold, and says a hosted Worker holds none. `executionToken`, `executionExpiresAt` and the watchdog
  are control-plane machinery, like the lifecycle and pass workflow ids before them.
- **[#39](https://github.com/nick-neely/reprove/issues/39) inherits** two abandoned-execution cases:
  abandoned at `executing` with a recorded pass, and abandoned at `claimed` with a null pass id
  closed on `executionToken` alone. Both end `failed(worker_lost)`; a late Result is rejected
  `not_eligible`. The prompt detector is this ticket's evidence, not a constraint on #39.
