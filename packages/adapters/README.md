# `@reprove/adapters`

One Adapter per Harness, behind [ADR 0005](../../docs/adr/0005-adapter-boundary.md)'s hard type boundary against the upstream harness SDK. `@ai-sdk/*` appears in exactly two packages, and this is one of them.

It must not depend on `@reprove/protocol`: an Adapter yields the unnamed per-Pass bundle, and `@reprove/worker-core` composes the wire Result.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). Public source, published so the graph resolves, gated by every CI check, carrying **no stability promise**.

At Phase 0 this is a shell and carries no product behaviour.
