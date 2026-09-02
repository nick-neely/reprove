# `@reprove/worker`

The self-hosted Worker lifecycle: a long-lived daemon with enrollment, polling, claim, lease and cancellation. It exposes the single globally meaningful command:

```text
reprove <enroll|start|status>
```

The artifact is the package, not an installation command: it is distributed on npm and installed with whatever npm-compatible client the operator uses. There is no standalone binary and no primary container image ([ADR 0004](../../docs/adr/0004-sandbox-boundary-and-credential-isolation.md) already requires the Worker to run as a host process).

## Support tier

**Supported product surface** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)) - this is what a self-hosted operator installs.

At Phase 0 this is a shell: the bin prints usage and implements nothing.
