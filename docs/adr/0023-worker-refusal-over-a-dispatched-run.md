# What a Worker Refusal does to a dispatched hosted Run

[ADR 0015](0015-execution-ownership-and-worker-liveness.md) specified `acceptRefusal` and left it
unexercised, because [ADR 0013](0013-github-ingress-and-run-creation-idempotency.md) made a Refusal
unreachable in Phase 0. Phase 1 composes a real Worker core
([ADR 0021](0021-hosted-composition-and-brokered-sandbox-seam.md)) whose step ladder refuses for
ten named reasons, and [ADR 0019](0019-phase-1-repository-configuration-subset.md) adds
`policy_unenforceable`. Today `runHostedPlacement`'s `refused` branch writes nothing, so a refused
Run is eventually swept as `failed(worker_lost)` and the reason is lost. [Decide what a Worker
Refusal does to a dispatched Run](https://github.com/nick-neely/reprove/issues/95) settles the
transition, and with it four contradictions the record carried:

- `dispatchHostedRun` ran `claimRun`, `startPass`, `markExecuting`, so the pass executed
  concurrently with `markExecuting` and a Refusal could find the Run at either status.
- ADR 0021 §5 admits a Binding request only while the Pass is `executing`, so the same race could
  reject the probe step's own Provider call.
- `CONTEXT.md` placed a Refusal "before execution begins" and, in the Failure entry, "before
  dispatch". A Worker only ever sees a Run after dispatch.
- [ADR 0007](0007-run-result-and-finding.md) described `unscheduled` as "never dispatched", while
  ADR 0015 ends a refused, dispatched Run there.

## 1. `executing` asserts ownership, not that a Reviewer began

`executing` means a live execution owner holds a durable pass. It does not say a Reviewer started.
A Worker can only learn that a hard Sandbox property is missing, or that the instruction boundary
does not hold, after a Sandbox exists and a probe has spent through a Binding, and the Binding
requires `executing`. Moving the status later would need a status between `claimed` and
`executing`, or a second admission rule, for no gain.

## 2. The Refusal boundary is Worker core's authorization line

One event, already drawn in `packages/worker-core/src/run.ts`: "execution is authorized here and
nowhere earlier", after the protected file is materialized and before the Pass. A Refusal is a
decision made **before** that line. An ordinary execution Failure is anything failing **after**
it, including a review turn that fails to start.

The line does not make every earlier stop a Refusal. A Refusal is a decision that a named
requirement was not met. Two existing rules keep their own outcomes on either side of the line:
an owner that goes silent is `failed(worker_lost)` from `claimed` or `executing` (ADR 0015), and
execution that cannot be shown to have stopped is a Failure under ADR 0021 §7's ambiguity rule.

Inside a hosted pass a Refusal has two origins, both before the line: the probe step, and the
first drive Slice, which resolves capability from the probe step's measurement within the
five-minute bound, runs core's gates, launches and materializes, and only then authorizes. Both end
the pass through the same `acceptRefusal`.

## 3. The pass records `executing` as its own first step

Hosted dispatch becomes `claimRun`, then `startPass`. The pass's first step calls `markExecuting`
with the grant's execution token and its own Workflow run id, before the probe step. The ordering
is then fixed, not raced: probe admission always sees `executing`, a hosted Refusal always finds
`executing`, and dispatch's `unrecorded` outcome disappears because nothing records on the pass's
behalf.

Workflow retries steps, so `markExecuting` is idempotent in exactly one case: the Run is already
`executing` under the same token and the same Workflow run id, **and** is still live and inside
the eligibility window. Matching identifiers never revive a terminal Run, and any other token or
run id is refused. A pass whose first step is refused does nothing further and ends. A pass that
was started and never ran its first step leaves the Run `claimed`, and the watchdog closes it as
`worker_lost` with `lostFrom: claimed`, as today.

Rejected: a bounded wait in the pass until the Run reads `executing`, which hides the ordering
behind a poll; and tolerating both statuses in `acceptRefusal`, which leaves the probe admission
race open.

## 4. `acceptRefusal` for hosted execution

One predicate: `status = 'executing'`, the execution token matches, and the Run is inside
Acceptance's eligibility window. One atomic transaction: append the Refusal to `run.refusals`,
clear `executionToken` and `executionExpiresAt`, and write `unscheduled`. Persisting the Refusal
and ending the Run are never separate writes. `RunRecord` exposes `refusals`.

The predicate is scoped to **hosted** execution, where §3 establishes the ordering. ADR 0015's
`claimed` to `queued` return stays as specified for self-hosted Workers and is not decided here;
Phase 3 owns whether a self-hosted Worker can refuse from `executing`.

The transition answers `accepted` or `not_accepted`. `not_accepted` is a normal outcome, not an
error: the Run already ended (superseded, cancelled, swept), or a retried step submitted a
duplicate, where the first wins. Nothing is appended and the Run keeps the state it has. A
database or transport failure is different: it stays a retryable error, and because the step's
Refusal outcome is already durable (§6) the retry resubmits the same Refusal. In every case,
accepted, not accepted or erroring, the pass still tears down its Sandboxes and revokes its
Bindings; cleanup never waits on the transition's answer.

## 5. A hosted Refusal ends scheduling; nothing re-offers automatically

This is policy, not a claim that a retry would refuse identically. Core turns
capability-resolution, Sandbox-launch and materialization errors into Refusals, and any of those
may be transient. The policy rests on four things. An attempt spends a probe turn and a Sandbox.
One attempt is bounded by its deadline and ceiling, and an automatic loop would need a bound of
its own that nobody has designed. The reason is preserved on the Run and named on the Check. And a
person can retry through the Check's re-run, which
[ADR 0022](0022-manual-review-request.md) permits after a terminal Run of any outcome.

The control plane stores the reason uninterpreted and does not classify reasons as transient or
permanent. A later phase can add per-reason re-offer without changing the record. One probe per
Pass stands: `capability_probe_stale` is an ordinary terminal Refusal, reachable when the first
drive Slice starts more than five minutes after the probe step measured.

## 6. The probe step has a durable outcome, and an interrupted probe fails closed

The hosted-pass execution record gains a probe-step row under the same claim-and-replay rule as a
Slice. The row holds the verdict, a Refusal where there is one, and the probe's Usage or an
explicit `unknown`. The first drive Slice persists a Refusal as its outcome the same way. A retried
attempt that finds a persisted outcome returns it, drives nothing and spends nothing.

Persisted outcomes cover **completed** attempts only. A probe step found claimed with no durable
outcome is ambiguous execution under ADR 0021 §7: the Pass ends as a Failure, the Binding is
revoked and teardown is initiated. A second paid probe is never run silently.

## 7. Usage is attributed to the Run for every ending

ADR 0019 §7 requires token Usage and estimated cost on the Run and the Check regardless of budget,
and ADR 0021 §6 counts a failed probe. The protocol `Refusal` payload is unchanged; Usage reaches
the Run through the hosted accounting path, not through the Refusal.

The Run's Usage is an aggregate over the execution record with a completeness:

- Only **distinct increments** are summed. Slice reports may be cumulative for the one turn, so a
  later cumulative report supersedes an earlier one; it is not added to it.
- Probe Usage counts once.
- Nothing is counted twice against `result_usage`: where a Result's Usage already covers the turn,
  the turn's Slices contribute nothing further.
- A step that never started contributes nothing. A step that started and reported no Usage makes
  the aggregate `incomplete`. Unknown is never recorded as zero.

The aggregate and its completeness are exposed on the Run and shown on the Check, for a refused
Run, a Failure and a completed Run alike. A refused Run therefore carries its probe spend.

A configured `budget` with a probe that reports no Usage stops execution under ADR 0019 §7. That
stop may be a Refusal, because a known admission requirement, an establishable remaining budget,
cannot be met; it is not a Refusal merely for happening before authorization. Naming and
classifying it belongs to [Replace the Phase 0 windows with measured
deadlines](https://github.com/nick-neely/reprove/issues/115).

## 8. `unscheduled`, redefined

`unscheduled` means scheduling ended without an accepted execution, because the claim window
expired or because the control plane terminated scheduling after an accepted Refusal. A refused
Run is told apart from one that found no Worker by its non-empty `refusals`; no new status, reason
column or noun. The abandoned-owner case stays explicitly distinct: a claimed or executing Run
whose owner went silent is `failed(worker_lost)`, because that Worker did not answer, and a
refusing Worker did.

## Consequences

- ADR 0007's `unscheduled` row, ADR 0015's abandoned-claim paragraph and unexercised-path
  consequence, and ADR 0021 §8 are amended, each below its own text.
- `CONTEXT.md` gains no noun. **Refusal** and **Failure** are rewritten around authorization.
- `dispatchHostedRun` loses `markExecuting` and the `unrecorded` outcome; the hosted pass gains a
  first step. The "no transition carries one" prose loses its Refusal half when this lands;
  [#83](https://github.com/nick-neely/reprove/issues/83) removes the Failure half.
- Core's closed `RefusalReason` union gains `policy_unenforceable` (ADR 0019); the wire `reason`
  stays a string and the control plane does not interpret it.
- [#111](https://github.com/nick-neely/reprove/issues/111) inherits the Check for a refused Run:
  its conclusion, the named reason with `required` and `actual`, and the Usage aggregate with its
  completeness. ADR 0013 requires that Check to land with the first reachable Refusal.
- [#115](https://github.com/nick-neely/reprove/issues/115) inherits the missing-probe-Usage stop
  and the §2 constraint on what it may be called.
- [#114](https://github.com/nick-neely/reprove/issues/114) should report whether Slice Usage
  arrives cumulative or incremental, which fixes how §7's distinct increments are computed.
- [#116](https://github.com/nick-neely/reprove/issues/116) orders the handoff: the first-step
  `markExecuting` and `acceptRefusal` land no later than the first real core.

## Amended by [#110](https://github.com/nick-neely/reprove/issues/110)

[ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md) settles when a hosted Pass
materializes, which moves the instruction probe and re-describes what §2 called the first drive
Slice.

### The probe runs once, after materialization

The single probe per Pass is unchanged, and so is the five-minute freshness bound, which must hold
**through turn start**. What changes is where it sits: the probe runs **after materialization**,
immediately before the final checks and authorization, in ADR 0024 §9's closure sequence. Probing
earlier would spend a Provider turn on a Pass that materialization may yet end, and would start the
five-minute clock before the longest phase rather than after it.

Probing early is revisited only if measurement justifies it, not on the assumption that
materialization is slow enough to matter.

### "The first drive Slice" becomes the Slices before authorization

§2's "the first drive Slice, which resolves capability from the probe step's measurement within the
five-minute bound, runs core's gates, launches and materializes, and only then authorizes" names one
Slice for work ADR 0024 §10 drives across several: materialization runs detached in the Sandbox and
is polled across **the Slices before authorization**, with a cursor on the execution record. The
Refusal origins are unchanged - a Refusal before the authorization line, persisted as that Slice's
outcome and replayed like any other - and `capability_probe_stale` stays reachable wherever the
bound lapses before turn start.

## Amended by [#88](https://github.com/nick-neely/reprove/issues/88)

§7 holds across teardown. When the lifecycle reaps a terminal Run's Sandboxes ([ADR 0028](0028-reaping-a-hosted-pass-sandbox.md)), any Usage the
Pass had not reported stays `incomplete` on the aggregate, never zero. Stopping a Sandbox writes no
Usage increment.

## Observed by [#114](https://github.com/nick-neely/reprove/issues/114)

**§7: a Slice reports no Usage until the turn ends.** Across three Slices of one turn every
`finish-step` carried zero tokens and only the final `finish` carried the turn's total. Slice
Usage is therefore neither cumulative nor incremental: earlier Slices contribute nothing, and a
Pass that ends mid-turn (the ambiguous Slice, a deadline abort, a Failure) has turn Usage
`unknown`. An aborted turn never emits `finish`. The distinct-increments rule stands; this is why
`unknown` will be common. The Provider route sees every response and could meter Usage per
request, which stays in the map's fog.

## Amended by [#128](https://github.com/nick-neely/reprove/issues/128)

[ADR 0031](0031-protecting-the-suspend-cursor-and-bridge-endpoint.md) adds the Failure reason `resume_lost` (`execution` phase: a continuing Slice could not
reattach, with detail `attach_failed`, `instance_mismatch`, `token_key_unavailable` or
`token_unreadable`), and the `pass_failed` detail `launch_guard`. Both reach the Run only
through [#83](https://github.com/nick-neely/reprove/issues/83).

## Amended by [#129](https://github.com/nick-neely/reprove/issues/129)

[ADR 0032](0032-deadline-wrap-up-turn.md) adds `pass_failed` details for a failed deadline wrap-up handoff: `wrapup_stop_failed`,
`wrapup_quiescence_unproven`, `wrapup_custody_failed` (only when the store answered),
`wrapup_thread_restarted` and `wrapup_bridge_check_error`, plus `bridge_guard` for a demonstrated
breach found by the bridge checks after authorization. An invalid wrap-up answer is `result_invalid`,
and `deadline_reached` stays reserved for a hard-stop overrun. All reach the Run only through
[#83](https://github.com/nick-neely/reprove/issues/83). §7 is unchanged: the aborted turn's Usage
is `unknown`.
