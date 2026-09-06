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
Reports are never edited or removed. A baseline moves only through a passing
promotion, a requalification under new corpus or scoring versions, or an
explicit rebase that records the comparison chain breaking.

An exception file has this shape, and every field is required:

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
