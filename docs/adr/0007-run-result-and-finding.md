# Run, Result and Finding

[#2](https://github.com/nick-neely/reprove/issues/2) named these three and left their shapes
open. [ADR 0002](0002-severity-verification-and-no-confidence.md) fixed what a Finding
carries about its own standing, [ADR 0005](0005-adapter-boundary.md) fixed what an Adapter
yields and handed the per-Pass bundle's naming here, and
[ADR 0006](0006-worker-protocol.md) fixed what crosses the Worker boundary and handed here
the requirement that `Result` have a transportable non-complete form. This ADR decides the
shapes themselves, and the reconciliation rules PRD §32 left `[Undecided]`.

The shapes were built as zod schemas first, in
[the Run, Result and Finding prototype](https://github.com/nick-neely/reprove/tree/47a31e23c9368ba2acab18adab17de06aa2e83e3/prototypes/13-run-result-finding), because
concrete types are far easier to argue with than prose. Several decisions below exist
because running the prototype exposed something the ticket had not anticipated. The
throwaway source is preserved on branch `prototype/13-run-result-finding`, outside main;
the link above pins the original source commit.

## Run

**A Run is three parts, not one bag**, so "stable identity versus mutable state" lives in the
type rather than in a comment:

- **`spec`** - fixed at creation, never rewritten. Owner, Repository, Installation, pull
  request number, base and head SHA, the computed `Provenance` **and its basis**, the pinned
  `harness` / `model` / `strategy` / `autonomy`, the Worker `placement`, the
  hosted-fallback opt-in, a digest of the base-ref configuration this Run resolved, and
  `claimableUntil`.
- **`resolution`** - written once at claim, immutable thereafter: `workerId` (null for a
  hosted Worker, which holds no durable identity), `route`, `isolation`, `exposure`,
  `protocolVersion`, `workerBuildVersion`.
- **`state`** - the only mutable part: status, `executionToken` and `executionExpiresAt`,
  accumulated Refusals, failure reason and its structured detail, timestamps, the accepted
  Result and the Review record.

[ADR 0015](0015-execution-ownership-and-worker-liveness.md) amends this: `state` carried
"lease expiry", which was false for a hosted Worker, since ADR 0006 gives it no Lease.
`executionExpiresAt` is the placement-neutral liveness boundary both placements have, and a
Lease is what a self-hosted Worker holds to advance it. `failed` gained structured detail -
detector, observation, and whether the Run was lost from `claimed` or `executing` - so that
one `worker_lost` reason serves both placements without parallel reason codes.

`provenanceBasis` is kept because a classification that cannot be explained six months later
is not auditable. `configDigest` is kept so that editing the configuration file cannot
rewrite what a past Run ran under.

**Nothing in `spec` references a webhook delivery.** That is what makes PRD §17's
independence claim true rather than aspirational: everything after Run creation reads
denormalized pull-request facts, never the ingress that produced them.

**`Route` is recorded as an immutable audit fact.** ADR 0005 kept Route out of the Adapter's
public identity and ADR 0004 moved dispatch gating off it, and neither is reopened here:
nothing branches, gates or routes on the stored field. But without it, "why was `Exposure`
`account` on this Run?" is unanswerable after the fact, which is the same reason ADR 0006
already requires `isolation` and `exposure` on the Run. A Run stores what actually executed
rather than reconstructing it from today's architecture, because those relationships will
change and the audit record must not silently change with them.

### Status

`queued` -> `claimed` -> `executing`, terminating in one of:

| status | meaning |
| --- | --- |
| `completed` | a **complete** Result was accepted |
| `incomplete` | a **partial** Result was accepted - acceptable, therefore not a Failure |
| `failed` | execution began and produced no acceptable Result |
| `superseded` | a newer Run exists for this pull request |
| `cancelled` | cancelled by the control plane or the user |
| `unscheduled` | `claimableUntil` expired; never dispatched. Carries the accumulated Refusals |

**`incomplete` is a distinct terminal status rather than a flag inside the Result.** Because
the Check reports execution (below), the Run's own status is what the Check reads; folding
partial into `completed` would force the Check, the dashboard, telemetry and #14's retention
rules each to reach through into `result.completeness` to learn the operational outcome, and
would collapse three genuinely different endings - no Result at all (`worker_lost`), a
partial one, a complete one - into two statuses. `Result.completeness` still exists, because
it describes what the Worker returned; the status describes the outcome after acceptance.
**Why** it became incomplete stays in `stoppedBy` rather than multiplying statuses.

**`unscheduled` is not Reprove `Failure` vocabulary.** `CONTEXT.md` defines Failure as
occurring after execution begins, and nothing executed. It projects to a `failure` Check
conclusion, which is a GitHub word and not ours.

## The Check reports execution, not verdict

| Run status | Check conclusion |
| --- | --- |
| `completed` | `success` - whether or not Findings were made |
| `incomplete` + budget exhaustion | `timed_out` |
| `incomplete` + cancellation | `cancelled` |
| `failed`, `unscheduled` | `failure` |
| `superseded`, `cancelled` | `cancelled` |

Findings move the **Review**; execution moves the **Check**.

The rejected alternative was `neutral` for every incomplete Run, on the argument that ADR
0002 chose `COMMENT` over `REQUEST_CHANGES` so a first install cannot block a team's merges.
That reasoning is about the *verdict* and does not transfer to the *execution* axis. A
repository that deliberately marks the Reprove Check required is saying "do not merge until
Reprove successfully completes," and returning `neutral` on a timeout would quietly void that
choice - reporting Reprove's own failure as though nothing had happened. Reprove being
non-blocking about defects by default is not a licence to disguise an unfinished run.

If a repository later wants Findings above some Severity to gate merging, that is an explicit
policy that changes this mapping deliberately.

## Result

**One schema with a `completeness` discriminator**, not a `Result` plus a `PartialResult`.
ADR 0006 makes acceptance one code path on purpose - "one schema, one validation, one
dedupe" - and a parallel type forks it. `stoppedBy` is required exactly when `completeness`
is `partial` and forbidden otherwise, so the two cannot drift apart.

**A partial Result with zero Findings publishes no Review.** ADR 0005 already refuses to let
a malformed Pass become an empty Result, because "empty means review completed with no
Findings and malformed means review failed." A budget-exhausted Run that found nothing is
that same confusion one level up: publishing it asserts a clean bill of health the Reviewer
never gave. A partial Result **with** Findings does publish them - they are useful - marked
unmistakably as incomplete, and the Check stays non-successful either way. The existence of
useful Findings must not make an unfinished review look finished.

The payload is strictly size-bounded and an oversized submission is rejected rather than
truncated into shape, per ADR 0006. The bound is what makes "no bulk data crosses"
enforceable at the edge instead of resting on Worker good behaviour; the exact byte figure is
implementation policy and may be versioned.

**`Result` has no table.** `CONTEXT.md` defines it as what crosses the Worker boundary rather
than something that outlives the crossing: it is absorbed into the Run on acceptance.

## Finding

Exactly one location, per #2. Line numbers are meaningful only against the `headSha` the Run
carries.

**A Finding does not chase a moving line, which is the force-push answer.** It is bound to
the head SHA it was made at; recognising "the same Finding" happens *across* Runs, never by
re-anchoring within one. A force-push that makes the old head unreachable is then GitHub's
concern for the already-posted Comment, and nothing Reprove has to model.

**`anchoredText` - a tightly bounded excerpt of the source the claim points at - crosses the
worker protocol**, and the control plane owns canonicalization and bucketing. The alternative
was shipping only a Worker-computed hash, which is smaller but freezes the algorithm at
whichever build each Worker happens to be running, on software ADR 0006 says "will lag the
control plane by months" - and it can never be improved or migrated for existing history. The
justification is *not* that a Comment quotes the code anyway; recurring, suppressed and
out-of-diff Findings may never produce a Comment at all. It is that the control plane already
holds `contents: read`, and this bounded excerpt is what makes reconciliation centrally
evolvable. It is counted inside the Result size budget, which is why the bound is tight.

**Evidence is two types and they are not collapsed.** The Reviewer's `ClaimedEvidence` is
attacker-controlled output from inside the Sandbox. `Evidence` is what survives
reconciliation against the Adapter's observed tool-calls, Worker-side, and only that crosses -
carrying `truncated` and `originalByteLength`, because ADR 0006 forbids raw stdout leaving.

Schema-enforced: **no Evidence, no `verified`** (ADR 0002), and `static` cannot carry Evidence
either, because reasoned-only means reasoned-only. A `Patch` is rejected at acceptance under
any Autonomy but `fix`.

## Reconciliation is Comment dedupe, not Finding identity

This is the sharpest correction in the ticket, and everything below follows from it.

**The bucket key is `path + normalized anchored-source hash`.** Line numbers move on any
unrelated edit above them, so keying on them reports every Finding as new after any push; a
model-written title is the least stable field a Finding has; a Reviewer-emitted stable id and
an LLM reconciliation Pass both put the guarantee inside the nondeterministic thing.
**Severity is deliberately excluded**: the same defect rated `high` on one Run and `medium`
on the next must not become a different Finding.

**But the same anchor does not mean the same Finding.** Two distinct defects can point at one
line, and a defect can be fixed elsewhere while its anchored line is untouched. The
one-location rule is an anchoring and presentation constraint, not proof the whole defect
lives in that text. So the key produces a **candidate bucket**, and matching inside it is
conservative.

**Matching is cardinality-only.** Exactly one prior and exactly one current Finding in a
bucket matches as `recurring`. Every other cardinality - `0:n`, `n:0`, `1:n`, `n:1`, `n:m` -
makes each current Finding `new`.

The asymmetry decides it: a wrong `new` costs a duplicate Comment, while a wrong `recurring`
suppresses a Comment about a real defect. Exact normalized-title equality was rejected because
it fails in the common direction - the model rewords a title and every Finding re-posts, and
comment spam is the top complaint about review bots. A title-similarity threshold was rejected
as a magic number that gets re-tuned by whoever last saw a duplicate and that no one can
falsify. If experience later shows the residual 1:1 swap matters, another **deterministic**
discriminator can be added; title similarity must not become foundational.

The residual case - defect A on Run 1, defect B on Run 2, one anchor, nothing changed - has a
bounded blast radius, and this is why the framing matters: **dedupe suppresses a `Comment`,
never a `Finding`.** The current Finding still exists, is still in Run history, and is still
represented in the Review summary and counts.

**The prior side is internal and never claims a fix.** Two values:

- `anchor_changed` - the prior anchored text is no longer present at that path at the new
  head;
- `not_reproduced` - the anchor still exists and no current Finding matched it. An ambiguous
  bucket lands here too, because unmatched is unmatched and naming *why* the matcher failed
  would put its internals on the product surface.

Neither may become user-facing prose. `anchor_changed` proves the claim's anchor is stale; it
does **not** prove the defect was fixed, because code moves and a rewrite can preserve a bug.
Having been this conservative on the current side, it would be incoherent to make a stronger
claim on the prior side. If the product ever wants to tell an author "resolved", that needs
evidence the underlying claim no longer holds - which is a different and larger thing than an
anchor disappearing. This satisfies PRD §32's reconciliation requirement without manufacturing
progress.

Anchor checks are batched: **one fetch per distinct affected file at the new head**,
reconciling every prior anchor in it locally. Never one fetch per Finding.

## Findings outside the diff

A Reviewer reads the whole Workspace, so it can claim that a changed caller now breaks an
untouched callee - exactly the class of defect a whole-repo reviewer sees and a diff-only
reviewer structurally cannot. GitHub cannot line-anchor a review comment on a file the diff
never touched.

Such a Finding **renders as a structured entry in the Review body** under its own heading,
carrying `path:line`, Severity and Verification, and passes through the same Threshold and
dedupe rules as any other Finding. It is kept clear of the prose summary so it stays
actionable rather than buried narrative.

It is **not** a `Comment`, because `CONTEXT.md` defines a Comment as the line-anchored GitHub
projection of a Finding.

Rejected: anchoring to the nearest line that *is* in the diff (states a false location, and
location is the one thing #2 fixed to exactly one per Finding); refusing the Finding at
acceptance (discards the most valuable class of Finding this product exists to produce, and
silently rewards Reviewers that stay inside the diff); a separate issue comment (splits one
review across two surfaces and two notification streams).

## Publication is not a Run status

A Run's **execution state** and its **Review publication state** are orthogonal. A Run can
complete successfully while GitHub publication fails, retries, or happens later; and ADR
0002 requires that changing a Threshold never costs a Run, which means re-projecting stored
Findings must not move the Run backwards through its states.

`CONTEXT.md`'s rule stands: **a Run publishes at most one *logical* Review**, and a retry
targets that same one rather than creating a second.

The persisted shape - pending and failed publication attempts, `appliedThreshold` and
`suppressedFindingCount` (without which "why wasn't this Finding posted?" is unanswerable
later), and what happens when a Threshold changes after GitHub has already accepted a Review -
is handed to [#14](https://github.com/nick-neely/reprove/issues/14).

## `Artifact` is not a domain noun

Deleted. ADR 0006 removed artifact upload from the worker protocol, which left the word
describing nothing concrete: no self-hosted producer, no transport, no defined product
consumer, no settled retention semantics. Keeping it because hosted execution might one day
retain something is backwards, and #14 cannot decide retention for a thing whose definition
is "possibly some files."

It comes out of PRD §36's entity list (on [#17](https://github.com/nick-neely/reprove/issues/17)'s
sweep) and out of #14's assumed entities. If hosted execution later needs durable transcripts,
logs or recordings, that thing gets named for what it actually is, then. Reintroducing a
glossary entry is cheap.

## The per-Pass bundle stays unnamed

ADR 0005 handed the naming here. **The decision is to decline**, and that is a decision rather
than an omission: the bundle remains an Adapter-internal implementation type and does not
enter `CONTEXT.md` until multi-Pass Strategy composition gives it independent domain meaning.

Strategy composition is out of this map's scope and only `standard` exists, so today the
relationship is `1 Pass -> 1 internal bundle -> 1 Result` and the distinction has no referent
on any surface. This is the same test that just deleted `Artifact`, applied consistently.
`PassResult` would additionally re-open the Job/Run/Result stutter #2 closed. An internal
TypeScript name such as `AdapterPassOutput` is fine and does not become vocabulary.

## Serialization boundary

**zod and Drizzle are separate, and each is authoritative for its own boundary.** zod owns
accepted domain and wire shapes and their cross-field invariants; Drizzle owns the persisted
relational shape, its nullability and its indexes; an explicit mapping connects them, and
conformance tests make drift visible. Neither generates the other.

`drizzle-zod` would project table shape - nullable columns, database defaults - onto a wire
contract that needs refinements a table cannot express; "no Evidence, no `verified`" is a
cross-field rule, not a column constraint. Generating in the other direction would let a wire
concern dictate physical storage. And the non-isomorphism is not a matter of taste:
**`Result` has no table at all.**

## Consequences

- `CONTEXT.md` gains the complete/partial distinction on `Result`, and an explicit statement
  on `Comment` that a Finding GitHub cannot line-anchor is not projected as one.
- **PRD §11, §17, §27, §28, §29 and §32 are resolved**, including §27's and §32's
  `[Undecided]` markers and §28's `PARTIALLY_VERIFIED`, which ADR 0002 had already replaced.
  PRD §36 loses `ReviewArtifact`. Edits land on
  [#17](https://github.com/nick-neely/reprove/issues/17).
- **[#14](https://github.com/nick-neely/reprove/issues/14) inherits** the publication record's
  persisted shape, the prior-side reconciliation record it must store across Runs, and an
  entity list with `Artifact` removed.
- The control plane performs one file fetch per distinct affected file at publish time, to
  resolve prior anchors.
- Repository configuration gains nothing here; Threshold and the Check mapping were already
  its keys.
- ADR 0005's per-Pass naming handoff is discharged by declining it, and the per-phase map that
  builds a multi-Pass Strategy inherits the naming question with the reason it was deferred.
