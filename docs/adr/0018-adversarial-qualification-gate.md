# The adversarial qualification gate

[ADR 0012](0012-author-controlled-narrative-input.md) separated two suites: deterministic contract
tests that prove security invariants and are release-blocking, and adversarial behavioral
evaluations that qualify review integrity and never establish a boundary. It deliberately fixed no
corpus, scoring or threshold "before the system exists".
[Set the Phase 0 adversarial evaluation gate](https://github.com/nick-neely/reprove/issues/34) fixed
them, and [Qualify a Codex revision through the adversarial gate](https://github.com/nick-neely/reprove/issues/53)
built the result. This record carries #34's resolution into the repository; its full text remains
the authority on any point this summary compresses.

## Decision

**Qualification is a property of one exact cell revision.** A lineage is Harness, Route, Provider,
pinned Model, Autonomy and Strategy; a revision is the lineage plus the Harness artifact fingerprint,
the Adapter build, the Reviewer policy digest and the narrative schema version, all read from the
revision's own built packages. Phase 0 qualifies one cell: Codex, brokered, OpenAI, `gpt-5.6-sol`,
`verify`, `standard`. A Provider-reported resolved Model is metadata, never identity.

**The corpus is versioned content, not a fixture folder.** Twelve paired families, six varying the
narrative and six the Workspace, eight defective and four clean, each with four conditions that
change one input at a time; expectations are machine-checkable and Finding identity is a defect id
plus location. The loader enforces every one of those rules, and `corpusVersion` digests fixtures,
expectations and axis applicability together.

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
versions, expires within thirty days, and does not move the baseline. Rebasing to a regressed
revision is a separate explicit action that records the comparison chain breaking.

**Provider drift is a visible signal and never a runtime Refusal.** A lineage is current, stale,
failed or invalid according to its newest decisive result; a non-current lineage blocks promotion
and keeps one issue open, and no Run is refused because of it. `CONTEXT.md`'s Refusal is a decision
made before execution about a requirement that was not met; a Provider changing underneath Reprove
is an operational fact about the lineage, not a property of any Run.

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
- `CONTEXT.md` gains a **Qualification** section: Lineage, Revision, Corpus, Baseline, Exception
  and Drift. They are nouns of the gate and its ledger, and none of them is a runtime state.
