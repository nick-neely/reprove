# `@reprove/control-plane-workflow`

Every workflow and step definition for the hosted control plane, and all step configuration. It depends on `@reprove/control-plane` and `workflow`, and holds no harness code.

It exists because a `'use step'` function is compiled into a bundle whose module graph is fixed at build time, so **the layer that defines steps is the only layer that can reliably configure them**. Leaving the definitions in `@reprove/control-plane` would force that package to read the environment, which [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md) forbids ([ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)).

The name is qualified deliberately: `Adapter` is already a `CONTEXT.md` noun, and naming rule 4 qualifies the _foreign_ word - Vercel's `Workflow` - at the seam.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). Public source, gated by every CI check, carrying **no stability promise**.

At Phase 0 this is a shell and carries no product behaviour.
