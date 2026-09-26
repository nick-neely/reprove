# A deadline abort gets one wrap-up turn

[ADR 0020](0020-reviewer-method-under-verify.md) §6 kept Phase 1 on an answer target because the
pinned bridge could only abort, and made a Reviewer still running at the hard stop a Failure. It
said that a proven follow-up turn would make `deadline_reached` its own decision. [Prototype one
real Codex Pass in a Vercel Sandbox from a Workflow
step](https://github.com/nick-neely/reprove/issues/114) proved one. Five facts shaped the design:

- **An aborted session is dead, but its thread is not.** Every later call on the aborted session
  throws `AbortError`. `doStop()` returns a `resume-session` state carrying `threadId`, and
  `doStart({ resumeFrom })` spawns a new bridge on the same thread. A fresh turn answered from the
  aborted turn's context in 6.5 s.
- **The respawn needs a new bridge token.** The `doStop()` state carries no bridge, so
  `mintBridgeToken` is called. [ADR 0031](0031-protecting-the-suspend-cursor-and-bridge-endpoint.md)
  §3 forbids exactly that in a continuing Slice.
- **Changing instructions silently starts a fresh thread.** The Harness fingerprints each turn's
  `instructions` and `tools`, and on a change it drops the thread id, because `codex exec resume`
  keeps the thread's original developer instructions. A wrap-up delivered as instructions would
  lose everything the Reviewer did.
- **`doStop()` stops the bridge and proves nothing about the Reviewer.** It asks the bridge to stop,
  waits up to 5 s, then kills the bridge process. If the channel had already closed it returns `{}`
  with no `threadId`, and a resume would start a fresh thread.
- **An aborted turn reports no Usage.** It never emits `finish`
  ([ADR 0023](0023-worker-refusal-over-a-dispatched-run.md), observed by #114).

Settled with the maintainer on 2026-09-26 in [Decide whether a deadline abort gets a wrap-up
turn](https://github.com/nick-neely/reprove/issues/129). This ADR amends ADR 0007, ADR 0019 §7,
ADR 0020 §6, ADR 0021 §7, ADR 0023 and ADR 0031.

## 1. Scope: the deadline, on the hosted Worker, without a configured budget

A **wrap-up** is one bounded turn a hosted Reviewer is given after it has been stopped short of its
deadline, to return what it has. Only the deadline gets one:

- supersession is already fenced from publishing ([ADR 0029](0029-stopping-and-fencing-a-superseded-run.md));
- cancellation means the user asked for no more work;
- `budget` is soft and accounted by the control plane, so it never aborts a turn;
- local `verify` already refuses ([ADR 0027](0027-verify-sandbox-egress.md)).

**A Pass is wrap-up-eligible exactly when no `budget` is configured.** A new turn needs its
predecessors' Usage under a configured budget (§6), and at the abort the running turn's Usage is
always unknown. Eligibility is therefore fixed when the Pass starts. An ineligible Pass keeps ADR
0020 §6's behaviour: it runs to the hard stop and is a `deadline_reached` Failure. Its Check says a
wrap-up was not attempted because a budget is configured, so the adopter can see the trade.

## 2. Three instants inside the ceiling

```text
T  answer target   told to the Reviewer, as today
A  abort           T < A; an eligible Pass aborts whatever turn is running
H  hard stop       H = the configured deadline; the wrap-up never extends it
```

`H − A` is the **wrap-up reserve**, a fixed duration, not a share of the deadline. It must cover
stopping the old bridge, the quiescence proof, the custody transaction, the new bridge and its
checks, the wrap-up turn re-reading a long thread, validation and persistence. Three minutes is a
candidate only. [Measure a deadline wrap-up on a long review thread](https://github.com/nick-neely/reprove/issues/137)
measures it, and [Replace the Phase 0 windows with measured
deadlines](https://github.com/nick-neely/reprove/issues/115) sets the number.

**The Reviewer is not told a wrap-up exists** until it is in one. A Reviewer that knows would plan
to rely on it.

A applies to whichever turn is running, the initial turn or the repair turn, so one Pass may have
an initial turn, a repair turn and a wrap-up turn. There is **at most one wrap-up per Pass**, and it
gets no repair.

## 3. The wrap-up text is the turn prompt; the thread must be the same

The developer instructions stay identical to every earlier turn. The wrap-up text is a **versioned
template in the Adapter**, beside the repair prompt, sent as the wrap-up turn's prompt. The Adapter
build is part of the Revision ([ADR 0018](0018-adversarial-qualification-gate.md)), so the gate
digests it, and the first paid qualification runs against it through ADR 0020 §8's existing edge.
No deadline scenario is added to the gate, which tests adversarial content, not timing.

The text tells the Reviewer that its time is up, to run nothing further, and to return the
required answer from what it has already established. Running commands is not prevented; the hard
stop is the only enforced bound, and commands it runs anyway are observed like any others.

**The same-thread check is essential.** The Adapter confirms the Harness did not restart the thread
and that the resumed `threadId` equals the one `doStop()` returned. Otherwise the wrap-up would
answer from nothing, and the Pass fails (§7).

## 4. Observations persist per Slice, keyed by event identity

The Adapter today appends a turn's observations only when the turn returns. An aborted turn may
never return, and a turn driven across Slices had no stated durable path at all. This is a general
rule, not a wrap-up special case:

- Every Slice persists the observations it received **in the transaction that finishes it**, beside
  its cursor or outcome.
- Each observation is keyed by **`(passId, bridgeGeneration, turnOrdinal, toolCallId)`** under a
  uniqueness constraint and inserted if absent. A replayed tool result deduplicates; two executions
  of the same command have different `toolCallId`s and count as two.
- The final cross-check reads the persisted observations in key order plus the current Slice's.
  ADR 0020 §7's one-execution-per-claim rule applies across every turn of the Pass.
- An observation exists only once its tool result has arrived. A call in flight at the abort has
  none and is never Evidence.
- A Slice that dies before persisting is ADR 0021 §7's ambiguous case and a Failure, so Evidence is
  never partially lost and then relied on.
- Observations carry Reviewer-authored command text and are cleared at terminalization with the
  rest of the Slice payload ([ADR 0031](0031-protecting-the-suspend-cursor-and-bridge-endpoint.md) §2).

The key is **conditional on [#137](https://github.com/nick-neely/reprove/issues/137)** confirming
that `toolCallId` is stable across `attach` and unique within a turn. Codex numbers items per
process, which is why the key carries the bridge generation and turn. If the measurement fails, the
identity becomes the bridge's event id with a nonoverlapping watermark per generation.

## 5. The bridge handoff

Inside the Slice running at A:

1. Abort the turn. Keep the observations received.
2. `doStop()`. It must return a `threadId`.
3. As root, `SIGKILL` every process of the Reviewer uid, then **prove quiescence**: no process of
   that uid remains, the old bridge's pid is gone, and nothing listens on its port. This happens
   before any new token exists.
4. **One transaction** finishes the aborting Slice and claims the wrap-up Slice together, since ADR
   0021 §7 allows one open Slice: it persists the aborting Slice's observations and thread
   projection with state `aborted`, destroys the old token, claims the wrap-up Slice (at most one per
   Pass, by constraint), and commits a fresh encrypted token. The token's AAD gains a **bridge
   generation**, 1 for the initial bridge and 2 for the wrap-up's, so the old ciphertext can never
   stand in for the new one.
5. `doStart({ resumeFrom })`. `mintBridgeToken` returns the committed token only in the wrap-up
   Slice, and only when that Slice has recorded no spawn. This is the one exception to ADR 0031 §3.
6. Rerun ADR 0031 §7's bridge checks against the new idle bridge, then send the wrap-up prompt.

The wrap-up Slice suspends and reattaches like any Slice, and a lost `attach` there is ordinary
`resume_lost`. A retry that finds the wrap-up Slice `started` with nothing persisted is the
ambiguous case and a Failure. A second wrap-up is never started.

## 6. The budget rule is stated in turns

ADR 0019 §7's "execution stops before the next step" is restated: **a new turn does not start under
a configured `budget` unless every earlier turn of the Pass reported Usage.** A continuing Slice of
the same turn is never gated by Usage, since a Slice reports none until the turn's `finish`
(ADR 0023, observed by #114); it is gated by the deadline, liveness and revocation. A repair turn
follows a finished turn; if that turn reported no Usage, the repair cannot start under a budget.

The aborted turn's Usage stays `unknown` under ADR 0023 §7, and the wrap-up turn's is measured.
Whether the wrap-up's `finish` covers the aborted turn is **not assumed**; #137 measures it. The
wrap-up spends from the soft budget, which only an unbudgeted Pass has.

## 7. Outcomes

| What happens | Outcome |
|---|---|
| A valid wrap-up answer before H | `partial` Result, `stoppedBy: deadline_reached`; Run `incomplete`; Check `timed_out` |
| A wrap-up answer that fails validation | Failure `result_invalid`, at once, with no repair |
| The wrap-up still running at H | Failure `deadline_reached` |
| An ineligible Pass still running at H | Failure `deadline_reached` |
| `doStop()` threw or returned no `threadId` | Failure `pass_failed`, detail `wrapup_stop_failed` |
| Quiescence not proven | `pass_failed`, `wrapup_quiescence_unproven` |
| The store answered and the transaction or token commit failed | `pass_failed`, `wrapup_custody_failed` |
| The resumed turn is on a fresh thread | `pass_failed`, `wrapup_thread_restarted` |
| A bridge checker crashed or timed out | `pass_failed`, `wrapup_bridge_check_error` |
| A bridge check demonstrates a breach | `pass_failed`, `bridge_guard` |

`deadline_reached` is reserved for an actual hard-stop overrun. A failure at A happens before the
deadline and is classified by what failed, as one Pass mechanism under `pass_failed`, following
`launch_guard`. A demonstrated breach is a **Failure, not ADR 0031's `sandbox_unenforceable`
Refusal**, because the wrap-up checks run after authorization. If the store is unavailable, no
Failure can be recorded at all: the Pass ends through ADR 0021 §7's ambiguous path or liveness, and
`wrapup_custody_failed` is not promised. Every Worker-reported Failure here reaches the Run only
through [Carry a Worker-reported Failure onto the Run instead of closing it as
worker_lost](https://github.com/nick-neely/reprove/issues/83).

**The wrap-up Result is always partial.** `deadline_reached` is a trusted reason and overrides
`reviewer_stopped` (ADR 0020 §5). Having aborted, there is no falling back to complete.
`unfinished: null` is accepted and changes nothing: the Check's title, the Review's verdict line and
the facts table all say the review was stopped at its deadline, and when `unfinished` is null that
field is omitted, never replaced by words implying something was left unreviewed. A wrap-up with
zero Findings publishes no Review (ADR 0007); only the Check reports it.

## Rejected

- **Keeping the Failure** (ADR 0020 §6 as written): a long review with verified Findings is thrown
  away for running out of time, when the mechanism to keep them is proven.
- **Wrap-up text in the policy or the developer instructions**: telling the Reviewer on the first
  turn invites it to rely on the wrap-up, and a changed instruction fingerprint starts a fresh
  thread without the review's context.
- **A plain union of observations**: counts a replayed tool result twice.
- **Disabling tools for the wrap-up turn**: a second `codexConfig` is a second Revision surface for
  a bound the hard stop already enforces.
- **Exempting the wrap-up from the budget gate**: spend with no bound is what the gate exists to
  stop. Provider-route metering is the way to make a budgeted Pass eligible, [Decide whether the
  Provider route meters Usage per response](https://github.com/nick-neely/reprove/issues/138).
- **A new `wrapup_failed` reason, or `deadline_reached` for every failure**: the first splits one
  Pass mechanism across reasons; the second hides a failure at A behind a deadline that had not
  passed.
- **Waiting until H to report an invalid wrap-up answer**: it is invalid when it arrives.

## Handoffs

- [Measure a deadline wrap-up on a long review thread](https://github.com/nick-neely/reprove/issues/137),
  **blocking #115**: the reserve on a long thread and after a repair turn, `toolCallId` stability,
  whether the wrap-up's `finish` covers the aborted turn, and the quiescence proof against a
  backgrounded Reviewer process.
- [#115](https://github.com/nick-neely/reprove/issues/115): the reserve and A. A default `budget`
  would make every defaulted Pass ineligible.
- [#116](https://github.com/nick-neely/reprove/issues/116): the pin-bump contract suite gains the
  same-thread check, the observation key's replay behaviour and the handoff's bridge checks; the
  first core returning a `pass_failed` wrap-up detail is blocked by #83.

## Consequences

- ADR 0007: `stoppedBy` gains `deadline_reached`; the Check table gains `incomplete` +
  `deadline_reached` → `timed_out`.
- ADR 0019 §7: the budget gate is stated in turns (§6).
- ADR 0020 §6: superseded for eligible Passes; `deadline_reached` is a `stoppedBy` value.
- ADR 0021 §7: Slices persist keyed observations; a Pass may include a wrap-up Slice.
- ADR 0023: `pass_failed` gains the wrap-up details and `bridge_guard`.
- ADR 0031: §3 gains its one exception, the token AAD gains the bridge generation, and §7's checks
  also run before the wrap-up prompt, where a breach is a Failure.
- `CONTEXT.md`: Slice no longer assumes one turn per Pass. Wrap-up stays an execution mechanism, not
  a domain noun; the user-facing outcome is a partial Result stopped by the deadline.
