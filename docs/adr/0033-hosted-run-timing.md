# Hosted Run timing: one clock fixed at claim, and a receipt the database authorizes

Phase 0 fixed a five-minute claim window and a ten-minute liveness window as fixtures that "Phase 1
replaces with a measured value" ([ADR 0014](0014-workflow-orchestration-seam.md),
[ADR 0015](0015-execution-ownership-and-worker-liveness.md)). Since then `deadline` became a required
per-Run ceiling on Reviewer execution ([ADR 0019](0019-phase-1-repository-configuration-subset.md)),
the Reviewer was given an answer target inside it ([ADR 0020](0020-reviewer-method-under-verify.md)
§6), a budget-free Pass gained a wrap-up turn ([ADR 0032](0032-deadline-wrap-up-turn.md)), and
several ADRs handed their numbers here. A constant liveness window cannot fit a per-Run deadline:
a hosted Worker cannot renew, so the window either kills long reviews or leaves a short one's stale
window open.

The inputs, measured in `iad1` by [#114](https://github.com/nick-neely/reprove/issues/114) and
[#137](https://github.com/nick-neely/reprove/issues/137):

- a realistic small review took 137 s end to end: about 20 s of setup and probe, a 91 s turn;
- a wrap-up took 15-20 s from abort to a persisted Result, with an estimated worst case near 90 s;
- on this org's tier, `gpt-6-sol`'s 500K tokens-per-minute limit counts cached input, so a
  160-200K-token thread makes about 2.5 requests a minute, and until
  [#139](https://github.com/nick-neely/reprove/issues/139) lands each throttle fails the Pass;
- the Sandbox has 64 GB of disk; its session is capped at 45 minutes on Hobby and 24 hours on Pro,
  and a Workflow step at 300 s on Hobby and 800 s on Pro;
- Workflow's `maxRetries` counts retries, not attempts; the default of 3 re-enqueues a killed step
  immediately with no backoff ([research](../research/hosted-sandbox-on-vercel.md) §6.1).

Settled with the maintainer on 2026-09-28 in [Replace the Phase 0 windows with measured
deadlines](https://github.com/nick-neely/reprove/issues/115).

## 1. One clock, fixed at claim

The **hard stop** H is `claimedAt + deadline`, written in the claim transaction beside
`executionExpiresAt`. Materialization, the probe and every turn count against it (ADR 0024 §10).
The queue delay between claim and the pass's first step, observed in seconds, is charged to the
Reviewer; that is accepted for having one clock set at the one moment ADR 0015 already fixes things
for a hosted Worker.

Four instants are measured back from H:

```text
S  authorization cutoff   H - 10 min   the Reviewer's turn starts only before S
T  answer target          H -  5 min   told to the Reviewer (ADR 0020 §6)
A  abort                  H -  3 min   wrap-up-eligible Passes only (ADR 0032)
H  hard stop              H
```

- **H − A, the wrap-up reserve, is 3 minutes**: twice the estimated 90 s worst case.
- **A − T, the repair allowance, is 2 minutes.** A repair turn still running at A is aborted and the
  wrap-up replaces it, so a short allowance loses little.
- **T − S, the review floor, is 5 minutes**, so a Reviewer never starts with its answer target
  already close.
- A Pass with a configured `budget` has no A, but its T is the same, so neither the policy text nor
  the turn prompt depends on budget.

Missing S before authorization, whatever used the time, is the Failure **`review_window_lost`**.
It is a Failure, not a Refusal: nothing about the Run was inadmissible, the time ran out.

## 2. The `deadline` bounds

```text
default                 20 min   PRODUCT_DEFAULTS
minimum                 18 min
maximum                 min(60 min, sandboxSessionLimit - 10 min)
```

The minimum is the sum of what must fit before H, plus slack:

```text
materialization ceiling   4 min    materialization_timeout (ADR 0024 §11)
probe allowance           1 min    measured 13.5-14.8 s
review floor              5 min    S -> T
reserves                  5 min    T -> A -> H
slack                     3 min    claim, create and scheduling latency, measured in seconds
                         ------
                         18 min
```

The deployment declares its Sandbox session limit, because the control plane cannot see the Vercel
plan. `sandboxSessionLimit` defaults to **45 minutes**, the Hobby value, which gives a
**35-minute** maximum and keeps 10 minutes of headroom for claim and create lag. A Pro deployment
raises it and reaches the 60-minute product cap. A configured `deadline` outside the bounds is
`config_unsupported` at Run creation, so a deployment never accepts a Run it cannot actually run.

Slices are bounded at **4 minutes**, which fits Hobby's 300 s step.

## 3. Hosted liveness is derived from the deadline

```text
executionExpiresAt = H + livenessGrace        livenessGrace = 10 min
```

`livenessForMs` leaves `DeploymentPolicy` for hosted Runs; the self-hosted Lease's window stays
Phase 3's. The grace covers only control-plane work after H (§6) and is independent of the Sandbox
timeout. It is a product constant because the finalize policy it bounds is fixed.

## 4. What enforces H

Enforcement is layered, and no layer's clock is trusted as proof that anything stopped.

- **The drive Slice** is the primary actor: each Slice runs to the earliest of its own bound, A and
  H. At A it aborts for the wrap-up (ADR 0032); at H the Pass has missed its deadline. If no Slice
  is running at A, the next Slice claimed before H performs the abort, late rather than skipped.
- **The Slice claim** refuses once H has passed (ADR 0021 §7's "within its deadline").
- **The Sandbox platform timeout targets H** and bounds the normal case. ADR 0021 §7's cleanup
  margin becomes **zero**. The timeout is set from the client's clock at create, so a late
  server-side create moves the stop past H (ADR 0028, observed by #114). It is **not** an egress
  guarantee.
- **The Provider route** stops new admissions at H and **actively aborts every upstream stream it
  holds** at H, including a streamed body. Expiring an admission row alone does not stop a request
  already admitted.
- **The lifecycle wakes at H** (§5) and terminalizes a Run with no qualifying receipt.

The Provider route has **no stall limits** in Phase 1. The measurements establish neither a
time-to-headers nor a stream-idle bound that every legitimate model request meets. A hung upstream
is left to Codex's own client-side stream idle timeout and its retry, which is
[#139](https://github.com/nick-neely/reprove/issues/139)'s path.

## 5. The receipt: a validated Result the database authorized before H

The Worker completes validation, the repair turn and the Evidence cross-check **before H**, inside
the Sandbox's life, as it does today; #137's 15-20 s ends at a persisted Result. What counts as
arriving in time is a **validated Result persisted in the hosted-pass execution record** under a
database-authorized receipt. No raw answer is persisted for later validation, so no
pending-validation state exists, and no invalid answer is ever discovered after the Sandbox has
stopped.

The execution record carries a receipt state, `open`, `received` or `closed`, and two transitions
race on it under the **same row lock**:

```text
receipt       lock the row; require open and clock_timestamp() <= H; write the Result; received
H transition  lock the row; require open and clock_timestamp() > H;  closed; Run deadline_reached
```

Whichever takes the lock first decides. A receipt authorized before H that is still committing holds
the lock, so the H transition waits and then finds `received`. A receipt that takes the lock after
H is refused by its own check. `clock_timestamp() <= H` alone would prove only when the database
evaluated the condition, not that the write committed by H; the lock makes the evaluation and the
state change one decision. Worker clocks play no part.

The Run's lifecycle gains **a wake at H** beside its wakes at `claimableUntil` and
`executionExpiresAt` (ADR 0015's state-driven loop). At H it re-reads the receipt state and applies
the H transition if the state is still `open`. **A delayed H wake never makes a late Result
eligible**: the receipt's own check refuses after H whether or not the wake has run. Everything
else fails closed as `deadline_reached`: an answer received but not persisted, a killed step, a
receipt transaction that loses the lock to the H transition.

## 6. After H: a replay-safe finalize step

All post-H work is one **finalize step**: submit the received Result, run Acceptance, complete the
Usage aggregate. It touches no Sandbox.

- It bounds itself at **60 s**, enforced with abort signals on every call it makes, and sets
  **`maxRetries: 3`**: at most **four attempts**, re-enqueued immediately with no backoff.
- **Four cooperative 60-second attempts take about 4 minutes.** That is the bound for attempts
  that honour the abort, not the absolute worst case: a step that ignores its abort runs until the
  platform's `maxDuration` kills it, and the grace can pass first.
- **It is replay-safe.** Acceptance may commit before the step loses its acknowledgement, so a
  retry that finds the **same Result** already accepted finishes successfully. The receipt admits
  one Result per Pass, so a retry never holds a different one.

## 7. Endings

| What happens | Ending |
| --- | --- |
| The Run is live at H with no receipt | Failure `deadline_reached`, by the H transition |
| An owner-loss detector saw evidence before H: the prompt detector, or the pass's Workflow run observed failed or cancelled | `worker_lost` |
| A receipt exists but no Acceptance by `executionExpiresAt` | `worker_lost`, detail `finalization_incomplete` |
| Missing S before authorization | Failure `review_window_lost` |

**The Slice record does not classify a cause.** A recently persisted Slice does not prove the owner
survived to H, and an old one does not prove it died. So a Run still live at H with no receipt is
`deadline_reached`, and an owner that dies silently before H is reported that way. The Check's
wording, that the review did not finish by its deadline, stays true in both cases.

**`finalization_incomplete` does not claim the owner was proven lost.** It records that
finalization failed or timed out after the Reviewer answered in time. The Check says the Reviewer
answered on time, Reprove failed to finalize the Result, and a re-run is the way forward. The
unaccepted Result is not published.

## 8. Budget

- **No default `budget`.** `deadline` is the only defaulted bound, so a defaulted Pass stays
  wrap-up-eligible. Provenance records `budget` as absent, not defaulted.
- **`budget` stays soft** in Phase 1. Usage arrives only at a turn's `finish`, and whether the
  Provider route can meter per response is [#138](https://github.com/nick-neely/reprove/issues/138)'s.

| What happens under a configured `budget` | Ending |
| --- | --- |
| The probe reports no Usage | Refusal `usage_unmeasurable` (before authorization; ADR 0023 §2) |
| A turn is blocked because an earlier turn reported no Usage | Failure `usage_unmeasurable` |
| A repair turn is blocked because known Usage meets the budget | Failure `budget_exhausted` |

A blocked repair is a Failure because there is **no valid answer to accept**; only an answer that
needs repair leads there. The Finding count plays no part: ADR 0007 permits a partial Result with
zero Findings and suppresses only the Review. `stoppedBy: budget_exhausted` is therefore
**unreachable in Phase 1**, since a soft budget never interrupts a turn and a valid answer is
always accepted with the completeness the Reviewer declared. It stays in the v1 schema for a later
multi-turn Strategy.

## 9. Materialization and disk

- The **materialization ceiling** is 4 minutes of setup time, inside `deadline`
  (`materialization_timeout`, ADR 0024 §11).
- The **disk ceiling** for `workspace_too_large` is **24 GB**, measured over both histories, the
  checkout and the fetch temporaries. This is a **policy choice**, not a measured capacity
  requirement; it leaves about 40 GB of the 64 GB disk for install, builds and scratch.

## 10. The reaper

The reaper retries until **H + 15 minutes**, an **operational** bound, then records `unconfirmed`
(ADR 0028 §4). `unconfirmed` claims nothing: an interrupted create can finish late, and a timeout
measured from that late creation can outrun any bound calculated from H.

## 11. What is configurable

An override must preserve the timing invariants, checked at boot; a deployment whose values break
them fails to start.

| Env-readable in `DeploymentPolicy` | Default | Invariant checked at boot |
| --- | --- | --- |
| `claimableFor` | 5 min | positive |
| `sandboxSessionLimit` | 45 min | at least 28 min, so `maxDeadline` admits the 18-minute minimum |
| disk ceiling | 24 GB | at most 56 GB, keeping 8 GB of the 64 GB disk |

The claim window rests on Workflow start latency observed in seconds, not on a stress measurement;
it bounds only `queued` to `claimed`, so generosity costs only a slower `unscheduled`.

Everything else is a **product constant**, versioned in code, so a change shows its arithmetic in
one diff: the default, minimum and cap on `deadline`, the reserves, the review floor, the
materialization ceiling, the probe allowance, the Slice bound, `livenessGrace`, the finalize policy
and the reaper bound.

## Rejected

- **A constant hosted liveness window.** It cannot fit a per-Run deadline.
- **Classifying `worker_lost` from Slice timestamps.** The recency of a persisted Slice proves
  nothing about the owner at H.
- **A Workflow-level `sleep` race against the pass.** A second clock with no added guarantee.
- **A cleanup margin after H.** Nothing inside the Sandbox has to happen after H once the Result
  must be received before it.
- **Persisting a raw answer and validating after H.** It needs a pending-validation state and rules
  for an invalid answer found after the Sandbox stopped, for no gain.
- **Route stall limits of 120 s to headers and 60 s idle.** Nothing measured establishes that
  legitimate model requests always meet them.
- **Env-readable `livenessGrace`.** It is coupled to the finalize policy and the reaper horizon.

## Handoffs

- [#116](https://github.com/nick-neely/reprove/issues/116): confirm Codex 0.156.1's pinned stream
  idle timeout default; record the longest observed Provider request in the exit scenario, so
  stall limits can be justified later if needed; prove the receipt race (a receipt committing across
  H, a delayed H wake, a finalize retry after a lost acknowledgement); `PHASE_0_RUN_PROFILE`'s two
  windows leave with ADR 0019 §8's split.
- [#138](https://github.com/nick-neely/reprove/issues/138): whether per-response metering can make
  `budget` a hard bound.

## Consequences

- ADR 0007: `stoppedBy: budget_exhausted` is unreachable in Phase 1; Failure details gain
  `review_window_lost`, `usage_unmeasurable`, `budget_exhausted` and `finalization_incomplete`.
- ADR 0014: the claim window is 5 minutes, env-readable, now a product value.
- ADR 0015: hosted `executionExpiresAt` is `H + livenessGrace`; the lifecycle gains a wake at H;
  `worker_lost` needs detector evidence before H or an unaccepted receipt at the boundary.
- ADR 0019 §7 and §8: no default `budget`; the default `deadline` is 20 minutes; `DeploymentPolicy`
  holds `claimableFor`, `sandboxSessionLimit` and the disk ceiling, not `livenessForMs`.
- ADR 0020 §6: T = H − 5 min; the reserve after T is 5 minutes.
- ADR 0021 §7: the cleanup margin is zero; Slices are at most 4 minutes; the finishing Slice's
  transaction is the receipt.
- ADR 0023: `usage_unmeasurable` is the Refusal before authorization.
- ADR 0024 §11: the materialization ceiling is 4 minutes and the disk ceiling 24 GB.
- ADR 0028 §4: the retry bound is H + 15 minutes; the cleanup margin is zero.
- ADR 0030: the Provider route aborts held upstream streams at H; nothing restores per-request
  egress liveness.
- ADR 0032 §2: H − A is 3 minutes.
- `CONTEXT.md` gains no noun. The answer target, abort and hard stop are execution instants, and the
  receipt is a mechanism; the user-facing term stays `deadline`.
