# `@reprove/worker-core`

The Worker core shared by both execution lifecycles: Adapters, Sandbox provisioning, Workspace materialization, Result construction and validation, and the Evidence cross-check ([ADR 0006](../../docs/adr/0006-worker-protocol.md), [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). It is on npm because `@reprove/worker` depends on it and npm resolution requires it - a dependency-graph fact, not a product decision. Public source, gated by every CI check, carrying **no stability promise**.

`workerProtocolSchemas` is the Worker-side reference to the authoritative
schemas from `@reprove/protocol/v1`; Result construction and Refusal handling do
not define a second wire shape.
