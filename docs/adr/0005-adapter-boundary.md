# The Adapter boundary

> **Partially superseded by [ADR 0009](0009-repo-controlled-instruction-boundary.md):**
> `canSuppressRepoInstructions` is renamed `canEnforceRepoInstructionBoundary` and promoted from an
> advisory capability field to a hard dispatch gate; it is **no longer credential-dependent**, since
> `--safe-mode` replaces `--bare` and leaves authentication working normally, which removes the
> reason the field was split across the registration and dispatch views. "Unknown or raw
> configuration is rejected, not forwarded" gains a **carve-out for Adapter-owned suppression keys**,
> because as written it forbids `codexConfig`, the only Brokered-Route suppression Codex has. The
> `skills` channel deferral is resolved in principle: the seam is preserved for trusted base-ref
> skills, enabled per Harness only after that Harness's skill tool and permission semantics are
> verified. Everything else in this ADR stands, including instruction ownership, which ADR 0009
> inherits as a premise.

[#4](https://github.com/nick-neely/reprove/issues/4) established the real capability surface of
`@ai-sdk/harness`, and [ADR 0003](0003-two-invocation-routes.md) then split invocation into two
Routes behind one Adapter, closing with the observation that "whether the Adapter seam survives the
Route difference is the real test of #11." This ADR is that test. It decides what an Adapter
exposes, what it owns, what it hides, and what it refuses.

PRD §19 asks for normalization "where practical" and warns against forcing false uniformity. The
line drawn here is: **normalize what a caller must reason about, absorb what it must not, and refuse
what cannot be honestly promised.**

## Shape

**One Adapter per Harness.** Route is an internal implementation strategy: `CodexAdapter` contains
both a brokered and a native implementation, and neither becomes a public noun, a domain type, or a
registry entry. This preserves `CONTEXT.md`'s definition of Route as "an implementation detail of an
Adapter, not something its callers choose between," which
[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) already worked to protect when it moved
dispatch gating off Route and onto `Exposure` x `Isolation` x `Provenance`. Six public Adapter
identities would have put Route back into the registry.

**The Adapter runs Worker-side, outside the Sandbox.** ADR 0004 requires that Result and Evidence be
validated outside the boundary, because "whatever leaves the Sandbox is attacker-controlled." The
Worker host is where that happens, and it is also where the Worker already materializes the
repository.

**The interface is a single Pass invocation**, not a session: run a Pass, get a progress stream, abort
it. Session creation, `detach`/`resume`, the bounded repair turn, and reattachment across Vercel
Workflow step boundaries ([#6](https://github.com/nick-neely/reprove/issues/6)) all stay inside. A
Pass is already the sandbox-scoped unit under ADR 0004's one-Sandbox-per-Pass rule, Strategy
composition is out of scope for this map, and the one thing a public session surface would buy -
multi-turn steering - is absent on Codex, the first Harness in the build order. Publishing a
lifecycle that only two of three Harnesses honour would be exactly the false uniformity PRD §19
warns against.

**A Pass yields an internal bundle, not a `Result`.** It carries candidate Findings, a summary
contribution, Evidence, usage and execution metadata, and it is strictly narrower than a Run's
`Result`, which is defined as the Run-level payload crossing the Worker boundary. Strategy
composition happens above the Adapter, so one Adapter invocation cannot own the final `Result`.
Naming this bundle is deferred to [#13](https://github.com/nick-neely/reprove/issues/13), which sees
the full Run and Result shape; until then it is an internal implementation type and not vocabulary.

## Capability

Reprove owns a single closed capability schema. It has two views, because the same field is not
answerable at the same fidelity at both moments:

- **Registration** is keyed by `(Harness, Route)` and answers "what combinations exist on this
  Worker, and what could they support." It carries ADR 0003's `installed` / `authenticated` /
  `usable`.
- **Dispatch** produces a **resolved** view that folds in the credential, Sandbox, `Exposure` and
  pinned Model, and answers "what can this invocation actually support for this Run."

The two views exist because one field is not a function of `(Harness, Route)` at all. ADR 0004
records that Claude Code cannot use `--bare` and user-managed authentication together, and `--bare`
is ADR 0003's instruction-suppression flag. So `canSuppressRepoInstructions` on
`(Claude Code, native)` is true under an API key and false under `CLAUDE_CODE_OAUTH_TOKEN`. Adding
credential class as a third registry key would be wrong: this is runtime resolution, and ADR 0004
already establishes that credential class joins what gets re-probed at dispatch and that "a stale
probe is a refusal rather than an assumption."

**Public fields**, deliberately few:

- `supportedAutonomy` - which of `inspect` / `verify` / `fix` this resolved invocation can enforce
- `canSuppressRepoInstructions` - input to [#16](https://github.com/nick-neely/reprove/issues/16)
- `reportsResolvedModel` - whether the pinned-Model check below can be performed

A capability belongs in the descriptor only if it changes whether or how a caller may request a
Pass. Everything else is Adapter-private, including the upstream tool-control mechanism
(`none` / `filter` / `deny` across Codex / Claude Code / OpenCode), which is an *input* the Adapter
uses to derive `supportedAutonomy` rather than something a caller should reason about. Structured
output is absorbed because Reprove guarantees validated output on every Route regardless (below);
credential brokering is absorbed because Route plus resolved `Exposure` already carries it and two
sources of truth is worse than one; cost reporting is absorbed because only Claude Code emits USD
([#4](https://github.com/nick-neely/reprove/issues/4)) and Reprove normalizes cost from tokens
everywhere.

**`usable` never means a model answered.** It means Reprove can attempt this Route under the
resolved prerequisites: binary and version present, Route prerequisites satisfied, credential
resolvable, `Exposure` determinable, Sandbox provider requirements met, relevant Adapter capability
available. Burning a model request before every Run to prove the provider will answer is a per-Run
tax for a fact that changes only when auth lapses, and the actual invocation remains authoritative
and fails loudly if it has.

## Model

The control plane owns the Model catalogue and pins the exact Model on the Run.
[#4](https://github.com/nick-neely/reprove/issues/4) verified there is no runtime model enumeration
anywhere in the five packages, so a Worker cannot authoritatively report which Models it can serve
and must not claim to. It reports Harness, Route, version and capabilities; it receives a pinned
Model; it passes that exact id through.

The Adapter **never** substitutes a Model and never falls back to a Harness default - Codex's adapter
default of `gpt-5.5` in particular must never be reached by omission. Where the Harness reports the
model it resolved to (Claude Code and OpenCode do via `stream-start.modelId`; Codex does not), the
Adapter verifies it matches and fails otherwise. Silent substitution would destroy reproducibility
and make cross-harness comparison meaningless, which is the entire point of the product.

Because model ids are treated as opaque strings throughout, adding a newly supported Model is a
catalogue change in the control plane, not a redeploy of every long-lived self-hosted Worker.

## Instructions

Reprove owns the Reviewer's instructions and delivers them through the framework-level `instructions`
channel, which [#4](https://github.com/nick-neely/reprove/issues/4) verified is uniform across all
three Harnesses. The Adapter never intentionally delegates review behavior to `AGENTS.md`,
`CLAUDE.md`, repo skills, or any other repository-supplied material.

The `skills` channel is deliberately **not** used yet, despite living outside the Workspace where a
pull request author cannot reach it. Adopting it now would add a second instruction channel,
complicate Codex's session behavior (which restarts its native thread when instructions *or* skills
change), and pre-empt a policy [#16](https://github.com/nick-neely/reprove/issues/16) has not set.
It remains available as later hardening.

**This ADR settles ownership and the seam; it does not settle enforcement.**
[#16](https://github.com/nick-neely/reprove/issues/16) decides what is stripped from the checkout,
what comes from base versus head, which native suppression flags are used, and whether trusted
base-branch instructions are ever re-admitted. That is why #16 does not block this decision: the
Adapter provides the seam through which sanitized Workspace content and explicit Reprove instructions
are supplied, and #16 owns the mechanism behind it.

## Autonomy

**A resolved `(Harness, Route)` may only advertise an Autonomy level Reprove can actually enforce.**

`Autonomy` is a permission ladder, and [#4](https://github.com/nick-neely/reprove/issues/4) verified
that Codex throws at `doStart` on any `permissionMode` other than `allow-all` and on any built-in
tool filtering. There is therefore no mechanism by which `inspect` can mean "may read, may not
execute" on Codex. Offering it anyway would hand a user who selected `inspect` for safety an
unrestricted shell, which is the silent-downgrade class ADR 0004 already bans.

So Codex does not support `inspect` under the current capability surface. `verify` is supported, and
`fix` depends on the later Fix implementation. This is a real product limitation at launch, on the
first Harness in the build order, and it is preferred over a permission that does not permit
anything.

The rejected alternative was to redefine `inspect` as an execution-hostile Sandbox - no project
commands installed, no egress - rather than a tool restriction. ADR 0004 already characterises that
shape as "hygiene, not a control," so adopting it would have renamed a preference as a permission.

## Result and Evidence

**Reprove owns Result conformance**, as ADR 0003 established: the Adapter always validates with zod,
and native schema enforcement is an optimization where it exists rather than the guarantee. PRD §27
is explicit that parsing arbitrary Markdown must not become the core integration contract.

Where validation fails, **one bounded repair turn runs as a second turn inside the same Pass and the
same Sandbox**, and both turns consume the Pass budget. A repair is recovery from malformed Adapter
output, not another Reviewer and not another semantic Pass; provisioning a second Sandbox to re-ask
for valid JSON would distort the domain model as well as the cost. If validation still fails, the
Pass fails. It is never converted into an empty Result: empty means "review completed with no
Findings," and malformed means "review failed," and conflating them would publish a clean bill of
health the Reviewer never gave.

**Evidence has two sources and they are not collapsed before reconciliation.** The Reviewer's
structured Evidence is a *claim*. The `tool-call` / `tool-result` activity the Adapter observed -
present on all three Harnesses per #4 - is the record that claim is validated against. Reconciliation
runs Worker-side, outside the Sandbox, where ADR 0002's transcript cross-check already had to run,
and what it produces is what Reprove thereafter treats as Evidence.

A Finding claiming `verified` whose command has no observed counterpart is a **Result acceptance
failure** - repair turn if available, Pass failure otherwise. Reprove does not rewrite a Reviewer's
`Verification` after the fact; ADR 0002 made Verification the whole trust signal a Finding carries,
and quietly editing it downward would corrupt the one thing it is for.

The limit of this check is worth stating: it proves the Harness observed that tool execution. It does
not make the command's output trustworthy. ADR 0004's rule that everything leaving the Sandbox is
attacker-controlled still applies to Evidence in full.

## Streaming and budget

The Adapter's internal progress stream is a closed, minimal set: lifecycle boundaries, tool activity,
usage where the Harness provides it, and terminal success or failure. It carries **no reasoning
deltas and no model prose**; final prose belongs in the Pass output. The stream-part divergences #4
catalogued (`file-change` absent on Claude Code, `compaction` and `tool-approval-request` absent on
Codex) are absorbed rather than exposed.

**What the Worker forwards to the control plane is sanitized lifecycle and tool metadata, not raw
Evidence.** Whether bulk Evidence - literal output from the user's own code, including stack traces,
query responses and test output - is transported to the control plane at all is
[#12](https://github.com/nick-neely/reprove/issues/12)'s decision, and this ADR must not settle it by
default. The control plane can learn that verification started and a tool completed without receiving
stdout.

[#4](https://github.com/nick-neely/reprove/issues/4) verified no adapter offers a wall-clock timeout
at all, so budget enforcement is entirely Reprove's. Repository policy sets the Run budget; the
**Worker** enforces it; the **Adapter** enforces the Pass sub-budget via `AbortSignal`, accounting for
both the primary and repair turns; the **Sandbox lifetime is an emergency backstop only**, set
comfortably above Reprove's own budget so ordinary cancellation always wins. The three layers fail
differently on purpose: an aborted Pass is attributable and leaves its Evidence intact, while a
Sandbox timeout is a hard kill that destroys the record needed to explain it.

## Configuration

Reprove owns Model, Provider, and every security- and review-semantic control. Each Adapter may
expose a **small, typed, validated** set of Harness-specific advanced options, added deliberately as
real use cases appear. **Unknown or raw configuration is rejected, not forwarded.**

This resolves PRD open question 4 and narrows PRD §19's guidance. "Do not force false uniformity"
means Harness-specific options stay Harness-specific; it does not mean blindly forwarding arbitrary
Harness configuration. `codexConfig` and `openCodeConfig` are raw passthroughs into the very
surfaces - instructions, tools, permissions, provider endpoints, auth behavior - whose invariants
this ADR exists to hold, so an unvalidated escape hatch would be a documented backdoor around the
Adapter boundary.

## Versioning

`@ai-sdk/harness` shipped 99 releases in 64 days on a single `1.0.x` line, with removals shipped as
patches ([#4](https://github.com/nick-neely/reprove/issues/4)). The response is a **hard type
boundary, not a defensive wrapper layer**: no `HarnessV1*` or `experimental_*` type appears in
Reprove's domain types or in the worker protocol, while inside the Adapter the upstream API is used
directly. A shim over an API changing this fast is a second thing to maintain that still breaks; the
insulation is the type boundary.

All five packages are pinned exactly and bumped as one set, since the adapters exact-pin the
framework and a partial bump either fails to resolve or duplicates it.

**Adapter contract tests are required for every supported `(Harness, Route)`**, covering structured
output, capability, credential brokering, streaming and lifecycle behavior, so that an upstream patch
cannot change any of them silently.

## Consequences

- `inspect` is unavailable on Codex at launch, and callers read `supportedAutonomy` rather than
  inferring it.
- The capability schema is resolved twice per Run - once at registration, once at dispatch - and the
  resolved view is the only one safe to act on.
- [#13](https://github.com/nick-neely/reprove/issues/13) inherits the per-Pass bundle contract and the
  naming decision.
- [#12](https://github.com/nick-neely/reprove/issues/12) inherits the sanitized-progress contract and
  owns the Evidence egress policy.
- [#16](https://github.com/nick-neely/reprove/issues/16) inherits instruction ownership as a fixed
  premise and owns sanitization.
- `CONTEXT.md`'s `Adapter` entry claimed the Adapter supplies "the model catalogue," which this ADR
  makes false; the catalogue is control-plane data. Amended.
