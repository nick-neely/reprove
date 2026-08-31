# Prototype: the observable Phase 0 acceptance seam

Throwaway prototype for
[#39 Fix the observable Phase 0 acceptance seam](https://github.com/nick-neely/reprove/issues/39).

## Run it

Open `phase-0-acceptance-scenario.html` in a browser. Nothing to install, no server, no database.

## The question

What single end-to-end acceptance scenario proves the Phase 0 exit through the highest practical
seam, and which rejections turn out to be unreachable once the real tenancy boundary is on?

## What it is

One self-contained HTML file. The `AcceptanceScenarioMachine` `<script>` block is a pure, DOM-free
module holding the control plane's state model at the HTTP seam: ingress, Run creation,
supersession, claim for both placements, the ADR 0015 eligibility predicate, Acceptance's ordered
rejection checks, and the lifecycle's state-driven loop over the claim and liveness windows. The
page around it is throwaway; the module is what lifts into the real scenario harness.

Ten guided walkthroughs cover the spine plus the nine terminations that are hard to reason about on
paper. Free play exposes every action in any order.

Two of them carry the weight. **The hosted `start()` orphan** is the hole #39 inherits: the dispatch
path claims, `start()` succeeds so a durable pass is running, and the process dies before
`markExecuting` records its id, leaving `status=claimed`, `executionToken` assigned and
`hostedWorkflowRunId` null. Reaching it needs an injection point at the composition seam, which is a
real cost, paid because nothing else exercises that window. **Accepted exactly once** submits two
identical Results concurrently rather than sequentially, so it challenges the atomic conditional
UPDATE instead of merely showing that a terminal Run rejects a Result.

## What it found

1. **`wrong_tenant` is unreachable from Acceptance behind RLS.** The re-probe runs under
   `withOwner()`, so another Owner's Run is invisible rather than merely ineligible, and the only
   available answer is `unknown_run`. Reaching `wrong_tenant` would mean probing with
   `withoutOwner()`. **Not settled here:** dropping it amends ADR 0014's rejection set, and moving
   it to the auth layer relocates an auditability guarantee rather than preserving it. The
   prototype establishes only that the current design cannot deliver it from Acceptance; the choice
   is a human verdict.
2. **`livenessFor` has no home.** ADR 0015 fixes `executionExpiresAt = claimedAt + livenessFor` but
   never says where `livenessFor` is configured. It belongs in `Phase0RunProfile` beside the
   claimable-deadline policy, for the same reason ADR 0013 put that there.
3. **The re-probe's disambiguation order is backwards in the #38 prototype.** It tests the token
   before falling through to `not_eligible`, so a stale token against a Run that `worker_lost`
   already terminalized reports `execution_mismatch`. ADR 0015 requires `not_eligible`. Terminal
   state must be disambiguated before token identity. Both orders return a rejection and both look
   correct; only the name differs, which is why only a scenario catches it.

## Deliberately not here

No tests, no database, no framework, no build. The scenario this prototype designs runs against
local Postgres 17 behind PgBouncer, a clean build of the real app, and real HTTP; none of that
belongs in a shareable single file whose job is to make the state model feel wrong if it is wrong.
