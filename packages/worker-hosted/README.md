# `@reprove/worker-hosted`

The hosted Worker lifecycle: Workflow steps driving `@reprove/worker-core` through the Adapter's internal detach and resume.

Hosted capability is optional composition, not a default. A hosted-capable deployment composes `@reprove/control-plane` + `@reprove/worker-hosted`; the self-hosted composition omits this package entirely. Keeping it out of `@reprove/control-plane` is what makes "a control plane that dispatches only to self-hosted Workers installs no harness code at all" true.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). Public source, gated by every CI check, carrying **no stability promise**.

At Phase 0 this is a shell and carries no product behaviour.
