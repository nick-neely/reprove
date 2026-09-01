# `@reprove/docs-app`

**Reserved.** [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md) lists `apps/docs` as "reserved; created when there is content". It exists now only so the settled workspace set is complete, so that `tools/verify-workspace.mjs` verifies a fixed set rather than discovering a new workspace later.

It is private, never published, and holds a placeholder module and a thin `tsc` build so it participates in `pnpm verify` like every other workspace.
