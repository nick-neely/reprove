# `@reprove/adapters`

One Adapter per Harness, behind [ADR 0005](../../docs/adr/0005-adapter-boundary.md)'s hard type boundary against the upstream harness SDK. `@ai-sdk/*` appears in exactly two packages, and this is one of them.

It must not depend on `@reprove/protocol`: an Adapter yields the unnamed per-Pass bundle, and `@reprove/worker-core` composes the wire Result.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). Public source, published so the graph resolves, gated by every CI check, carrying **no stability promise**.

The Codex Adapter is implemented with both brokered and native authentication. See [Codex execution](../../docs/codex-adapter.md) for image provisioning, fresh capability probes, authentication Exposure, Worker composition and executable contract tests.

Only `verify` is advertised, after a matching behavioral probe and actual Sandbox checks. Native authentication preserves ADR 0004's account-Exposure exception. Model choices live in the control plane; this package accepts an explicit opaque Model pin.
