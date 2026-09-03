# `@reprove/control-plane`

Control-plane substance: GitHub ingress, scheduling, persistence, Acceptance, Reconciliation, publication, the Drizzle schema and migrations, and the Better Auth schema and config factory.

**The package reads no environment variables.** The app parses deployment-specific configuration and passes it explicitly to `createControlPlane(config)`. No Reprove Cloud credential default exists here.

It does **not** depend on `@reprove/worker-core`, and since [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) it does not depend on `workflow` either - every workflow and step definition lives in `@reprove/control-plane-workflow`.

```text
reprove-control-plane <bootstrap|migrate>
```

The command is namespaced deliberately and does not expect global installation; the underlying functions are exported too, so a consumer is never forced to shell out.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). The supported self-hosting surface is `apps/control-plane` **as a deployable application, not as a package**. Public source, gated by every CI check, carrying **no stability promise**.

`workerProtocolSchemas` is the control-plane reference to the authoritative
schemas from `@reprove/protocol/v1`; the package does not define a second wire
shape. The bin still prints usage and implements no operational commands.
