# How a hosted Pass's Sandboxes are reaped

[ADR 0015](0015-execution-ownership-and-worker-liveness.md) left one thing it said nothing
provides: "a cancelled pass is not a torn-down Sandbox". Workflow's `cancel()` writes one event and
runs no `finally`, so a hosted pass abandoned mid-execution leaves whatever Sandbox it opened.
[ADR 0021](0021-hosted-composition-and-brokered-sandbox-seam.md) §7 gave every Sandbox a platform
timeout of the remaining Pass deadline plus a cleanup margin, and [ADR
0024](0024-hosted-workspace-materialization-and-snapshots.md) §10 kept the Sandbox name as the
cleanup identity. [Decide how an abandoned hosted pass's Sandbox is
reaped](https://github.com/nick-neely/reprove/issues/88) settles who stops it, what counts as
stopped, and what is recorded when nobody can tell.

Four facts shaped it. A Vercel Sandbox is persistent by default, and stopping a persistent
Sandbox snapshots its filesystem, which here is the checked-out source, for thirty days. A
non-persistent Sandbox discards its filesystem on `stop()` and on timeout, and `stop()` resolves
once the VM has stopped and is safe to call more than once. A non-persistent Sandbox's metadata
record (name, status, network policy, tags, usage counters) remains for up to fourteen days, and the
dashboard keeps a command history whose contents and retention are not documented. And nothing
documents what an interrupted `create` does server-side, so a negative lookup proves only a moment
(ADR 0024 §10).

## 1. The Run's lifecycle initiates cleanup for every terminal Run

The per-Run lifecycle workflow is the watchdog. It returns when it observes a terminal Run, and
today only its `worker_lost` branch cancels the pass. It gains a **reap step** on two exits:

- `worker_lost`, after its terminal transition has won and after it cancels the pass;
- `ended`, whoever wrote the terminal state. That includes supersession, cancellation, an accepted
  Result or Refusal, a Failure, and the lifecycle's own terminal write that lost a race and re-read.

The step runs only when the Run records a pass id, runs immediately rather than waiting on the
pass, and never runs on `orphaned`: the lifecycle the Run records is the one that reaps. Nothing the
pass does after its Run is terminal needs the Sandbox.

The pass's own `stop()` stays the fast path, so the pass and the reaper may both stop the same
Sandbox. The platform timeout is the backstop. This is **prompt cleanup plus a backstop, not a
guarantee**: a recorded lifecycle that is itself lost leaves only the pass's `stop()` and the
platform timeout, and that gap is accepted in Phase 1 rather than filled with a scheduled sweep.

Rejected: a sweeper keyed on `failure_reason = 'worker_lost'`, which misses every other ending and
needs a scheduler for work the lifecycle already reaches; the platform timeout alone; and a sweeper
that lists the project's Sandboxes, which finds nothing the Run cannot name.

## 2. Sandboxes are created non-persistent and stopped, not deleted

Every Sandbox a Pass creates, `<passId>` and `<passId>.probe`, is created with `persistent: false`.
Teardown is `stop()`. A Pass never stops and resumes mid-Pass (ADR 0021 §7), so persistence buys
nothing and costs a retained copy of the source.

The fourteen-day record is metadata, not repository contents. `delete()` is **not** called in Phase
1. It is added only if [#114](https://github.com/nick-neely/reprove/issues/114) shows the retained
command history or file-read surface holds something §6 cannot keep off it **and** that `delete()`
demonstrably purges it. If deletion does not purge that history, adding it solves nothing.

## 3. One create per name, fenced by an intent row

Before calling `Sandbox.create` for a name, the pass writes a **`create_requested`** row for that
name on the hosted-pass execution record, under the same claim-and-replay uniqueness as a Slice. If
that write fails, create is not called. Create is called only while the Run is live. The pass is
the only creator, so the intent row is what the reaper trusts.

A Workflow retry reads the intent row first:

| The retry finds | It does |
| --- | --- |
| no intent row | writes it, then creates, while the Run is live |
| intent and a recorded sandbox id | reattaches by name and verifies the Sandbox found has **that exact id** before any work |
| intent and no id | ADR 0024 §10's ambiguous case: the Pass ends as a Failure, its Bindings and egress authorization are revoked, and the reaper takes over by name |

An intent with no id **never** causes a second create. A stopped non-persistent Sandbox is not a
resumable Pass: a reattach that finds the Sandbox stopped ends the Pass rather than restarting it.

## 4. Teardown states, and `stopped` only on provider evidence

The execution record carries a teardown state per Sandbox name:

| State | Meaning |
| --- | --- |
| `not_requested` | no intent row exists. Conclusive, because nothing creates without one |
| `pending` | intent exists and no stop is confirmed. This is what intent without a confirmed stop implies, whether or not a later state update was persisted |
| `stopped` | `stop()` resolved on the Sandbox found by that name. Only provider evidence sets it |
| `unconfirmed` | the retry bound passed without `stopped` |

The reaper retries with backoff on durable sleeps until the retry bound, makes one final attempt,
and settles. A `not_found` while intent exists is not confirmation; it stays `pending` and becomes
`unconfirmed` at the bound. `unconfirmed` is final for the reaper and claims nothing about the
Sandbox; it is reported through a bounded operational count. **Passing a calculated deadline is not
evidence that anything stopped**, and a timeout measured from a late server-side create can exceed
any bound computed from the Pass deadline.

The bound has no number yet. [#114](https://github.com/nick-neely/reprove/issues/114) tests an
interrupted create racing a by-name lookup and stop; only then does [#115](https://github.com/nick-neely/reprove/issues/115)
fix it, with the cleanup margin.

No teardown state changes a Run's outcome or its Check. Stopping a terminal Run does not change its
Usage: Usage is the aggregate of probe, Slice and Result increments under [ADR
0023](0023-worker-refusal-over-a-dispatched-run.md) §7, and whatever the Pass had not reported
stays `incomplete`, never zero.

## 5. A hosted Result survives a failed `stop()`

Worker core fails closed on its own teardown: an outcome, a finished Result included, becomes
`failed(sandbox_teardown_incomplete)` when `sandbox.teardown()` throws, because a host that cannot
prove it destroyed the last Sandbox cannot be trusted with the next one. That reasoning is
Quarantine's, and Quarantine is a local Sandbox capability's state. A hosted Sandbox is a fresh
microVM with no Reprove-owned host carried between Passes.

So teardown is placement-specific. On a hosted Sandbox, core's teardown step means **stop
attempted, and the result persisted as `stopped` where it can be**. A Sandbox not confirmed stopped
is `pending` by virtue of its intent row, the reaper owns it, and the outcome stands. A failed
teardown-state write does not discard a valid Result either, since the intent row already carries
the cleanup identity. Pre-authorization exits hand off the same way, so a Refusal is preserved as
core preserves it today. `sandbox_teardown_incomplete` remains the outcome only on local placement.

What still makes teardown matter is running processes and retained source, not the next Sandbox.
New Provider and egress admissions stop only once the Run is terminal or authorization is revoked
(§7), not when core finishes, and a request already admitted is not retracted (ADR 0021 §5).

## 6. What Reprove's own commands may put on Vercel's retained surfaces

Commands Reprove issues through `runCommand` may appear in the dashboard's command history. Three
rules:

1. **argv and env carry no secret and no repository content.** The base repository URL, SHAs and
   paths Reprove fixes may appear, and their retention is explicitly accepted.
2. **A command whose output may carry source-derived content does not write it to its stdout or
   stderr.** Evidence reads for the cross-check use the SDK's file-read API; launcher and bridge
   logs go to a file inside the VM, and the host reads a bounded tail only to diagnose.
3. Commands whose output is fixed facts (SHAs, counts, uids) print normally, with any verbose mode
   that lists repository paths turned off.

The Reviewer's own commands and Project commands run inside the Harness, not through `runCommand`.
The commands as designed, **not yet observed**:

| Command | argv and env | Output may carry |
| --- | --- | --- |
| user setup and privilege preflight | fixed | uids, mount facts |
| `git` init, fetch by SHA into both copies, strip remotes, helpers and hooks | base repository URL, SHAs, fixed paths; the token only through the firewall | progress, ref names, object counts |
| completeness checks | SHAs | SHAs, and paths on failure |
| size measurement | fixed paths | byte counts |
| launcher and bridge start | fixed | nothing on stdout; logs to a file in the VM |

Neither the table nor what Vercel retains from it is established until
[#114](https://github.com/nick-neely/reprove/issues/114) runs these commands and reports what the
command history records (argv, env, output) and whether SDK file reads appear in it.

## 7. The egress route checks Pass liveness on every admission

[ADR 0027](0027-verify-sandbox-egress.md)'s egress route admits a request only while its Pass is
live, the same predicate the Provider Binding already applies under ADR 0021 §5, checked on every
admission. A check that cannot complete rejects. This cuts **new Reviewer-phase egress** once the
Run is terminal or the authorization is revoked. It does not retract a request already admitted,
and it does not reach the materialization phase, whose GitHub token is ADR 0024 §9's to revoke.

## 8. Custody expiry runs on ADR 0008's purge job

ADR 0024 §9's per-Pass custody record is deleted in the transaction that records the token invalid.
The reap step attempts revocation of a token not yet confirmed invalid, best-effort, and deletes the
record when invalidity is confirmed. A record whose revocation cannot be confirmed, or whose
lifecycle is lost, is deleted after its expiry by **the purge job [ADR
0008](0008-persistence-tenancy-and-retention.md) already requires**, not by a separate sweep. Owner
deletion cascades to custody records.

The purge job reaches Owner-scoped rows through **`SECURITY DEFINER` functions owned by a dedicated
`NOLOGIN` maintenance role**. Each function is a fixed statement with no caller-supplied predicate
and returns counts only. The maintenance role holds only the narrow policies those statements need:
delete custody past `expires_at`, and ADR 0008's field purge. The runtime role is granted `EXECUTE`
on the functions and nothing more, and the cron entry point calls them over the ordinary runtime
connection. Boot's misconfiguration check asserts the function set, its owner and the maintenance
role's policies. No new credential and no `BYPASSRLS` exist; the runtime role can trigger fixed
purges and learn how many rows they touched, and can read nothing across Owners.

Rejected: a third login role for cron, which adds a credential; purging per Owner in turn, since
enumerating Owners is itself the cross-tenant read; the admin connection, which ADR 0008 keeps off
application traffic; and a lazy per-Owner purge on custody insert, since the purge job is required
anyway.

## Handoffs

- [#114](https://github.com/nick-neely/reprove/issues/114): an interrupted create racing a by-name
  lookup and `stop()`; whether a second create under an existing name is rejected; how a Sandbox's
  exact id is verified when found by name; what `Sandbox.get` returns for a stopped, a never-created
  and a timed-out non-persistent Sandbox; what command history retains (argv, env, output), whether
  SDK file reads appear in it, and whether `delete()` purges it.
- [#115](https://github.com/nick-neely/reprove/issues/115): the reaper's retry bound and the cleanup
  margin, after #114 measures the create and lookup race.
- [#118](https://github.com/nick-neely/reprove/issues/118): the generic reap covers a superseded
  Run's Sandbox once its lifecycle wakes. #118 decides whether that is prompt enough, whether the
  pass's Workflow run is also cancelled, and its publication fence, which stays independent of
  whether teardown succeeds.
- [#116](https://github.com/nick-neely/reprove/issues/116), **blocking**: the purge job over §8's
  maintenance path, with proof that an expired custody record is deleted and that the runtime role
  cannot select through the functions; and a cleanup proof covering an interrupted create and a
  terminal Run whose lifecycle reaps its Sandbox.

## Consequences

- The hosted-pass execution record gains a `create_requested` intent row and a teardown state per
  Sandbox name.
- The lifecycle workflow gains a reap step on `ended` and `worker_lost`, reached only from inside a
  step through `worker-hosted`'s ports, so the workflow bundle stays Harness-free (ADR 0021 §3).
- Worker core's teardown failure policy becomes placement-specific.
- ADR 0015's deferred teardown statement is resolved here. ADRs 0021 §7, 0023 §7, 0024 §9, 0027 §3
  and 0008 are amended.
- `CONTEXT.md` gains nothing. **Quarantine** already names a local Sandbox capability.

## Observed by [#114](https://github.com/nick-neely/reprove/issues/114)

- **§6, observed.** The dashboard's command history shows each command's argv **in full**,
  including `sh -c` script text; it never shows env values, stdout or stderr, and never shows SDK
  file writes or reads. Through the API, a stopped Sandbox still returns each command's argv, cwd
  and exit code but not its env, and its output is `410 sandbox_stopped`. **`delete()` purges** the
  Sandbox, its sessions and its command history from the dashboard, log search and API (`404`).
  Rule 1 is the rule that matters; the table stands, with "may appear" now "appears, argv only".
- **§3: an interrupted create can complete after the client gives up.** Aborted at 300 ms, a
  create left a by-name lookup returning `404` at 641 ms and the Sandbox existing at 2.5 s; aborts
  at 150 ms never created one. A `404` after an interrupted create proves nothing, which is why
  intent without an id must never create again. A retry that does call create gets `400` "already
  exists", not `409`. A create the platform **rejects** outright (an invalid name returns `400` at
  once) is not ambiguous; the record should distinguish a definite rejection from an unknown
  outcome instead of leaving intent without an id.
- **§3: exact-id verification works.** `currentSession().sessionId` (`sbx_...`) is stable for a
  non-persistent Sandbox, equals the token's `sandbox_id`, and is what `get` by name returns.
- **`Sandbox.get` by state**: running returns `running`; stopped returns the Sandbox as `stopped`
  without resuming it; never-created and deleted return `404 not_found`; a non-persistent Sandbox
  past its timeout reads `stopped` at the timeout, and a command on it fails `400` "Cannot resume
  sandbox: no snapshot available". `stop()` took 1.3 to 3.3 s and a following `get` reading
  `stopped` is the provider evidence §4 needs.

## Amended by [#118](https://github.com/nick-neely/reprove/issues/118)

[ADR 0029](0029-stopping-and-fencing-a-superseded-run.md) changes §1. On `ended` the lifecycle also cancels the pass's Workflow run, in a bounded step
whose failure or timeout never prevents the reap. The pass's own `stop()` gains a trigger: a Slice
claim refused because the Run is no longer `executing`. The generic reap covers a superseded Run as
this ADR's handoff said, and no stricter promptness is promised.
