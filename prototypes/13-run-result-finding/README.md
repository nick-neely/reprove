# Prototype: Run, Result, Finding (#13)

**Throwaway.** Not shipped code, not a package, not wired into anything. It exists so the
shapes could be argued about concretely rather than in prose, and it is committed as the
primary source behind [#13](https://github.com/nick-neely/reprove/issues/13)'s resolution.

The decisions it encodes are recorded in
[ADR 0007](../../docs/adr/0007-run-result-and-finding.md). Where the two disagree, the ADR
wins.

```bash
cd prototypes/13-run-result-finding
npm install && npm start
```

- `schema.ts` - the shapes as zod schemas, plus the acceptance, reconciliation and
  projection functions that carry the rules a schema cannot express.
- `scenarios.ts` - drives the cases that were hard to reason about on paper and prints what
  the shapes actually do.

## What it demonstrates

Each scenario exists because it settled something.

1. **Run splits into `spec` / `resolution` / `state`** - identity, claim-time audit facts,
   and mutable state, visible in the type rather than asserted in a comment.
2. **No Evidence, no `verified`**, and `static` cannot carry Evidence either. Both are
   unreachable in the schema rather than checked downstream.
3. **An oversized Result is rejected, not truncated** - the bound is what makes ADR 0006's
   "no bulk data crosses" enforceable at the edge instead of resting on Worker good
   behaviour.
4. **The Check reports execution, not verdict.** A complete Run is `success` whether or not
   it found defects. A partial Run stays non-successful so a repository that marks the Check
   required still gets what it asked for, and a partial Result with zero Findings publishes
   no Review at all.
5. **Reconciliation is Comment dedupe, not Finding identity.** Cardinality-only matching
   inside a `path + anchor hash` bucket; an ambiguous bucket fails open to `new`; the prior
   side is internal and never claims a fix.
6. **A Finding outside the diff is not a `Comment`** - it renders structurally in the Review
   body under the same Threshold and dedupe rules.
7. **Acceptance rules that belong to the Run, not the Result** - a late Result on a terminal
   Run, a Patch under the wrong Autonomy, a substituted Model.
8. **The bucket key**, shown against a moved claim, a re-rated claim, and an edited anchor.

## What it deliberately does not contain

- **`Artifact`.** Deleted as a domain noun: no producer, no transport, no consumer, no
  retention semantics.
- **A name for the per-Pass bundle.** It stays Adapter-internal (`AdapterPassOutput` as a
  TypeScript name only) until multi-Pass Strategy composition gives it independent meaning.
- **Any Drizzle schema.** The two are separate and each authoritative for its own boundary;
  `Result` has no table at all.
- **A confidence field**, per ADR 0002.
