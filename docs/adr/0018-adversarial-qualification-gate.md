# The adversarial qualification gate

[ADR 0012](0012-author-controlled-narrative-input.md) separated two suites: deterministic contract
tests that prove security invariants and are release-blocking, and adversarial behavioral
evaluations that qualify review integrity and never establish a boundary. It deliberately fixed no
corpus, scoring or threshold "before the system exists".
[Set the Phase 0 adversarial evaluation gate](https://github.com/nick-neely/reprove/issues/34) fixed
them, and [Qualify a Codex revision through the adversarial gate](https://github.com/nick-neely/reprove/issues/53)
built the result. This record is the decision; #34 holds the discussion that produced it.

## Decision

**Qualification is a property of one exact Revision.** A lineage is Harness, Route, Provider,
pinned Model, Autonomy and Strategy; a revision is the lineage plus the Harness artifact fingerprint,
the Adapter build, the Reviewer policy digest and the narrative schema version, all read from the
revision's own built packages. Phase 0 qualifies one Lineage: Codex, brokered, OpenAI, `gpt-5.6-sol`,
`verify`, `standard`. A Provider-reported resolved Model is metadata, never identity.

**The corpus is versioned content, not a fixture folder.** Twelve paired families, six varying the
narrative and six the Workspace, eight defective and four clean, each with four conditions that
change one input at a time; expectations are machine-checkable and Finding identity is a defect id
plus location. The loader enforces every one of those rules, and `corpusVersion` digests fixtures,
expectations and axis applicability together. A condition that forbids other Findings forbids them
absolutely: what a Reviewer may also say is what its declared ambiguity allows, and no severity is
exempt.

**Judgement is family-clustered with an absolute floor and a non-inferiority test.** Four axes,
each with its own floor and margin, a one-sided 90% family-clustered bootstrap with 10,000 resamples
under a seed derived from the evaluation identity, and a three-way outcome per test. No weighted
aggregate rescues a failed axis, and scores never become a product confidence signal.

**Baselines are rerun, never remembered.** A baseline is a pointer to one exact revision that is
checked out, built and executed beside the candidate in one randomized, interleaved batch of fixed
size. Historical Result JSON cannot establish non-inferiority. When the corpus or scoring version
changes, the baseline is requalified under the new versions before anything is compared to it.

**Exceptions are non-ratcheting.** An exception accepts only a non-inferiority `FAIL` or
`INCONCLUSIVE`, requires every absolute floor to have passed, binds one revision under one pair of
versions, expires within thirty days, and does not move the baseline. Because its review trigger is
prose no machine reads, a maintainer records that the trigger fired, or that the exception was
withdrawn, as an instant in the exception file through a pull request; from that instant it stops
applying. Rebasing to a regressed revision is a separate explicit action that records the
comparison chain breaking, and it waives the non-inferiority tests alone: the fixed budget, valid
evidence and every absolute floor still hold.

**Provider drift is a visible signal and never a runtime Refusal.** A lineage is current, stale,
failed or invalid according to its newest decisive result; a non-current lineage blocks promotion
and keeps one issue open, and no Run is refused because of it. `CONTEXT.md`'s Refusal is a decision
made before execution about a requirement that was not met; a Provider changing underneath Reprove
is an operational fact about the lineage, not a property of any Run.

**Only evidence about the standing revision decides the lineage.** A first qualification and a
requalification evaluate the lineage's own revision, so both count whatever they concluded. A
promotion comparison judges a candidate; it counts only when the ledger promoted it - it passed
every test off a lineage that was current when it ran, and the ledger moved the baseline onto its
candidate rather than refusing the comparison or accepting a shortfall through an exception -
because only then did its candidate become the standing revision having cleared every floor. Every
comparison is recorded whatever was decided, so each report carries that decision and a report
written before the decision existed is not evidence. A clean comparison drawn against a failed or
stale baseline, or against one the ledger has since superseded, cannot restore the lineage, and
promotion stays blocked until a requalification does.

**An inconclusive scheduled result decides nothing, and the clock keeps running.** #34 makes the
newest scheduled result authoritative without saying what an `INCONCLUSIVE` one authorizes, so this
repository decided it here: an inconclusive requalification neither refreshes nor breaks currency,
the newest *decisive* result stays authoritative, and the thirty-day clock still runs from the last
`PASS`. A lineage whose last `PASS` is older than thirty days is stale however many inconclusive
results followed. The alternative - letting an inconclusive result hold a green state open - would
let a Provider that has become unmeasurable keep authorizing promotions indefinitely.

**The gate runs on demand.** Ordinary pull requests receive no Provider credential and run the
corpus, scorer, evaluator and contract tests. The paid evaluation is dispatched by hand from a
protected commit, behind a protected environment's manual approval, and its outcome is recorded as a
commit status on the SHA it qualified. The compact report is durable through the ledger; transcripts
and diagnostics are not.

## Placement

The gate lives in `tools/gate/` at the repository root, beside the other verification tooling, and
not in a workspace. [ADR 0010](0010-package-graph-and-open-core-boundary.md) as amended by issue #29
keeps tooling at the root and the workspace set fixed; the gate ships to no consumer, and giving it a
package would put an evaluation harness into the published graph. It loads each revision's packages
by file URL from that revision's own build, which is also what lets two revisions with different
pins run in one process.

## Consequences

- `pnpm verify` gains the corpus, scoring, evaluator, batch and ledger tests, and one Docker-backed
  test that drives two trials through the real path against a fixture Provider. It does not gain a
  paid step.
- A `qualify` workflow and a `qualification` environment exist. The environment holds the only
  Provider credential the repository's automation ever sees, and only the workflow's `run` jobs
  can read it.
- The instruction probe's five-minute validity, designed for a Worker that dispatches one Run, is
  met in the gate by re-probing every four minutes. Each re-probe is a Provider turn; the cost is
  accepted rather than the window widened.
- `CONTEXT.md` gains a **Qualification** section: Lineage, Revision, Corpus, Baseline, Exception,
  Trial, Axis and Drift. They are nouns of the gate and its ledger, and none of them is a runtime state.
