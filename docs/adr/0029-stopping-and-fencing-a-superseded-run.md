# Stopping a superseded Run's Pass and fencing what it publishes

[Walk the Phase 1 user journey and pull in what makes it usable](https://github.com/nick-neely/reprove/issues/103)
required that two quick pushes never yield a stale Review. [Decide how a superseded Run's live Pass
is stopped and kept from publishing](https://github.com/nick-neely/reprove/issues/118) settles how a
superseded Run's Pass is stopped, what keeps any Run from publishing a Review the pull request has
moved past, and how a superseded Run's Check and Usage are reported.

Five facts shaped it.

- **Acceptance does not cover publication.** `CONTEXT.md` makes Acceptance the stale-result
  boundary, so a superseded Run never has an accepted Result. But a Run accepted just before a push
  is already terminal, supersession ends only live Runs, and its Review can still be in flight when
  the next head arrives. That is the stale Review this ADR exists to prevent.
- **GitHub defaults a Review's `commit_id` to the pull request's newest commit**
  ([docs](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)), so a
  Review posted without it lands on a head it never reviewed.
- **A Review has no idempotency key and cannot be deleted once submitted.** A Check can be
  re-asserted; a blindly retried Review is a second Review.
- **Reconciliation's baseline is the most recent prior Run that published** (`CONTEXT.md`, ADR 0008).
  Publication order and the baseline are one decision: a Review skipped after a later Run reconciled
  against it leaves that Run linking a Comment that does not exist.
- **The lifecycle wake is best-effort.** `notifyLifecycle` reports an undeliverable wake rather than
  throwing, and a lost wake costs latency until the execution deadline. ADR 0028 §7 already stops
  new Provider and egress admissions once the Run is terminal, so spend is bounded without the wake;
  compute and a running Project command are not.

## 1. Stopping is cleanup, in three independent measures

None of these is a correctness boundary; §3 and §4 are. All three are adopted.

1. **The lifecycle reaps on `ended`** (ADR 0028 §1, unchanged): it stops `<passId>` and
   `<passId>.probe` by name.
2. **The lifecycle also cancels the pass's Workflow run on `ended`**, as `worker_lost` already does.
   The cancel is its own bounded step: it has a timeout, its failure is recorded and swallowed, and
   the Sandbox stop runs whether the cancel succeeded, failed or timed out. `cancel()` runs no
   `finally`, which is safe because the reap lives in the lifecycle, not in the pass.
3. **The Slice claim requires the Run to be `executing`**, checked in the same statement as ADR 0021
   §7's serialized claim, not read beforehand. A claim refused on that predicate ends the pass with
   no Result and stops its own Sandbox, ADR 0028's fast path.

**What this does not guarantee.** The Slice claim fences the *next* Slice; it cannot interrupt a
command already running in the current one. So a lost wake can leave a superseded Pass's work
running until its current Slice ends or the Sandbox reaches its platform timeout. No stricter
promptness is promised, and the wake is not made durable.

## 2. A superseded Run records why, as facts

The transaction that supersedes a Run writes three nullable columns on it:

| column | value |
| --- | --- |
| `supersededAtHead` | the canonical head that transaction observed |
| `supersededOutcome` | `new_run`, `existing_run`, `refusal` or `disabled` |
| `supersededTarget` | the Run created, the Run already at that head, or the Refusal record; null for `disabled` |

`existing_run` is ADR 0013's `duplicate_head`: a live Run at a stale head is superseded before the
duplicate-head check, and a terminal Run already at the canonical head makes it a no-op, so there is
no successor, Refusal or `disabled` outcome. Whether the head moved is derived by comparing
`supersededAtHead` with `run.headSha`, never stored twice.

**The Check title is built only from recorded facts, and never claims a review happened.**
`new_run` means a Run was created, not that it reviewed anything, and `existing_run` may name a
Failure. The wording is neutral:

| head | outcome | title |
| --- | --- | --- |
| moved | `new_run` | Superseded: the pull request moved to `abc1234`, and another Run started |
| moved | `existing_run` | Superseded: the pull request moved to `abc1234`, which already has a Run |
| same | `new_run` | Superseded: another Run started for this commit |
| either | `refusal` | Superseded: a new review was refused (the Refusal's reason) |
| either | `disabled` | Superseded: reviews disabled by configuration |
| unrecorded | - | Superseded |

Rejected: a polymorphic `supersededBy` reference alone, which cannot express `existing_run`'s
relation or whether the head moved; and deriving the cause later from pull request state, which is
wrong for a same-head supersession.

## 3. Every publication write for a pull request happens under one lease

**One per-pull-request publication lease** in Postgres, keyed by Owner, repository and pull request
number, with a fencing token. Every Check write and every Review write for that pull request is made
by the lease holder. The lease outlives the GitHub request timeout, and a holder aborts a write it
cannot start well inside the lease.

**Check writes are state-driven and forward-only.** The holder reads the Run (or Refusal or config
validation record) under the lease, writes the Check state it maps to, then re-reads and keeps
writing until what it last wrote matches the current state, then releases. A concluded Check is
never moved back, only re-asserted. So a late `in_progress` can never land after a `cancelled`
conclusion, because nobody writes `in_progress` except a holder that has just read `executing`.

A superseded Run's Check is concluded `cancelled` (ADR 0007) with §2's title. The superseding
transaction enqueues that publication through the same durable publication row every terminal Run
uses; stopping the Pass has no bearing on it.

**This is coordination, not an ordering guarantee at GitHub.** GitHub cannot check the fencing token,
and a POST in flight can commit after its lease expires even when the client aborts. §5 covers what
that means for a Review. A Check write that lands late is repaired by the next holder's re-read and
re-assertion.

Rejected: a per-Check lease plus a separate per-pull-request Review lease, two locks that interact
for a surface that sees a handful of writes; a Workflow run per pull request, which needs its own
singleton election because `start()` takes no idempotency key; and a session advisory lock, which a
serverless connection cannot hold across a network call.

## 4. The Review fence

Under the lease, immediately before posting a Run's Review, in this order:

1. **Any `unresolved` Review on the pull request holds this one** (§5). It is not attempted.
2. **The Run must hold an accepted Result.** A superseded Run never does, which is Acceptance's
   existing guarantee.
3. **The current head is read live from GitHub**, `GET` on the pull request. The database records no
   current pull request head (ADR 0013 fetches it during ingress and persists it only on the Runs it
   creates, and a `disabled` or refused outcome creates none), so it is not a substitute. A failed
   `GET` is retried; it is never read as `stale_head`.
4. **A moved head skips the Review as `stale_head`.**
5. **A Run later in the pull request's sequence** (§6) **that has a `published` Review skips this one
   as `overtaken`.** This is reachable at an unchanged head: a manual re-run of a terminal Run
   (ADR 0022) can publish first.
6. **Otherwise Reconciliation runs against the baseline** (§6), and the Review is posted with
   `commit_id: run.headSha`, always.

**The guarantee, stated honestly: publication never knowingly starts for a head the pull request has
moved past.** A read and a POST cannot be atomic, so a push racing an in-flight POST can still leave a
Review on the old commit.

A skipped Review is a Review outcome on the publication row, not a Run status: the Run stays
`completed` or `incomplete`, because it did finish reviewing its commit. **A skipped Run never becomes
anyone's baseline.** Its Findings stay in the Check ledger with that outcome.

**The Check of a Run whose Review was skipped or held concludes from the Run outcome under ADR 0007**,
independent of the Threshold and of whether a Review posted. That Check sits on its own commit, so it
is a true statement about it, and branch protection reads the current head's Checks. Its title says
the Review was not posted and why, or that it is held because an earlier Review's outcome is unknown.

## 5. A Review POST whose outcome is unknown stays `unresolved`

A Review POST that timed out, lost its connection or outlived its lease has an unknown outcome. Its
row moves to **`unresolved`** before anything else happens, and **no later Review on that pull request
reconciles or posts until it is resolved or force-released**. Check writes are not held.

**Every Review body carries the marker `<!-- reprove.run.<id> -->`**, the Run's `external_id`, apart
from the visible footer, whose rendering may change. Resolution lists the pull request's Reviews and
looks for one authored by the App carrying that marker; one found is recorded `published` with its
review id and becomes a baseline.

**A lookup that finds nothing is not evidence the POST will never commit.** No settle interval proves
that, so a miss is never recorded as `not_posted` and never triggers a retry. The row keeps a durable,
bounded lookup retry of its own; it does not depend on a person clicking anything. A Check re-run on
the pull request may also prompt a lookup, but that is a convenience: ADR 0022 defines a re-run as a
new review request, not a publication recovery button. Past the bound, the row stays `unresolved` and
is flagged for operator attention.

**Recovery by marker lookup is conditional until it is proven.** GitHub documents that listing Reviews
returns the raw body, but nobody has verified that this marker survives a create-and-list round trip
on the fixture repository. Until [Check whether a pending App Review makes Review publication
recoverable](https://github.com/nick-neely/reprove/issues/134) proves it, this ADR does not promise the
lookup recovers anything.

**The only way past an unresolved Review without GitHub's evidence is a forced release.** In Phase 1
that is a documented runbook step, not a product surface: a conditional update against the exact
unresolved row (its id and its `unresolved` state), which moves it to `force_released` and records who
released it and that they accepted the risk of a late post. It is not a statement that nothing was
posted. A force-released Run is not a baseline; if its Review later appears, a lookup that finds the
marker records the fact but does not rewrite any Review since.

**A moved head does not clear an `unresolved` POST.** The Review for that old Run may still appear, so
later Runs stay held from reconciling until the uncertainty is resolved or force-released. A held Run
whose own head has since moved is dropped as `stale_head` when its turn comes; that neither releases
the queue nor guarantees no stale post.

**Check creation with an unknown outcome** is resolved by listing the head's Check Runs by name and
`external_id`. A miss may re-create the Check, because a duplicate is recoverable: GitHub shows the
newest per name (ADR 0025 §9), and it gets concluded. Its stored Check Run id and suite id must still
be reconciled to one row, because ADR 0022 validates re-runs against them; the handoff ticket covers
what GitHub returns for the duplicate.

Rejected: an automatic retry after a lookup miss past a settle interval, which turns a late commit
into a stale Review and a wrong baseline, not merely a duplicate; and a human-confirmed `not_posted`,
which asserts the same unprovable fact with a person's name on it. GitHub's two-step pending Review
(create without `event`, then submit) could make recovery automatic if an App is limited to one
pending Review per pull request and an unknown submit is distinguishable; that is #134's to test.

## 6. The pull request's Runs have a durable sequence

`run.created_at` is the transaction's start time, and two ingress transactions serialized by ADR
0013's per-pull-request lock can take their start times in the opposite order to their commits. So
**each Run gets a per-pull-request `sequence`**, assigned as `max + 1` inside ADR 0013's existing
critical section, with a unique index on Owner, repository, pull request number and sequence. ADR
0008 keeps Run rows rather than deleting them, so `max + 1` stays meaningful under retention.

- **"Later"** means a higher sequence on the same pull request.
- **The Reconciliation baseline** is the highest-sequence Run below this one whose Review is
  `published` with a GitHub review id. `stale_head`, `overtaken`, `force_released` and `unresolved`
  rows are never a baseline, and while any row is `unresolved` no baseline is chosen at all (§5).

`CONTEXT.md` already states the domain rule, "the most recent prior Run that published"; the
sequence is how it is computed and stays here.

## 7. A superseded Pass's Usage

ADR 0023 §7 stands unchanged. Usage increments a superseded Pass recorded stay on its Run, anything
missing makes the aggregate `incomplete`, and unknown is never zero. No particular shape is assumed: a
superseded Pass may end before its probe ran, or after a Slice reported Usage. The `cancelled` Check
shows the aggregate like any other ending.

Supersession makes an `incomplete` aggregate common for anyone who pushes in quick succession, which
is a second reason for the Provider-route metering that stays in the map's fog.

## Handoffs

- [#134](https://github.com/nick-neely/reprove/issues/134), **blocking the Phase 1 exit**: on the
  fixture repository, whether the marker survives a create-and-list round trip in the raw body;
  whether an App is limited to one pending Review per pull request; whether an unknown *submit* is
  distinguishable as `PENDING` or submitted; and what a duplicate Check's create returns, so its
  stored ids can be reconciled. It amends §5 with what it proves.
- [#116](https://github.com/nick-neely/reprove/issues/116): the publication lease, the Review fence,
  `unresolved` and forced release, the sequence, the supersession columns, the cancel step and the
  Slice claim predicate land as handoff tickets. The deterministic scenario must include: H1 and H2
  publications interleaved under the lease; **an H1 Review POST with an unknown outcome followed by
  H2**, proving H2 holds and neither reconciles against nor skips past H1; a same-head manual re-run
  that publishes first, proving `overtaken`; a late `in_progress` against a `cancelled` conclusion;
  and a lost lifecycle wake, proving the Slice claim ends the Pass at the next Slice.
- [#115](https://github.com/nick-neely/reprove/issues/115): the lease duration, the lookup retry bound
  and the cancel step's timeout are measured windows.

## Consequences

- `run` gains `sequence`, `supersededAtHead`, `supersededOutcome` and `supersededTarget`.
- The publication row gains a Review outcome of `pending`, `unresolved`, `published`, `stale_head`,
  `overtaken`, `force_released` or `failed`, with a forced release's actor and accepted risk.
- A per-pull-request publication lease table with a fencing token exists.
- The lifecycle's `ended` branch gains a bounded cancel step ahead of ADR 0028's reap.
- ADR 0021 §7's Slice claim gains the `executing` predicate.
- A Review POST that times out can hold a pull request's later Reviews until an operator acts. That
  is accepted over a stale Review or a wrong baseline.
