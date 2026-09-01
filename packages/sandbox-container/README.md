# `@reprove/sandbox-container`

The container Sandbox primitive. It depends on **no** `@reprove/*` package, because it is offered as a standalone security primitive usable with `@ai-sdk/harness` by someone who has never heard of Reprove - and that claim is only true if the dependency graph says so. If it later needs a small utility, the answer is to duplicate it or extract a genuinely generic external package, never to reach back into Reprove's application graph.

## Support tier

**Supported product surface** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

At Phase 0 this is a shell and carries no product behaviour.
