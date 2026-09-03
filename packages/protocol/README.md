# `@reprove/protocol`

The versioned Reprove wire contract and nothing else. Zod schemas are authoritative; TypeScript types are inferred from them. It depends on `zod` and nothing more, and **Adapters may not depend on it**.

## Support tier

**Published infrastructure with a supported wire contract** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

The _wire contract_ under `/v1` is compatibility-governed by [ADR 0006](../../docs/adr/0006-worker-protocol.md) and cannot be called unstable while a four-month-old official Worker depends on it. The _package API_ is not a supported general-purpose SDK - importing a helper from it earns no long-term API promise. The wire is a contract; the library is not.

Version families are subpath exports, not a growing union: import `@reprove/protocol/v1`. There is deliberately no `.` export.

Protocol v1 exports the shared Zod schemas and inferred TypeScript types for the
three payloads crossing the Worker boundary: `RunSpec`, `Result` and `Refusal`.
`protocolSchemas` groups exactly those payload schemas for consumers that need
the whole boundary. Nested schemas are exported for composition, but Adapter
output is intentionally absent because it stays inside the Worker core.
