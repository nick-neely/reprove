# `@reprove/worker-core`

The Worker core shared by both execution lifecycles: Adapters, Sandbox provisioning, Workspace materialization, Result construction and validation, and the Evidence cross-check ([ADR 0006](../../docs/adr/0006-worker-protocol.md), [ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). It is on npm because `@reprove/worker` depends on it and npm resolution requires it - a dependency-graph fact, not a product decision. Public source, gated by every CI check, carrying **no stability promise**.

`workerProtocolSchemas` is the Worker-side reference to the authoritative
schemas from `@reprove/protocol/v1`; Result construction and Refusal handling do
not define a second wire shape.

## One Run, three outcomes

`createWorkerCore().execute()` takes one Run and returns exactly one of
`result`, `refusal` or `failure` - the three outcomes protocol v1 admits, and no
fourth. The pipeline is ordered, and the order is the contract:

```text
 1 resolve the Adapter capability      fresh, per dispatch
 2 establish the host's Isolation      from the Sandbox provider
 3 the dispatch gates                  Refusal
 4 bound and encode the narrative      Refusal
 5 separate the instruction channels   head origin is never admitted
 6 launch the Sandbox                  Refusal
 7 materialize the protected file      Refusal
 -- execution is authorized here and nowhere earlier --
 8 the Pass                            Failure
 9 the pinned-Model check              Failure
10 conform: cross-check, then validate Failure
11 teardown                            Failure
```

**The line at step 7 is the split.** A hard-boundary defect found above it is a
**Refusal**, which crosses the boundary as a protocol message naming the
requirement that failed. A repair or teardown defect found below it is a
**Failure**, which does not cross at all: execution began, so claiming nothing
ran would be false, and protocol v1 carries no payload that says otherwise. An
`InternalFailure` is a structured value the calling lifecycle reports through
the mechanism its placement already has. Neither outcome is ever reported as
the other.

**Worker core is the only authorizer.** Every gate above the line can only
refuse. An Adapter reports a capability and a Sandbox provider attests an
instance; both are inputs to the decision made here, and neither is a decision.
The regression that proves it is that every Refusal path leaves the Adapter's
`pass` uninvoked.

## What is here, and why

| Module | What it owns |
|---|---|
| `run.ts` | The pipeline above, and the only place execution is authorized. |
| `dispatch.ts` | ADR 0004's `Exposure` x `Isolation` x `Provenance` matrix, the capability probe's shelf life, ADR 0009's boundary gate, and the Autonomy check. |
| `narrative.ts` | ADR 0012's bounded, protected `authority: none` data file. |
| `instructions.ts` | ADR 0009's channel separation: origin decides admission, indirection is neutralized. |
| `evidence.ts` | The Evidence cross-check, and the bound that keeps raw output off the wire. |
| `result.ts` | Result construction, validated against `@reprove/protocol`'s own schema. |
| `sandbox.ts` | The Sandbox request, including the per-Harness suppression environment. |
| `adapter.ts` | The Adapter port, as Worker core drives it. |

Three decisions inside the package are worth stating, because none of them is
obvious from the ADRs alone.

**The Adapter port lives here rather than in `@reprove/adapters`.** ADR 0005
fixes what an Adapter exposes; what an Adapter is *given* is decided by the only
thing that authorizes a Pass. Stating it here also keeps `@reprove/adapters`
free of `@reprove/protocol`, which ADR 0010 requires.

**The repair turn is the Adapter's mechanism and Worker core's decision.** ADR
0005 keeps the bounded repair turn inside the Pass and also gives Reprove
ownership of Result conformance, and only Worker core can decide conformance. So
a `PassRequest` carries `check`, and what an Adapter may do about a complaint
is run its one repair turn and ask again.

The word throughout is **conformance**, never acceptance. `CONTEXT.md` reserves
Acceptance for the control plane's decision to absorb a submitted Result into
its Run, says outright that it happens only there, and distinguishes it by name
from the validation a Worker performs on its own output.

**Any unsupported Evidence claim complains, not only a `verified` one.** ADR 0005
names the `verified` case. The rule here is wider on purpose: a Finding claiming
Evidence Reprove never observed is a fabricated record whatever standing the
Reviewer assigned it, and silently dropping the claim would be the quiet rewrite
of a Finding that ADR 0002 forbids.

## What Phase 0 does not have

- **No checkout and no Workspace materialization.** The Sandbox is launched with
  an empty sandbox-owned volume; putting a stripped repository on it is Phase 1's.
- **No `@ai-sdk/harness` Adapter.** The Codex Adapter double is test-only, lives
  in `boundary.test-support.ts`, and never reaches `dist`.
- **Base conventions are neutralized rather than expanded.** Resolving an
  `@`-import against the pinned base SHA needs the host-side checkout above, so
  this implements the safe subset of ADR 0009's decision 6.
- **`materialize` is a port.** `@reprove/sandbox-container` exposes no write
  primitive, and shelling the narrative bytes through an argument vector is what
  ADR 0012 forbids by name.
