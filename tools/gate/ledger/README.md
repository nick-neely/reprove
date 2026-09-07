# Qualification ledger

The durable record of every adversarial-gate evaluation, one directory per
qualification lineage. `tools/gate/qualify.mjs` reads it to find the standing
baseline and to decide promotion, and `pnpm verify` never touches it.

```text
<lineage-slug>/
  baseline.json            the standing baseline: one exact revision
  reports/<when>-<rev>.json  compact durable reports, appended only
  exceptions/<id>.json     promotion exceptions, each bound to one revision
```

A report lands here through a pull request after the on-demand workflow
uploaded it as an artifact and recorded the outcome on the commit it
qualified; see [docs/adversarial-gate.md](../../../docs/adversarial-gate.md).
Reports are never edited or removed, including the ones the ledger refused to
promote: each carries in `decision` what was decided on it, and a promotion
comparison counts as evidence about the lineage only when that decision
promoted it outright. A baseline moves only through a passing
promotion, a requalification under new corpus or scoring versions, or an
explicit rebase that records the comparison chain breaking.

An exception file has this shape. Every field is required except `revokedAt`
and `triggerFiredAt`, which an older file may omit; an omitted one reads as
`null`.

```json
{
  "id": "2026-09-20-intent-use",
  "lineageId": "codex/brokered/openai/gpt-5.6-sol/verify/standard",
  "revisionId": "<candidate revisionId from the report>",
  "baselineRevisionId": "<baseline revisionId from the report>",
  "corpusVersion": "<from the report>",
  "scoringVersion": "<from the report>",
  "grantedAt": "2026-09-20T10:00:00.000Z",
  "expiresAt": null,
  "revokedAt": null,
  "triggerFiredAt": null,
  "reviewTrigger": "the intent prompt rewrite in #123 lands",
  "acceptedAxes": ["intent-use"],
  "reason": "known regression on intent use, tracked in #123"
}
```

An exception accepts only a non-inferiority `FAIL` or `INCONCLUSIVE` on the
axes it names, in an evaluation where every absolute floor passed. It expires
thirty days after `grantedAt` at the latest, or earlier at `expiresAt`, and it
stops applying the moment the candidate revision, the baseline, the corpus
version or the scoring version changes. Granting one never moves the baseline.

## Ending an exception early

`reviewTrigger` is prose, so no machine can see it happen. When it does, a
maintainer opens a pull request that sets `triggerFiredAt` in the exception
file to the instant it happened, in the same ISO form as `grantedAt`. From
that instant the exception no longer applies, and a candidate that relied on
it is refused until the shortfall is fixed or a new exception is granted for
the new revision.

`revokedAt` does the same for a withdrawal for any other reason: the exception
was granted in error, the regression turned out to be worse than it looked, or
the work it was waiting on was abandoned. Set exactly one of the two, to the
reason that actually ended it, and leave the file otherwise untouched: like a
report, an exception records what was decided and when.
