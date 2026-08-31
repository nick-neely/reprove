# Where Workflow lives, and what owns a Run's schedule

[ADR 0006](0006-worker-protocol.md) fixed the Worker protocol and made **Acceptance** the
stale-result boundary. [ADR 0010](0010-package-graph-and-open-core-boundary.md) fixed the
package graph and gave `@reprove/control-plane` "the hosted Workflow orchestration seam".
[ADR 0013](0013-github-ingress-and-run-creation-idempotency.md) fixed how a delivery becomes
a Run and handed three things forward: the mechanism that moves a durably received delivery
into out-of-band processing, the mandatory automatic re-drive for `contended` and
`transient` dispositions, and the Phase 0 claimable-deadline value.

[Shape Workflow dispatch and hosted Worker composition](https://github.com/nick-neely/reprove/issues/38)
decides those, and one larger thing ADR 0010 got wrong: **which package may hold a workflow
at all.**

The decisions below were reached against a prototype and then survived three rounds of
adversarial review, which retracted four claims and found five defects. Where a decision
here contradicts an earlier one, the contradiction is stated rather than quietly resolved.

The measured behaviour of the SDK that constrains all of this is separate, in
[the Workflow SDK build-constraints research](../research/workflow-sdk-build-constraints.md).
That document records facts about a dependency; this one records what Reprove decided in
response. Keeping them apart matters because the facts are undocumented and version-specific,
and will rot faster than the decisions.

## A workflow cannot live in `@reprove/control-plane`

**ADR 0010 is amended.** The hosted Workflow orchestration seam does not belong to
`@reprove/control-plane`, and `workflow` is no longer a permitted dependency of it. A new
package holds it:

```
@reprove/control-plane            substance: ingress, Run creation, claim,
                                  Acceptance, Reconciliation, publication, persistence.
                                  No `workflow` dependency. No environment variables.
@reprove/control-plane-workflow   every workflow and step definition, and all step
                                  configuration. Depends on control-plane + workflow.
                                  No harness code.
```

The constraint that forces a split is real: a `'use step'` function is compiled into a
bundle whose module graph is fixed at build time, so **the layer that defines steps is the
only layer that can reliably configure them.** Leaving the definitions in the core package
means that package must read the environment, which ADR 0010 forbids and which an earlier
revision of this work did while simultaneously claiming the rule survived.

**But the choice of a package is a tradeoff, not a forced move**, and it is recorded as one.
Two alternatives remain technically possible: keep the definitions in the core package behind
a documented, no-fallback environment contract; or duplicate them in each app. The package
wins because ADR 0010 requires Cloud to consume published artifacts rather than duplicate
control-plane substance, and because shared orchestration outweighs the cost of one more
published-by-necessity package. It is a real cost: ADR 0010 argues that "publishing seven
packages reads as seven API commitments", and this makes eight.

**The name is qualified deliberately.** `Adapter` is already a `CONTEXT.md` noun meaning
Reprove's per-Harness code, so an orchestration package must not be called one.
`CONTEXT.md`'s naming rule 4 says a dependency's name gets qualified at the seam: Vercel's
`Workflow` is the foreign word, and `control-plane-workflow` qualifies it.

**This does not reopen ADR 0006's rejection of a mandatory hosted HTTP endpoint.** That
rejection was challenged during this work and it survives: a hosted deployment composes both
halves and reaches Acceptance in-process. The authenticated HTTP submission a self-hosted
Worker uses is unchanged and remains ADR 0006's. Exercising it end to end belongs to
[#39](https://github.com/nick-neely/reprove/issues/39), whose scenario submits through the
Worker-facing endpoint rather than calling Acceptance directly.

## Ingress re-drive is the platform's retry

ADR 0013's first two handoffs are discharged together. A delivery is committed by the
request path and then handed to a durable run; the ingress step throws `RetryableError` on
`contended` and `transient`, and **Workflow's own step retry is the re-drive**. `unauthorized`
throws a fatal error and stops.

No Reprove-owned sweeper, backoff table or second job system appears beside the orchestrator
[#6](https://github.com/nick-neely/reprove/issues/6) already settled. That was the constraint
ADR 0006 stated as "ingress must not write a parallel queue that bypasses the Workflow", and
it is now satisfied by construction rather than by discipline.

## A Run has two durable runs, and they are not interchangeable

The **lifecycle** is the Run's schedule and outlives any Worker. The **pass** is one Worker's
attempt at it. They are recorded in separate columns and cancelled by opposite mechanisms:
the lifecycle is resumed through its cancel hook so it terminates reportably, the pass is
cancelled outright. Conflating them cancels the schedule and leaves the Worker running.

### Hook tokens are scoped to the lifecycle, never to the Run

A hook token is globally unique. A token derived from a Run id therefore collides whenever
two lifecycles exist for one Run, and collides in the worst direction: the orphan is created
first, holds the token, and **the lifecycle actually recorded on the Run is the one that
fails.**

So tokens carry the `workflowRunId`, and a notifier reads the currently recorded lifecycle
from the database before resuming it. That is the correct dependency direction anyway: the
database decides which lifecycle owns a Run, so a notification must consult it. An orphaned
lifecycle is never notified, because it was never recorded.

### The orphan is made inert, because it cannot be prevented

`start()` accepts neither an idempotency key nor a caller-supplied run id, so the window
between starting a lifecycle and recording its id cannot be closed; a crash inside it orphans
a durable run that no conditional update can find or cancel. Workflow run creation is not
idempotent, while ADR 0013 went to considerable trouble to make Reprove's Run creation so.

Therefore **every write a lifecycle performs is conditional on it being the lifecycle the Run
records.** An orphan wakes at its deadline, matches nothing, and ends. The Reprove row is the
arbiter: the first writer of the lifecycle id wins, and the loser cancels its own run.

## `claimableUntil` bounds the unclaimed window and nothing else

It bounds when a Run may be **claimed**. It writes exactly one transition, `unscheduled`,
over a Run that was never claimed, and only when the writing lifecycle is the recorded one.

An executing Run whose deadline expires is **left alone, deliberately**. ADR 0007 defines
`unscheduled` as "never dispatched" and `CONTEXT.md` reserves Failure for a Run that began
executing, so writing either over an executing Run states something false about it. ADR 0006
gives the liveness of an executing Run to the **Lease**, which Phase 0 does not implement
because [#32](https://github.com/nick-neely/reprove/issues/32) kept lease renewal out of
protocol v1.

**The consequence is stated rather than hidden: nothing currently ends an executing Run whose
Worker stops answering.** That is
[#41](https://github.com/nick-neely/reprove/issues/41)'s decision, not a gap this ADR papers
over with the wrong mechanism.

**The Phase 0 claimable deadline is five minutes**, carried in `Phase0RunProfile` and written
into immutable `spec` at creation. It is a **Phase 0 fixture value, not a product default**:
nothing in Phase 0 - no real Worker, poll cadence, Sandbox startup or user workload -
supports a larger number, and thirty minutes was a guess that Phase 1 might have inherited
unexamined. Five makes `unscheduled` observable during development and fails visibly if it is
too short. Phase 1 replaces it with a measured value. Expiry never extends or mutates the
Run; ADR 0007 already requires that a retry create a new Run.

## Acceptance decides; notification follows

Acceptance is unchanged in substance and remains control-plane-side, one conditional UPDATE
whose eligibility window and write are the same statement. Two things are fixed here:

- **The database write is what makes a Result accepted.** Resuming the durable run is a
  notification that follows it, performed by the orchestration package. Doing both inside the
  ingest request re-enters the workflow runtime from a request that runtime is waiting on.
- **Acceptance names its rejections** - `oversized`, `upgrade_required`, `malformed`,
  `unknown_run`, `wrong_tenant`, `stale_lease`, `not_eligible` - and checks protocol
  compatibility before parsing the payload. "Rejected" alone cannot distinguish a superseded
  Run from a forged tenant, and the distinction is what makes the boundary auditable.

**A hosted Worker's internal Failure is signalled, not submitted.** It is a conditional
control-plane transition using Acceptance's eligibility window; it absorbs no Result, so
Acceptance remains the only path by which a Result enters a Run, and it is not a protocol v1
message, so [#35](https://github.com/nick-neely/reprove/issues/35)'s verdict stands. It is
**unexposed in the compositions Reprove ships**, which is weaker than structurally
unreachable: it is an exported function, and making the property real requires a private
surface on the orchestration package. Recorded as a known limitation rather than a guarantee.

## A CI gate protects execution, not artifact shape

The build behaviour this seam depends on is undocumented and version-specific: one bad import
breaks every workflow in the app, at runtime, with an error naming an innocent one, while the
build stays green. A rule someone has to remember is not sufficient for a failure with that
shape.

So CI runs a **real-builder workflow check** that builds from clean, asserts the workflow
bundle requires no external module, asserts the output trace carries what the steps need, and
then **starts the built application and executes a workflow.** It fails if an expected
artifact or trace is absent rather than treating absence as informational.

It deliberately does not assert bundle size or any other property of the current artifact
shape. The SDK promises workflow-mode transformation and dead-code elimination; it does not
promise one shared bundle or its externalization behaviour, so canonising today's output
would make CI brittle against a dependency upgrade while protecting nothing extra. The
runtime execution is the check that survives such an upgrade.

## Consequences

- **ADR 0010 is amended** in every place that assumes seven packages or gives the
  orchestration seam to `@reprove/control-plane`: the graph, the dependency matrix, the
  ownership text, the published-by-necessity list, and the lockstep-versioning language.
  Its rule that the package reads no environment variables now holds literally.
- **ADR 0006's rejection of a mandatory hosted HTTP endpoint survives** an explicit challenge.
  Its `worker_lost` Failure is not reachable in Phase 0, because lease renewal is not in
  protocol v1.
- **ADR 0013's three handoffs are discharged**: the durable spine moves the delivery, the
  platform's step retry is the re-drive, and the deadline is five minutes.
- **ADR 0008 gains a scoping correction**, recorded there: the boot assertion covers every
  table Reprove's own migration manifest manages, and excludes Workflow-owned schemas.
- **[#39](https://github.com/nick-neely/reprove/issues/39) inherits** exercising the
  authenticated HTTP Acceptance seam a self-hosted Worker uses.
- **[#41](https://github.com/nick-neely/reprove/issues/41) inherits** what ends an executing
  Run whose Worker stops answering.
- **`CONTEXT.md` is unchanged.** No new noun is introduced: the lifecycle and the pass are
  durable-run identifiers rather than domain concepts, and `Lease`, `Refusal`, `Failure` and
  `unscheduled` already carry the meanings this ADR relies on. That is deliberate, not an
  omission - the naming pressure this work produced was on a *package*, and was resolved by
  qualifying the foreign word rather than by adding vocabulary.
