# `@reprove/protocol`

The versioned Reprove wire contract and nothing else. Zod schemas are authoritative; TypeScript types are inferred from them. It depends on `zod` and nothing more, and **Adapters may not depend on it**.

## Support tier

**Published infrastructure with a supported wire contract** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

The _wire contract_ under `/v1` is compatibility-governed by [ADR 0006](../../docs/adr/0006-worker-protocol.md) and cannot be called unstable while a four-month-old official Worker depends on it. The _package API_ is not a supported general-purpose SDK - importing a helper from it earns no long-term API promise. The wire is a contract; the library is not.

Version families are subpath exports, not a growing union: import `@reprove/protocol/v1`. There is deliberately no `.` export.

At Phase 0 this is a shell and carries no product behaviour.
