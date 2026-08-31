# GitHub ingress, and what makes a Run unique

[ADR 0007](0007-run-result-and-finding.md) fixed the Run's three parts and stated that
"nothing in `spec` references a webhook delivery," and
[ADR 0008](0008-persistence-tenancy-and-retention.md) fixed the tenant boundary and named
the webhook as one of the two entry points that carries an Owner locator before any query.
Neither decided how a GitHub event becomes a Run.
[Fix GitHub App ingress and Run-creation idempotency](https://github.com/nick-neely/reprove/issues/36)
decides that: the App's authority, which deliveries act, and the invariants that make
retries, redeliveries and reordered deliveries incapable of producing a duplicate or a
mutable Run.

Two verified facts from the [GitHub ingress research](../research/github-ingress.md) drive
most of what follows, and both invert the obvious design:

- **GitHub does not automatically redeliver a failed webhook.** Redelivery is manual, from
  the App's delivery UI or the deliveries API, and only within three days. The risk this
  system must engineer against is therefore *silent permanent loss*, not duplicate work.
- **A GitHub App has exactly one webhook URL and one secret**, and must respond within ten
  seconds. Vercel's function limits are far above that, so GitHub's wall is the binding one.

## The App requests only what Phase 0 uses

```text
Metadata: read          mandatory for every App
Pull requests: read     gates delivery of the pull_request event
```

That is the complete grant. `Contents: read`, `Pull requests: write` and `Checks: write` are
**not** pre-declared.

GitHub creates a genuine asymmetry that tempts the opposite choice: adding a *permission*
later requires every existing installation to approve it, and the App keeps operating under
the old grant until they do, whereas adding an *event subscription* later is free once the
gating permission is held. The reason the asymmetry does not apply is that Phase 0 has no
third-party installations, so the migration cost is currently zero and will be paid exactly
once, deliberately, before Phase 1 launches. Pre-declaring write authority buys nothing today
and costs an install consent screen that overstates what the App can do, on a product whose
central claim is credential minimalism.

Nothing in GitHub's contract forces the write permissions into the read grant, so the
exclusion is a real choice rather than an accepted constraint.

### One explicit subscription, three unconditional arrivals

The App subscribes to exactly `pull_request`. GitHub additionally delivers `installation`,
`installation_repositories` and `github_app_authorization` to every App by default, and
**they cannot be subscribed to or unsubscribed from**. The handler therefore switches
explicitly on event type and ignores what it does not handle; it may not assume that an
unsubscribed event never arrives.

`issue_comment` and `pull_request_review_comment` stay unsubscribed: the research places
conversational follow-up at Phase 2, and `@chat-adapter/github` routes neither `pull_request`
nor a line-anchored Review, so it is not part of ingress at any phase.

## No Check in Phase 0, because no Refusal is reachable

`CONTEXT.md` requires every Refusal to be visible on a Check rather than a log line, which
looks like it forces `Checks: write` into the grant above. It does not. A control-plane
Refusal arises from configuration that is invalid or cannot be resolved, and Phase 0 Runs are
built from fixed inputs with no repository configuration; a Worker-side Refusal needs a
Worker. Nothing in Phase 0 can refuse.

The Check therefore lands with the first phase that can actually produce a Refusal, and must
land *at the same time* as it. Adding it now would be a smoke-test feature rather than
something the settled model requires. This is recorded because its absence would otherwise
read as an oversight against `CONTEXT.md`.

## Durability comes before the acknowledgement

Because GitHub will not retry, a `200` returned before anything is persisted is the one
genuinely unrecoverable outcome in the system. The handler therefore runs:

```text
verify HMAC-SHA256 over the raw bytes
  -> normalize a bounded ingress envelope
  -> commit it with its processing state
  -> return 200
  -> kick asynchronous processing
```

**The envelope is bounded and normalized, never the raw body.** For a `pull_request`
delivery it carries only durable locator and trigger facts - Owner, Installation and
Repository ids, the repository locator, pull request number, event, action, delivery GUID,
`receivedAt` - because the pull request's actual state is fetched canonically later. For a
lifecycle event it carries the bounded ids needed to represent the removal. Persisting the
raw body was rejected: it would durably duplicate pull request narrative and other
repository-derived content, creating a retention surface
[ADR 0008](0008-persistence-tenancy-and-retention.md) would then have to govern, for facts
that are re-fetched anyway.

Recording only the delivery GUID and a state was also rejected. It proves that *something*
arrived without preserving enough to reconstruct what, which is not durability.

**Failure to commit the envelope returns a non-2xx, on purpose.** This is the counterintuitive
half of the decision. A non-2xx buys the only recovery GitHub offers: the delivery is recorded
as failed in the App's delivery UI and stays manually redeliverable for three days. Once the
envelope is committed, a failed asynchronous kick still returns `200`, because Reprove now
holds the intent and the ledger is what recovers it.

### The delivery GUID is a wake-up signal, not a uniqueness key

`X-GitHub-Delivery` identifies the logical delivery and **is reused on manual redelivery**, so
a bare unique constraint on it would swallow the recovery attempt and defeat the only
mechanism GitHub provides. The rule is stateful instead:

```text
same GUID + terminal ledger state      -> duplicate, no-op
same GUID + nonterminal ledger state   -> resume or re-kick processing,
                                          never launch a second concurrent processor
```

The GUID never reaches the Run. ADR 0007's boundary holds: nothing in `spec` references a
delivery.

## Which deliveries act

| `pull_request` action | effect |
| --- | --- |
| `opened` | create a Run, if not draft |
| `synchronize` | supersede the live Run and create one at the canonical head, if not draft |
| `reopened` | create if not draft and no Run exists at that head |
| `ready_for_review` | create if no Run exists at that head |
| `closed` | cancel the live Run; create none |
| `converted_to_draft` | cancel the live Run; create none |
| everything else | inert |

Draft pull requests are skipped by default, which is what makes `ready_for_review` a trigger
and `converted_to_draft` a cancellation.

**`edited` is inert deliberately.** [ADR 0012](0012-author-controlled-narrative-input.md)
classifies the title and description as Author-controlled narrative, and letting an edit
re-trigger would hand the Author an unlimited free re-roll of the review at no cost.

That inertness carries a requirement forward rather than discharging one: **the narrative a
Run reviews must be fixed when the Run is created or resolved, never fetched opportunistically
later.** Otherwise `edited` is inert only at the trigger layer while the Author can still
steer a Run that already exists. Phase 0 supplies no narrative to anything, so this is
recorded as an inherited constraint rather than solved here.

## `baseSha` is the base branch tip; the merge base is derived where `.git` already is

```text
baseSha        base branch tip at Run creation
headSha        the pull request head commit
mergeBaseSha   derived from the Git object graph, not stored at creation
```

`baseSha` is not overloaded to mean the merge base. GitHub's own pull request diff is
three-dot, so a review diffed two-dot against the tip would produce Findings about code the
Author never touched - but computing the merge base at ingress means calling the compare
endpoint, which drags `Contents: read` into the grant above and puts a network call inside
GitHub's ten-second wall.

[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) already keeps `.git` in the
Workspace precisely so that `git diff`, `git log`, `git blame` and merge-base work. Given a
pinned base tip and a pinned head, the merge base is deterministic and computed there. The
drift objection against storing the tip does not apply: a push to the base branch fires no
`pull_request` event, so a Run's base never moves after creation, and the recorded tip is an
honest statement of what the base branch was when the event was processed.

## The canonical fetch, inside a per-pull-request critical section

**The webhook payload is not the authority for the state a Run is built from.** After durable
receipt, Run creation resolves `GET /repos/{owner}/{repo}/pulls/{number}` under installation
authority - which the already-required `Pull requests: read` covers - and reads the current
head SHA, base SHA, open/closed state and draft state from that response.

This is what makes delivery ordering stop being load-bearing: an old redelivery cannot move a
pull request backwards, a reordered `synchronize` cannot resurrect an old head, a stale
`closed` cannot cancel a Run for a pull request that has since reopened, and a permanently
lost intermediate `synchronize` does not matter because the next delivery observes the same
current state.

Fetching canonical state at the top of the asynchronous job is **not** sufficient, and the
residual interleaving is why:

```text
T0  delivery A (H2) resolves canonical -> sees H2
T1  a push lands; the head becomes H3
T2  delivery B (H3) resolves canonical -> sees H3, creates Run(H3)
T3  delivery A commits -> supersedes H3 and creates Run(H2)
```

"One live Run" holds at every step and the wrong head wins. SHAs carry no ordering, so nothing
in the data marks A as stale.

**The fetch therefore happens inside the serialized critical section:**

```text
begin withOwner transaction
  -> pg_try_advisory_xact_lock(repositoryId, pullRequestNumber)
  -> fetch canonical pull request state while holding the lock
  -> inspect existing Runs
  -> no-op / cancel / supersede / create
commit
```

An older processor cannot overwrite a newer one merely because its GitHub read happened
earlier: whichever acquires the lock second re-reads current state and observes the newer
head. The guarantee is stated narrowly and honestly:

> Processed deliveries are serialized per pull request, and every Run-creation decision uses
> canonical GitHub state fetched inside that serialized critical section.

It does not prevent GitHub's state changing immediately after the fetch, and it does not
recover a permanently lost delivery. It closes Reprove's own reordering and interleaving race
without depending on clock agreement across serverless instances, which was the rejected
alternative: stamping each Run with a resolution instant trades a small race for a silent,
asymmetric failure mode.

### Bounding a transaction that holds a network call

This pins a pooled connection across a GitHub request, and
[ADR 0008](0008-persistence-tenancy-and-retention.md) rule 3 already requires a real
interactive-transaction driver, so these are scarce connections. Both hazards are bounded, and
they need different mechanisms:

- **Contention:** `pg_try_advisory_xact_lock`, the *try* variant. On contention the attempt
  aborts immediately and the delivery stays `received` with `retryClass = contended`. A
  serverless invocation must never queue behind a lock whose holder it cannot observe.
- **A hung fetch:** a hard GitHub client timeout, backstopped by a transaction-local
  `idle_in_transaction_session_timeout`, with the client timeout set lower so application code
  normally aborts cleanly before Postgres kills the session. `statement_timeout` is the wrong
  tool and is named here so it is not reached for: it bounds a running query, and the hazard is
  an open transaction with no query running.

Both exits land in the same place, which is the point - abandoning a contended or hung attempt
costs nothing, because the envelope is already durable.

## What makes a Run unique

Two layers, and neither is sufficient alone.

**In Postgres**, at most one live Run per pull request:

```sql
UNIQUE (repository_id, pull_request_number)
  WHERE status IN ('queued', 'claimed', 'executing')
```

Superseding the old Run and inserting its replacement happen in the same `withOwner`
transaction. The obvious index - unique on `(repository, pull_request, head_sha)` - was
rejected because ADR 0007 states that "a new push **or a retry** produces a new Run," and that
index forbids the retry. The partial index is defense in depth against duplicate live Runs; it
is **not** the ordering primitive, which is the advisory lock above.

**In the application**, an automatic trigger whose canonical head already has *any* Run for
that pull request is a no-op. Any status, with no carve-outs:

```text
queued  claimed  executing  completed  incomplete
failed  superseded  cancelled  unscheduled
```

A status allowlist would place retry policy inside ingress, where it cannot see budgets,
quotas or repeated failure, and would quietly turn webhook redelivery into a retry mechanism.
`unscheduled` is the tempting exception, since nothing ever executed - but "never dispatched"
is a scheduling outcome and belongs to whatever owns `claimableUntil`.

Two consequences follow and are documented rather than hidden: a `failed` Run at a head is not
automatically retried, and a pull request reviewed at H3, then closed or drafted, then
reopened at the same H3, does not get a second Run. Retrying a head is an explicit manual act
or a later scheduler policy.

`Run.spec` gains `trigger: automatic | manual`. It records why a same-SHA Run legitimately
exists more than once and stays deliberately that narrow - no event names, no delivery ids -
so ADR 0007's boundary is preserved.

## Provenance is computed from canonical state

```text
internal  iff  head.repo.id is present
          and  head.repo.id === base.repo.id
          and  author_association in { OWNER, MEMBER, COLLABORATOR }
external  otherwise
```

Computed from the canonical response fetched inside the critical section, so it is fresh
rather than event-stale. Repository **numeric ids**, never names, so a rename cannot flip a
classification. `head.repo == null` - a deleted fork - is `external`, as are `CONTRIBUTOR`,
`FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER` and `NONE`.

`provenanceBasis` persists the inputs rather than prose reconstructed later:

```text
ruleVersion, baseRepositoryId, headRepositoryId,
authorAssociation, authorId,
matchedSameRepository, matchedAssociation
```

The live collaborator-permission endpoint, which
[ADR 0008](0008-persistence-tenancy-and-retention.md) already establishes needs only
`Metadata: read`, would additionally distinguish a read-only collaborator from one who can
push. It is not used, and that is an **accepted consequence rather than a gap**: `CONTEXT.md`
says collaborator, not write-capable collaborator, and Provenance classifies risk rather than
conferring safety. If Provenance should later mean "could push the head branch," that is a new
`ruleVersion`, and old Runs stay explainable - which is the entire reason ADR 0007 kept the
field.

## Repository scope is an operational cache

A verified `pull_request` payload proves the repository was in scope **when GitHub emitted the
delivery**, not that it remains in scope when Reprove processes a redelivery. So identity and
scope separate:

```text
verified payload
  -> may upsert Owner / Installation / Repository identity facts

canonical fetch under installation authority succeeds
  -> establishes inScope, permits Run creation

canonical fetch fails conclusively
  -> not in scope; create none, cancel where appropriate
```

No path may require that `installation.created` or `installation_repositories.added` arrived
first. Because GitHub never auto-redelivers, making a lifecycle event the source of truth for a
tenant existing means one dropped delivery permanently orphans an Owner. Creation is inferable
from any payload and is therefore never entrusted to a single delivery.

**Removal is not trusted blindly either**, and the symmetry matters: a repository can be
removed, re-added, acquire a legitimate Run, and only then receive the stale
`installation_repositories.removed`. So a lifecycle removal takes the *same per-pull-request
critical section* for each affected live Run and revalidates against current GitHub state,
preserving the Run when the grant is in fact still live. Recording scope conservatively for a
repository with no live Run is harmless, because scope grants no authority; the next
work-producing event re-establishes it canonically.

> Repository scope state is an operational cache. Current GitHub authorization is
> authoritative whenever scope would permit or terminate execution.

Lifecycle events therefore make revocation *prompt* rather than waiting for the next pull
request event. That is a liveness property. Correctness comes from the canonical fetch failing.

## Ledger dispositions, and re-drive as an exit condition

The ingress ledger holds `received`, `done` and `discarded`, with structured processing
metadata on `received`. None of these is `Refusal` or `Failure` vocabulary: nothing was refused
and nothing executed. They are ingress machinery before execution.

```text
canonical state ineligible - closed, draft   -> discarded: ineligible
a Run already exists at the canonical head   -> discarded: duplicate_head
grant definitively gone                      -> discarded: grant_gone
Run created                                  -> done
```

**Retryability is classified by typed cause, never by HTTP status.** Writing "all 401/403
retry with backoff" produces an invisible loop, because
`403 Resource not accessible by integration`, a missing permission, a revoked grant and a
misconfigured App are all permanent:

```text
network failure, 5xx, 429, identified secondary rate limiting
  -> received, retryClass = transient, bounded backoff

grant confirmed gone
  -> discarded: grant_gone

auth or App configuration cannot currently establish access
  -> received, retryClass = operator_attention, no blind tight retry

lock contention
  -> received, retryClass = contended
```

The `operator_attention` class is recoverable precisely because the durable envelope still
exists.

**Every nonterminal `received` disposition caused by `contended` or `transient` must have an
automatic re-drive path, and that is a Phase 0 exit condition rather than deferred work.**
Without it, this sequence loses a review permanently:

```text
the H2 processor holds the lock
the H3 delivery arrives, finds contention, leaves received
the H2 processor creates Run(H2) and exits
```

The final Run is H2 although H3's envelope exists. Durable receipt that only a human can
recover is not durability. This ADR fixes the requirement and the retry metadata -
`retryClass`, `attemptCount`, `lastAttemptAt`, `nextAttemptAt` - and
[#38](https://github.com/nick-neely/reprove/issues/38) chooses the mechanism. A general
periodic sweeper may still be deferred; *some* automatic recovery may not.

## The Run is complete at creation

Ingress derives only GitHub facts: Owner, Installation, Repository, pull request number,
`baseSha`, `headSha`, `provenance`, `provenanceBasis`, `trigger`. Everything else in ADR 0007's
immutable `spec` comes from one explicitly named injected profile:

```text
Phase0RunProfile
  harness, model, strategy, autonomy
  placement, allowHostedFallback
  a real bounded normalized fixed config, and its canonical digest
  a claimable-deadline policy
```

```text
canonical GitHub state + Phase0RunProfile + creation timestamp
  -> complete immutable Run.spec
```

These are **Phase 0 fixture values, not Reprove product defaults.** A webhook handler
containing `harness = codex` inline would silently convert prototype wiring into product
selection policy, and Phase 1's configuration work would inherit a default it never agreed to.

No field is left null or filled in later. `claimableUntil` lives in immutable `spec`, so it is
written at creation from the profile's policy;
[#38](https://github.com/nick-neely/reprove/issues/38) decides the concrete Phase 0 duration
that policy supplies. `resolvedConfig` is a real bounded config with an honest digest computed
from it, not a placeholder, so the prototype exercises the true Run shape.

## Consequences

- The App registration is created with `Metadata: read` and `Pull requests: read` only. A
  single deliberate permission migration to the Phase 1 write set is now a known, scheduled
  event rather than a surprise.
- The ingress ledger needs a table and an RLS policy, and `Phase0RunProfile`'s config must
  persist. Both land on
  [#37](https://github.com/nick-neely/reprove/issues/37).
- [#38](https://github.com/nick-neely/reprove/issues/38) inherits three things: the mechanism
  that kicks durable receipt into out-of-band processing, the mandatory automatic re-drive for
  `contended` and `transient` dispositions, and the Phase 0 claimable-deadline value.
- `Run.spec` gains `trigger` and `provenanceBasis.ruleVersion`. `mergeBaseSha` is explicitly
  *not* a creation-time field.
- The ingress ledger gains **no `CONTEXT.md` noun**. It is infrastructure, and ADR 0007's
  "nothing in `spec` references a webhook delivery" is the boundary that keeps it out of the
  model. `trigger` and `mergeBaseSha` are spec fields rather than new vocabulary, and
  `Installation` already carries "may be removed and re-added," so `CONTEXT.md` is unchanged
  by this decision - deliberately, not by omission.
- The requirement that a Run's narrative input be fixed at creation is handed forward to
  whichever phase first supplies narrative to a Reviewer.
- Implementation notes that follow from the above rather than being decided by it: verify the
  signature against the exact received bytes and never a re-serialized parse; use a
  timing-safe comparison; reject an unsigned or oversized body before hashing it.
