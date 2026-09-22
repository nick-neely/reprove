# A Run appears as an index, a set of Comments and one Check that carries the ledger

[ADR 0007](0007-run-result-and-finding.md) fixed what a Run, a Result and a Finding are, mapped Run
status onto a Check conclusion, and left the surface itself in prose: a Finding outside the diff
"renders as a structured entry in the Review body", a Review has a "prose summary", and the
publication record's persisted shape went to a later ticket.
[ADR 0011](0011-repository-configuration-contract.md) §8 created a second Check and said "how it
publishes belongs to #111". [ADR 0019](0019-phase-1-repository-configuration-subset.md) §4 gave a
control-plane Refusal its own record with "Check publication identity and state" unspecified, §6 said
what the `Reprove config` Check reports and not how, and §7 required Usage and estimated cost "on the
Check". [ADR 0022](0022-manual-review-request.md) handed over the whole unverified re-run half, and
[ADR 0023](0023-worker-refusal-over-a-dispatched-run.md) §7 added a refused Run's probe spend to the
same Check. [Prototype the Review, Comments and Check a Run
publishes](https://github.com/nick-neely/reprove/issues/111) settles all of it for Phase 1.

The decisions were made against real GitHub-flavored markdown rather than against prose. The
[publication prototype](https://github.com/nick-neely/reprove/tree/prototype/111-publication/packages/control-plane/prototype-111-publication)
renders thirteen scenarios - a first review, an empty review, an unfinished one, a budget stop, a
deadline Failure, a Worker Refusal, a control-plane Refusal, no Worker, a second Run, three no-op
re-runs, and both `Reprove config` outcomes - into postable Review bodies, Comments and Check
payloads, and asserts GitHub's documented limits on each. It is the primary source for everything
below. Four variants were built; **variant D is the settled shape**, and the two facts it rests on
come from the [GitHub write-surface research](../research/github-write-surface.md): a review comment
must land inside a diff hunk, and a Check Run annotation has **no diff-membership requirement** and
anchors at any `path:line`.

## 1. The shape is an index, not prose

**No surface Reprove publishes carries a prose paragraph.** Every artifact is a verdict line, a
table, a labelled line, or a collapsed block.

The **Review body** is, in order:

1. **One bold verdict line.** Severity counts first, then only the non-zero parts of *commented*,
   *outside the diff*, *carried over* and *not published*. A zero part is absent rather than printed
   as zero.
2. **An index table of every Finding that met the Threshold** - Severity, Verification, the location
   linking to that Finding's own Comment, and the one-line title. One row per Finding, including the
   out-of-diff ones (§2) and the carried-over ones (§3).
3. **A "No longer reported" count** with a collapsed list, on a second Run only (§3).
4. **Short labelled lines** for the Reviewer's `unfinished` and for each Limitation, by kind.
5. **A `<sub>` footer** naming the Run id, the head SHA, the applied Threshold, and pointing at the
   Checks tab for the terminal facts and the full ledger.

The Review `event` is unchanged, and ADR 0007 is not reopened on it.

A **Comment** is three parts: a header line carrying Severity, Verification and the title; one or two
lines of consequence; and the Evidence collapsed inside `<details>` with the command, exit code,
duration and truncation in the summary.

The **Check** splits along what it is read for. `title` carries the verdict, or for a Run that
published nothing, the terminal reason in words. `summary` is the same verdict line plus **one facts
table**: harness, model, autonomy and deadline each with their `configured`/`default` provenance,
duration, token Usage with its completeness, the estimated USD cost under the named pricing revision,
the Lineage's qualification status, and Provider drift. `text` is the **full ledger**: every Finding
the Run made, below-Threshold and suppressed ones included, each with its `publicationDisposition`
and its reconciliation bucket.

**The emoji set is closed and exhaustive**:

| mark | means |
| --- | --- |
| 🟥 🟧 🟨 ⬜ | Severity `critical`, `high`, `medium`, `low` |
| ✅ | `verified` |
| ❌ | `inconclusive` |

**`static` carries no mark**, because a check and a cross would each imply an execution that never
happened, and Verification's third value is precisely the absence of one. **No Check conclusion
carries a mark either**: the title text says what happened and GitHub draws its own status icon, and
`timed_out` and `cancelled` are genuinely neither a check nor a cross. There is no warning sign and
nothing decorative. Anything outside the table above is not Reprove content.

Rejected: **a prose-first Review** (prototype variant B, built and deleted). A narrative blob cannot
be glance-parsed, which is the only thing a reviewer does with it on the way to the diff; and prose
is where a rendering quietly invents a value the product does not hold. Variant A, terse fields with
no index, and variant C, a pure ledger with no verdict, are kept in the prototype only so D can be
read against the two it was composed from.

## 2. A Finding outside the diff is a Check Run annotation

This **amends ADR 0007**, which said such a Finding renders as a structured entry in the Review body
under its own heading. The research settles the reason: an annotation takes any `path`, `start_line`
and `end_line` with no diff-membership requirement anywhere in the schema or the documentation, it
renders in the Checks tab at the exact line, and it costs nothing Phase 1 does not already hold.

**So the exact line lives where GitHub can actually point at it**, and the Review body stays a
complete index: the out-of-diff Finding still gets an index row, marked "outside the diff" and
linking to the Checks tab instead of to a Comment, and the verdict line counts it. The Review remains
one surface listing every published Finding; only the anchor moves.

It is still **not** a Comment: `CONTEXT.md` defines a Comment as the line-anchored GitHub projection
of a Finding, and it keeps `annotation` on its *Avoid* line. An annotation is a Check output field,
not a second name for a Comment - it is not a thread, cannot be replied to or resolved, and raises no
review notification, which is why it was rejected for in-diff Findings and is right for these.

The disposition value follows: **`publicationDisposition: review_body` is renamed
`check_annotation`**, amending ADR 0011 §7's enumeration. Leaving the old name would make the ledger
column say the one thing that is no longer true.

Rejected again, and for ADR 0007's own reasons: anchoring to the nearest in-diff line, refusing the
Finding at acceptance, and a separate issue comment.

## 3. Reconciliation is visible as three lines, and never as its own internals

ADR 0007's bucketing is cardinality-only and is not reopened. What a second Run shows:

| bucket | Comment | Review body |
| --- | --- | --- |
| `recurring` | suppressed | an index row whose location links the **prior** Comment, marked "still open from the previous review" |
| `new` | published | an ordinary index row |
| prior side, unmatched | none | counted as "No longer reported", with a collapsed list of path and title |

**A recurring Finding keeps its row.** Suppressing the Comment and the row together would make the
second Review claim the defect is gone, which is exactly the clean-bill-of-health failure ADR 0007
refused one level up. Dedupe suppresses a Comment, never a Finding, and the index is the Finding's
surface.

**The prior-side reasons are never user-facing.** `anchor_changed` and `not_reproduced` stay
internal, per ADR 0007: an anchor disappearing does not prove a defect was fixed, and naming which
way the matcher failed would put its internals on the product surface. "No longer reported" is the
strongest honest claim, and it is deliberately not "resolved" or "fixed".

## 4. A visible no-op re-run says so in the Check title

ADR 0022 §5 required the stale-head and closed cases to be visible and left the mechanics here. The
constraint is that a rerequest re-asserts the conclusion the Check already carried, so **the colour
cannot carry the reason**. The title can:

```text
Re-run ignored: head is stale
Re-run ignored: pull request is closed
Re-run ignored: an equivalent review is already running
```

The conclusion is re-asserted unchanged, and the `summary`'s first line explains what did not happen
and names the next step - reopen the pull request, re-run at the current head, or wait for the live
Run to finish. The third case covers ADR 0022 §5's equivalent-live-Run row, which needed a surface as
much as the other two.

**The accepted cost is that this is visible only in the Checks tab.** That is where the requester
already is: they pressed the button GitHub rendered there. A timeline comment was rejected as noise -
it would notify everybody watching the pull request to say that nothing happened, and a no-op is the
one outcome that must not cost a notification.

## 5. `publication` is one row per published Check, over three record kinds

Today's `publication` table is one row per Run, keyed by `runId` with a unique constraint, and its
`githubReviewId` is the handle. That cannot hold a Refusal Check, which has no Run, or a
`Reprove config` Check, which has no Run either, and it cannot satisfy ADR 0022 §3's requirement that
**every** published Check carry an `external_id` and the suite id it landed in.

**One row per published Check.** Every row carries the Check Run id, the check suite id and the
`external_id`; **`github_review_id` becomes nullable**, because several Runs publish a Check and no
Review at all: a partial Result with no Findings (ADR 0007), a Failure, a refused Run, and a Run no
Worker ever claimed.

The row's subject is one of exactly three record kinds, and the `external_id` names which:

| subject | `external_id` | Check |
| --- | --- | --- |
| Run | `reprove.run.<id>` | `Reprove` |
| Refusal record (ADR 0019 §4) | `reprove.refusal.<id>` | `Reprove` |
| **config validation record**, new | `reprove.config.<id>` | `Reprove config` |

The config validation record is Owner-scoped like every tenant row under
[ADR 0008](0008-persistence-tenancy-and-retention.md), and holds repository, pull request number,
`headSha`, the outcome, and either the resolved values or the error. It exists because ADR 0022 §7
makes the `Reprove config` Check independently re-runnable: a re-run must validate against a durable
record that says which pull request and which head the Check was published for, and it must have one
durable retry target when publication itself fails.

This is what satisfies ADR 0022 §3 and §7 rather than restating them: the referenced record is what
the pull request number is recovered from, the stored Check Run id is what a `rerequested` payload is
validated against, and the stored suite id is what a suite re-run's routing set is bound by.

Rejected: **a stateless config Check that encodes the pull request and the SHA in its `external_id`**
and holds no row. It fails ADR 0022 §3's validation, which requires a record that is rightly owned
before any work, and it has nothing to retry a failed publication against - which is the failure ADR
0022 §1 said durable publication retry must recover from on its own.

## 6. Requested-versus-effective names the Reprove boundary, and only it

ADR 0019 §6 requires the `Reprove config` Check to report a narrowed `security:` value as "requested
X, effective Y". Phase 1 has no Owner layer, so **the comparison is against the Reprove boundary
only, and is labelled as such**:

```text
security.maxExposure   requested `account`, effective `scoped` (Reprove boundary)
```

Naming the boundary rather than leaving the narrowing anonymous is the point, and it is consistent
with ADR 0019 §4's insistence that a Refusal name the requirement that failed. It also keeps the row
extensible in the one direction it will grow: when an Owner Ceiling exists, it adds a term to the same
row rather than changing its shape. An unlabelled "effective Y" would have to be rewritten then, and
in the meantime it tells a reader that something narrowed their value without telling them what.

Narrowing is not a Refusal, per `CONTEXT.md`: it moves toward the safe position. The Check reports it
as a fact, and reports success.

## 7. Small rulings

- **Run status `claimed` renders as Check status `queued`.** Nothing is executing yet, and
  `in_progress` would claim otherwise. `executing` is `in_progress`, which ADR 0023 §3 has the hosted
  pass write as its own first step.
- **A Refusal's next step names the key path, and a line number only when the loader recorded one.**
  The `refusal` record therefore gains an **optional line**. Guessing a line would point a reader at
  the wrong one, and omitting the path entirely would make "fix your configuration" unactionable.
- **Below-Threshold Findings are a count in the Review and rows in the Check ledger.** The Review
  states how many and under which Threshold, so a reader knows the Reviewer said more than was shown;
  the ledger answers "why wasn't this Finding posted?", which ADR 0007 handed to the publication
  record.
- **Provider drift and the Lineage's qualification status are Check facts, not Review content.** Both
  are operational facts about the execution, and [ADR 0018](0018-adversarial-qualification-gate.md)
  makes Drift a property of a Lineage rather than of any Run - putting either in the Review would read
  as a qualifier on the Findings.
- **A complete review's `static` Findings are told apart from an unfinished one's** by two things at
  once: the labelled `unfinished` line in the Review body, and the Check conclusion `failure` that
  [ADR 0020](0020-reviewer-method-under-verify.md) §5 requires for `reviewer_stopped`. Neither
  alone is enough, because a complete review may legitimately be all `static`, and an unfinished one
  may have verified everything it did reach.

## 8. Handoff: what the schema and the protocol still lack

Stated rather than hidden, exactly as ADR 0022 §6 did with the same table. The surfaces above are
written against the Phase 1 shapes those ADRs specified, not against today's code, and they land with
them:

- **`run`** has no columns for `deadline`, `budget`, the pricing revision, or the
  configured-or-default value provenance sidecar, all of which §1's facts table renders
  (`packages/control-plane/src/db/schema.ts`).
- **`resultSchema`** has no `unfinished`, no `limitations` and no `reviewer_stopped`, which ADR 0020
  §5 and ADR 0007's #107 amendment specify and §1 and §7 render.
- **The `refusal` record** has no optional line (§7).
- **The `publicationDisposition` enum** still says `review_body` (§2).
- **The config validation record and its `publication` row** do not exist, and `publication` is still
  one row per Run with a non-nullable subject and no Check or suite identity (§5).

## 9. Pending observation

The prototype is markdown, so it cannot answer what only a live App can. These are the facts this
ADR still needs, to be filled in from a scratch GitHub App before the ticket closes, and each is
inherited directly from ADR 0022's consequences:

- whether re-asserting a conclusion actually settles the check suite, including while another Check in
  that suite is still running;
- how two Checks of the same name at one SHA display, and whether an App's Checks at one head share
  one suite;
- that "Re-run all checks" does deliver `check_suite.rerequested`, which the research only inferred;
- config-only versus combined suite routing, per ADR 0022 §7;
- two pull requests sharing one SHA, each represented and each getting at most one request.

None of them changes a decision above; each of them can change an implementation detail, and none may
be assumed.

## Consequences

- **ADR 0007 is amended** on Findings outside the diff: they are Check Run annotations, and the Review
  body carries an index row rather than a structured entry under its own heading. Its "prose summary"
  wording goes with it, since no surface has prose. The amendment lands below that ADR.
- **ADR 0011 §7 is amended**: the publication disposition enumeration reads
  `inline_comment | check_annotation | suppressed_threshold | suppressed_dedupe | suppressed_ignore`.
  Its §8 handoff of how the `Reprove config` Check publishes is discharged by §5 and §6.
- **`CONTEXT.md`'s `Comment` entry is corrected**: a Finding GitHub cannot line-anchor renders as a
  Check Run annotation at its exact line and as an index row in the Review body, not "structurally in
  the Review body". `annotation` stays on the *Avoid* line, because the word still must not be used
  for a Comment. No new noun: a config validation record is a record, and the Check it publishes is a
  Check.
- **ADR 0019's handoffs are discharged**: §4's "Check publication identity and state" is §5's row,
  §6's "how it publishes" is §5 and §6, and §7's Usage and estimated cost are two rows of §1's facts
  table.
- **ADR 0022's publication half is discharged except for §9's list.** `external_id` and the stored
  suite id are on every publication, Refusal and config Checks included; the three no-op re-run shapes
  have a surface; durable publication retry has one target per Check.
- **ADR 0023 §7's aggregate Usage and its completeness** are rendered on the Check for a refused Run,
  a Failure and a completed Run alike, and a refused Run's probe spend is visible rather than implied.
- The schema, the protocol and the enum changes of §8 land with the work that needs them; none is made
  here.
- The prototype is deleted with its branch. Nothing in it is production code, and no abstraction in it
  survives.
