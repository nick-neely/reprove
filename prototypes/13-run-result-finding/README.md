# Prototype: Run, Result, Finding (#13)

**Throwaway.** Not shipped code, not a package, not wired into anything. It exists so the
shapes can be argued about concretely. It is committed as the primary source behind #13's
resolution.

```bash
cd prototypes/13-run-result-finding
npm install && npm start
```

- `schema.ts` - the proposed shapes as zod schemas, plus the acceptance and reconciliation
  functions that carry the rules a schema cannot express.
- `scenarios.ts` - drives the cases that are hard to reason about on paper and prints what
  the shapes actually do.

## What the shapes propose

**A Run is three parts, not one bag.** `spec` is fixed at creation and never rewritten;
`resolution` is filled once at claim (`workerId`, `route`, `isolation`, `exposure`,
`protocolVersion`, `workerBuildVersion` - the audit fields ADR 0006 requires); `state` is the
only mutable part. The ticket asked which fields are identity and which are state, and this
answers it in the type rather than in a comment. Nothing in `spec` references a webhook
delivery, which is what makes PRD §17's independence claim true rather than aspirational.

**Result is one schema with a `completeness` discriminator**, not a `Result` plus a
`PartialResult`. ADR 0006 makes acceptance one code path deliberately - one schema, one
validation, one dedupe - and a second type forks it. `partial` requires `stoppedBy` and
`complete` forbids it, so the two cannot drift apart.

**Findings key on anchored source, not on line numbers.** A line number moves on any
unrelated edit above it, so keying on it reports every Finding as new after any push. A
model-written title is not stable across two Runs of the same Reviewer. The anchored source
is the thing the claim is *about*: if it changed, the claim is stale by definition and
re-asserting it is correct. This is also the force-push answer - a Finding does not chase a
moving line, it is bound to the `headSha` it was made at, and matching happens across Runs
rather than within one.

**Evidence is two types, not one.** The Reviewer's `ClaimedEvidence` is attacker-controlled
output from inside the Sandbox; `Evidence` is what survives reconciliation against the
Adapter's observed tool-calls, Worker-side. Only the second crosses the protocol, and it
carries `truncated` + `originalByteLength` because ADR 0006 forbids bulk stdout crossing.

**Result has no Drizzle table.** `CONTEXT.md` defines it as "what crosses the Worker
boundary, not something that outlives the crossing" - it is absorbed into the Run on
acceptance. That is why the zod and Drizzle schemas are separate with a mapping layer rather
than one generated from the other: they are provably non-isomorphic. See fork 5.

## Open forks - these need a decision, not a schema

### 1. Does a partial Result with zero Findings publish anything?

The prototype says **no review, and a failing Check**. ADR 0005 already refuses to let a
malformed Pass become an empty Result, because "empty means review completed with no
Findings and malformed means review failed." A budget-exhausted Run that found nothing is
the same confusion one level up: publishing it asserts a clean bill of health the Reviewer
never gave.

The cost: a Run that times out at 95% produces nothing visible except a red Check.

### 2. `not_reproduced` - does the fourth disposition earn its place?

The prototype distinguishes a Finding that vanished after its anchored region changed
(`resolved`) from one that vanished with nothing touched (`not_reproduced`). An agentic
Reviewer is nondeterministic, so a Finding disappearing is not evidence it was fixed, and
collapsing the two silently reports flakiness as progress.

The cost: a fourth state to surface, and `not_reproduced` is an admission of nondeterminism
printed on the product surface.

### 3. Does `anchoredText` cross the worker protocol?

The prototype ships a bounded (2KB) source excerpt so the **control plane** computes the
fingerprint. The alternative is the Worker computing it and shipping only a hash - less data
crosses, but the algorithm can then never change without shipping every self-hosted Worker a
new build, on software ADR 0006 says "will lag the control plane by months."

A Comment quotes this code anyway, so the excerpt is inside what already crosses.

### 4. Is `Artifact` a domain noun at all?

ADR 0006 deleted artifact upload from the worker protocol and left `Artifact` as a possible
hosted-only persistence concept for #14. The prototype **does not define it**. It currently
has no producer in the self-hosted path, no consumer on the product surface, and no
retention policy. The alternative is to keep it narrowly as a hosted transcript record.

### 5. zod-first, Drizzle-first, or separate with a mapping layer?

The prototype assumes **separate**, zod authoritative for the wire and domain, Drizzle
written by hand, one conformance test between them. `drizzle-zod` would mirror table shape
(nullable columns, DB defaults) onto a wire contract that needs refinements a table cannot
express - "no Evidence, no verified" is a cross-field rule, not a constraint. And `Result`
has no table at all, so the two schemas cannot be generated from each other.

### 6. Publication as a record, not a Run status

The prototype models the GitHub Review as a nullable record on the Run rather than a
`published` status, so re-publishing a stored Result under a changed Threshold does not have
to move the Run backwards through its states. ADR 0002 requires that a Threshold change never
costs a Run; this is what makes that mechanically true.

### 7. Does `Route` belong on the Run?

ADR 0005 keeps Route out of the Adapter's public identity. The prototype still records it on
`RunResolution`, because without it "why was `Exposure` `account` on this Run?" is
unanswerable after the fact. This may be re-litigating a settled boundary, or it may be the
distinction between a registry key and an audit field.
