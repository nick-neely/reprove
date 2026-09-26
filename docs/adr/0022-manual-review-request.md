# A review is requested by hand through GitHub's own Check re-run

[ADR 0013](0013-github-ingress-and-run-creation-idempotency.md) fixed which deliveries act, gave
`Run.spec` a `trigger` of `automatic | manual`, and then created no `manual` Run anywhere: it left
"an explicit manual act" as the named escape from the any-status no-op without saying what the act
is. [ADR 0019](0019-phase-1-repository-configuration-subset.md) leaned on the same unbuilt path
twice, making manual retry the only recovery after a deployment-only change and stating that a
manual request always re-evaluates. [Decide how a review is requested by
hand](https://github.com/nick-neely/reprove/issues/108) settles it for Phase 1: the surface, what a
request is validated against, what it produces beside a live Run, and what it is allowed to review.

Two verified facts from the [GitHub write-surface research](../research/github-write-surface.md)
shape the whole decision. `Checks: write` **auto-subscribes** the App to `check_run` and
`check_suite`, so the manual surface arrives with the permission Phase 1 already needs and costs no
further grant. And `check_run.pull_requests[]` is **not** a usable handle: GitHub's own description
says the array "do[es] not necessarily indicate pull requests that triggered the check", and for a
fork pull request, the majority case for an open-source reviewer, it is empty.

## 1. The Check re-run is the whole manual surface

```text
check_run.rerequested      the "Re-run" button on one Reprove Check
check_suite.rerequested    "Re-run all checks"
```

Nothing else. No trigger label, no review request to the App, no comment command, no
Reprove-authenticated API route, no CLI. Every other `check_run` and `check_suite` action, including
`check_suite.requested` that arrives on every push, is **inert**.

The reason is that the re-run is already authenticated, by GitHub, and already gated on repository
write access. Every alternative asks Reprove to build an authorization model it does not otherwise
need:

- **An API route or a CLI** needs a user-to-repository authorization model. Nothing else in Phase 1
  has one: [ADR 0008](0008-persistence-tenancy-and-retention.md)'s two entry points are the webhook
  and a User whose visibility derives from GitHub, and neither answers "may this person spend this
  Owner's Provider budget on this pull request". A route is the largest new security surface the
  phase could adopt, for a button GitHub already renders.
- **A label** is applicable by triage-level users, who are not the write-access population, and it
  needs cleanup semantics: whether the label is removed, whether re-applying it re-triggers, and
  what a stale label means on the next push. The research also observed duplicate `labeled`
  deliveries live, four for two labels on one pull request.
- **A comment command** needs `issue_comment`, which ADR 0013 keeps unsubscribed until Phase 2 and
  which costs `Issues: read`, a grant over **every** issue in the repository.
- **A review request to the App** is real in GraphQL but the research could verify neither the
  webhook delivery nor third-party support; it is promising and not buildable.

The grant therefore stays exactly what [#112](https://github.com/nick-neely/reprove/issues/112) was
already going to migrate to. `Checks: write` is a consumer of nothing new.

**The accepted cost is that a pull request with no Reprove Check has no manual surface.** A draft
that was never reviewed has no Check to re-run, and neither does a pull request opened before the
App was installed, which [#103](https://github.com/nick-neely/reprove/issues/103) already defers.
The supporting invariant is that this set stays as small as ADR 0019 already requires: **every Run
outcome and every control-plane Refusal publishes a Check**, the Refusal Check included, with
publication handed to [#111](https://github.com/nick-neely/reprove/issues/111).

**A Check that was never published is not recovered by a second human surface**, and adding one
would be the wrong fix. Durable publication retry must recover on its own, with no further
`pull_request` event; a later trigger or a push is a fallback, never the reconciliation mechanism.
Proving that belongs to #111.

## 2. A manual request is a webhook delivery, and the ledger already governs it

A re-run arrives as a signed webhook delivery like any other, so it goes through ADR 0013's durable
ingress ledger unchanged:

```text
same GUID + terminal ledger state      -> duplicate, no-op
same GUID + nonterminal ledger state   -> resume, never a second concurrent processor
```

A redelivered re-run therefore cannot create a second Run after the first one finishes. Two distinct
clicks are two deliveries carrying two GUIDs, and they are two requests, which is intended: a
write-capable person asking twice asked twice. **No new mechanism is introduced**, and in particular
manual requests get no separate idempotency key, no second uniqueness axis on the Run, and no
bypass of the terminal-state precondition ADR 0013's #49 amendment established.

ADR 0019 §4 said a manual request from #108 "arrives with no delivery at all". That is wrong and is
amended below. Its conclusion is not affected: the Refusal record remains the durable home of a
Refusal's publication state for the reasons it gave, namely that the ledger row carries no head and
no publication state.

## 3. The handle is `external_id`, and unknown is not mismatched

**Every published Check carries an `external_id` that is an unambiguous reference to the record that
published it**, and it must distinguish the two kinds: a Run and a Refusal are different records and
a reference that could mean either is not a handle. `check_run.pull_requests[]` is never read, for
the reason quoted above. The pull request number is recovered from the referenced record.

A `check_run.rerequested` delivery validates all of the following before any work:

```text
check_run.app.id equals our App
the installation maps to an Owner
the referenced record belongs to that Owner and that repository
the record's stored Check Run id equals the payload's
```

The App filter is not optional hygiene: GitHub "sends all events for `created` check runs to every
app installed on a repository that has the necessary checks permissions", so an unfiltered handler
sees other Apps' Checks.

> **Amended by [#134](#amended-by-134):** the last line is replaced. The payload's `external_id`
> references the record, and its `check_suite.id` equals the publication's stored suite id. The Check
> Run id is not compared, because a re-run can name a duplicate Check that the publication owns.

A `check_suite.rerequested` delivery validates `check_suite.app.id`, and binds to stored
publications by the **exact suite id**: each publication stores the check suite id it landed in, and
the routing set is the publications carrying that id. Installation, repository and SHA together are
not a substitute, because they do not distinguish one suite from another at the same head.

**A positive mismatch discards with a named ledger reason.** Unknown is a different thing and must
not be collapsed into it: if the record exists and is rightly owned but its stored Check id, or
stored suite id, is still null because publication has not persisted yet, the delivery stays
**nonterminal** and ADR 0013's resume path retries it. Discarding there would lose a legitimate
request to a race the requester cannot see.

**Elapsed time is not evidence of mismatch.** A publication that stays unresolved sends the delivery
to ADR 0013's existing `operator_attention` retry class, which is recoverable precisely because the
envelope is durable. A time-based permanent discard is explicitly rejected: it converts a slow write
into a silently dropped request. For a suite event the same rule binds harder, because an
incompletely persisted publication that drops out of the routing set does so **silently**, leaving a
suite re-run that reviewed fewer pull requests than it represented.

Pull request state is never read from the payload. Head, base, open and draft all come from the
canonical fetch inside ADR 0013's per-pull-request critical section, exactly as every automatic
trigger reads them.

## 4. Authorization is GitHub's, and the actor is recorded as provenance

GitHub gates the re-run on repository write access and Reprove **adds no second authorization
check**. A fork author without write access cannot re-run, which is the correct outcome: they can
open a pull request and cannot spend the Owner's Provider budget on demand.

**The sender is not necessarily a human.** `POST /repos/{o}/{r}/check-runs/{id}/rerequest` accepts
an installation token, so another App can produce a `rerequested` delivery. That is not a hole,
because the token is itself write-scoped, but it means the actor may not be a person. The actual
actor is recorded as **requester provenance** on the Run or Refusal record:

```text
GitHub id, login, type (User | Bot)
```

It sits **outside `configDigest`** and **outside the equivalence comparison** of §6: who asked is an
audit fact, not part of what was reviewed, and two requests from different actors under the same
configuration are the same request as far as the review is concerned. Retention follows the existing
audit retention under [ADR 0008](0008-persistence-tenancy-and-retention.md); this adds no new
retention class. `CONTEXT.md` gains no **Requester** noun: provenance wording already covers it, and
a noun would imply the actor participates in the review, which it does not.

## 5. What a manual request does, in order

Inside ADR 0013's critical section, after the delivery validates:

1. **Canonical fetch.** The pull request's current state, as always.
2. **Closed pull request:** a visible no-op.
3. **The re-run Check's head is not the canonical head:** a visible no-op.
4. **Load base configuration** through the ordinary ADR 0019 loader, at the canonical `baseSha`, and
   evaluate it.
5. **Compare with any live Run** and act:

| Live Run | Evaluation yields | Result |
| --- | --- | --- |
| none | Run | create a `manual` Run, also when terminal Runs of any outcome, including a clean success, exist at that head |
| none | Refusal | record and publish the Refusal; no Run |
| none | `enabled: false` | ledger `discarded: disabled`; no Run and no Refusal row |
| same head, equivalent | Run | no-op; the live Run finishes, and a re-run after it ends creates a fresh Run |
| same head, not equivalent (the base moved, or resolved inputs changed) | Run | supersede, and create at the current base and configuration |
| any | Refusal | supersede, record and publish the Refusal; no successor |
| any | `enabled: false` | supersede per ADR 0019 §5, ledger `discarded: disabled`; no successor |
| different head from the canonical head | anything | supersede, then apply the outcome |

**The different-head row is reachable, not defensive.** A historical publication is re-runnable long
after its head moved, and a `synchronize` whose processing is delayed leaves a live Run at an older
head while the canonical head is newer. Saying so is the point: a reader who assumes the live Run is
always at the canonical head will write the wrong supersede condition.

**`enabled: false` stays distinct from a Refusal throughout.** It is a disabled ingress disposition
and never Refusal vocabulary, which is the distinction ADR 0013's dispositions and ADR 0019 §5
already draw. A manual request on a disabled repository is not refused, it is not acted on.

**This differs from the automatic rule on purpose.** For an automatic trigger, any Run at the head
in any status is a no-op, with no carve-outs, because ADR 0013 refused to let webhook redelivery
become a retry mechanism and refused `edited` as the Author's free re-roll. A re-run is neither: it
is an explicit act by somebody with write access, so a `failed` Run at the head, or a clean success
somebody wants re-examined under a fixed loader, is exactly what it is for. The rule ADR 0013 stated
as "an explicit manual act" is this.

**"Visible no-op" means the Check says so.** For both the stale-head and the closed cases, the old
Check's prior conclusion is re-asserted with a summary line explaining why nothing ran, naming the
current head in the stale case. Silence would leave a re-run button that appears to do nothing.

A correction that must not be lost in implementation: a rerequest resets the check **suite** to
`queued` and clears its conclusion; [the Check Run itself is not
updated](https://docs.github.com/en/rest/checks/runs#rerequest-a-check-run). Whether re-asserting a
conclusion actually settles the suite, including while another Check in it is still running, is
**unverified** and handed to #111.

## 6. Equivalence is a named comparison over resolved inputs

"Equivalent" in §5 is an explicit, named comparison, **not** a whole-spec equality and **not** a
deployment fingerprint. A whole-spec comparison makes every metadata field load-bearing by accident;
a fingerprint makes redeploys invalidate live Runs.

```text
compared    headSha, baseSha, provenance, placement, allowHostedFallback,
            harness, model, strategy, autonomy, configDigest,
            and the effective security policy after the meet, where Phase 1
            stores it outside resolvedConfig

excluded    runId, createdAt, claimableUntil, trigger,
            the configured-or-default value provenance sidecar,
            the pricing revision, requester provenance,
            draft status observed at creation
```

`configDigest` carries the resolved configuration, and ADR 0019 requires `deadline` inside it, so a
changed deadline is a changed digest and breaks equivalence without a column of its own.

**ADR 0019 already acknowledges that implementation and loader fixes no digest captures exist**, and
this comparison does not pretend otherwise: after such a fix, an equivalent live Run is left to
finish, and a re-run after it ends creates a fresh Run under the fix. That is the honest behaviour,
and it is why a deployment fingerprint was rejected rather than adopted: its completeness would
become correctness-critical, exactly as ADR 0019 said of a `policyRevision` in the suppression key.

**The test discipline is part of the decision.** Every Run field is explicitly classified as
compared or excluded, and an unclassified new field **fails the test**. Changing any compared value
breaks equivalence; changing any excluded metadata does not. Without the exhaustiveness half, a
field added later is silently excluded, which is the failure this comparison exists to prevent.

**The gap is stated rather than hidden:** today's `run` row has no `deadline`, `budget`, policy or
pricing-revision columns at all (`packages/control-plane/src/db/schema.ts`,
`packages/control-plane/src/worker/run-spec.ts`). The list above is written against ADR 0019's
Phase 1 Run shape, not against the current one, and lands with it.

## 7. Three re-run shapes, two operations

Config validation and review loading are **different operations against different refs**: the
prospective `Reprove config` Check validates the **head's** configuration (ADR 0019 §6), while
review execution loads the **base's** (ADR 0019 §3). Routing has to respect that.

| Re-run | What it does |
| --- | --- |
| the review Check | one manual request, per §5 |
| the `Reprove config` Check | revalidate the head's configuration and republish that Check. No Run is created or touched |
| the suite | routed explicitly to both operations, over the publications that suite recorded |

The `Reprove config` re-run is **not a review trigger** and is not one of ADR 0019 §5's eligible
triggers, so it never supersedes a live Run and never observes `enabled: false` into a
`discarded: disabled`. Treating it as a review trigger would make a validation button spend money.

A suite re-run is restricted to the pull requests represented by **that suite's** recorded
publications, bound by exact suite id. If the suite holds a config Check publication, revalidate. If
it holds any review publication, Run or Refusal, that is **one** manual request. At most one review
per represented pull request per suite request, never one per historical Check and never one per
attempt; two pull requests that share a SHA are each represented and each get at most one. **A
config-only suite never initiates a paid review.**

## 8. A manual request reviews a draft

The draft skip exists to avoid **unrequested** spend. A re-run is a request, so a manual request on a
draft pull request reviews it.

The exemption has to sit where the code actually decides, and today that is the canonical branch
rather than the action: `run-creation.ts` cancels the live Run on **any** locked delivery whose
canonical fetch shows the pull request not open or draft, regardless of which action named it. So:

> A canonical draft cancels the live Run **unless** all three hold: the Run's `trigger` is `manual`,
> draft was observed at the Run's creation, and the Run's head equals the canonical head. Closed
> always cancels.

The Run records **"draft status observed during creation"**, read from the canonical fetch. That is
the exact wording, and not "draft when the user clicked": the payload is never the authority, and a
pull request drafted between the click and the lock is a draft at creation.

The consequence is deliberate and is the safe half: **a manual Run started while the pull request was
ready is cancelled by a later conversion to draft.** Drafting still means stop. A person can then
re-run on the draft, which is the gesture that says otherwise.

A companion invariant, already true in the code and now stated and tested rather than inferred:

- **No action name cancels by itself.** A `closed` or `converted_to_draft` delivery on a pull request
  that is, at lock time, open and ready returns `unchanged`.
- **`synchronize` supersedes only a live Run whose head differs from the canonical head.**
  `endLiveRun` excludes rows already at the canonical head, because such a Run *is* the Run for that
  head.

Together those mean a stale `synchronize` or a stale `converted_to_draft` at the same head leaves a
manual draft review alone. A real push to a draft still supersedes and creates no successor, as
today.

## 9. Spend is not bounded across Runs, and saying so is the decision

Phase 1 has **no cross-Run spending bound**. `budget` is per Run and soft (ADR 0019 §7), and
repeated authorized spending by write-access actors is explicitly accepted: the Phase 1 deployment
is deploy-your-own, on the deployer's own Provider key, so the people who can re-run are the people
paying.

A per-head Run ceiling was considered and rejected on three counts. The number would be arbitrary.
It would block legitimate recovery after repeated Failures, which is the case manual retry exists
for. And it resets on every push, so it is not a spending ceiling at all.

If loop protection is ever needed, the named remedy is a **configurable cooldown**, and it is called
rate limiting rather than a budget. Neither it nor anything in this ADR establishes a total spending
bound. [#115](https://github.com/nick-neely/reprove/issues/115) owns only whether a single Run's
`budget` becomes a hard bound, which is a different question.

## Consequences

- ADR 0013's trigger table gains the two `rerequested` rows and the statement that every other
  `check_run` and `check_suite` action is inert; its subscription statement is qualified by the two
  events `Checks: write` brings; the canonical-draft exemption and the companion invariant of §8 are
  recorded there, where the table they qualify lives. ADR 0019's "arrives with no delivery at all"
  and "always re-evaluates and produces a fresh Refusal or a Run" are both corrected. Both amendments
  are below the respective ADRs.
- [#112](https://github.com/nick-neely/reprove/issues/112) inherits **nothing new**: no grant and no
  subscription beyond `Checks: write`, whose auto-subscription is the surface.
- [#111](https://github.com/nick-neely/reprove/issues/111) inherits the whole unverified half. It
  must test the real GitHub re-run interaction for success, Failure, Refusal, a stale head, a closed
  pull request and an already-live Run; whether re-asserting a conclusion settles the suite,
  including while another Check in it runs; whether an App's Checks at one head share one suite, and
  how same-name Checks at one SHA display; that "Re-run all checks" does deliver
  `check_suite.rerequested`, which the research only inferred; config-only versus combined suite routing; multiple pull
  requests sharing a SHA; historical attempts at one SHA; both the Check-id and the suite-id
  persistence races; durable publication retry recovering with no further pull request event; and
  `external_id` plus the stored suite id on **every** publication, Refusal Checks included.
- [#118](https://github.com/nick-neely/reprove/issues/118) inherits nothing from this ADR. Draft
  semantics for a manual Run are settled here, in ADR 0013's table, not there.
- The `run` and `refusal` records gain requester provenance, outside the digest and outside
  equivalence. No new retention class.
- `CONTEXT.md` gains no noun. The **Run** entry is sharpened so that a manual trigger is a person's
  or an actor's explicit request through the Check's re-run, and so that it is the one trigger that
  may review a draft pull request. **Requester** is deliberately not a term: the actor is provenance.

## Amended by [#110](https://github.com/nick-neely/reprove/issues/110)

[ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md) snapshots the pull request title
and body at Run creation and carries `narrativeDigest` on `RunSpec`, so §6's `compared` list gains
it:

```text
compared    headSha, baseSha, provenance, placement, allowHostedFallback,
            harness, model, strategy, autonomy, configDigest, narrativeDigest,
            and the effective security policy after the meet, where Phase 1
            stores it outside resolvedConfig
```

It sits outside `configDigest`, so without its own entry a re-run after the description was edited
would be equivalent to a live Run holding the old narrative and would no-op. Editing the narrative
changes what is reviewed, which is exactly what this comparison exists to notice.

## Amended by [#134](https://github.com/nick-neely/reprove/issues/134)

2026-09-26. Observed live on the fixture repository. A Check created twice at one head with the same
`external_id`, which is how [ADR 0029](0029-stopping-and-fencing-a-superseded-run.md) §5 recovers a
Check create whose outcome is unknown, produces two Check Run ids in **one** suite.
`check_run.rerequested` is delivered for either of them. That includes the older duplicate, which
`filter=latest` and the pull request page hide. And a late-committing first create can end up newer
than the id the record stored.

So §3's last condition for a `check_run.rerequested` delivery becomes:

```text
the payload's external_id references the record
the payload's check_suite.id equals the publication's stored suite id
```

The exact Check Run id is not compared. A stored suite id that is still null is unknown, not
mismatched, exactly as for a suite event. The App filter and the Owner and repository checks are
unchanged, and so is `check_suite.rerequested` binding. Every Check Run the publication owns is
concluded (ADR 0029, [amended by #134](0029-stopping-and-fencing-a-superseded-run.md#amended-by-134)
§3), so whichever duplicate the re-run named, the re-run reaches the same record.
