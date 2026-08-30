# Two invocation Routes behind the Adapter

[#3](https://github.com/nick-neely/reprove/issues/3) and [#4](https://github.com/nick-neely/reprove/issues/4)
independently established that `@ai-sdk/harness` has no subscription authentication: grepping
`auth.json`, `.credentials`, `oauth`, `ChatGPT` and `subscription` across all three adapters and
their in-sandbox bridges returns zero hits, and the Codex bridge pins
`preferred_auth_method = 'apikey'`. That contradicted a stated differentiator - orchestrating the
coding agents a user has already installed and authenticated - and left the map with a fork.

We are resolving it by **splitting invocation into two Routes behind one Adapter interface**, and by
defining those Routes along **authentication and execution** rather than along who operates the
Worker. "Hosted uses `@ai-sdk/harness`, self-hosted uses the CLI" would have been the easy framing
and it is the wrong one: it re-collapses Route into Worker operator, which
[ADR 0001](0001-one-worker-concept.md) already separated, and it would make a self-hosted Worker
permanently incapable of the stronger security architecture.

## What direct CLI invocation actually offers

Measured against `codex` 0.150.0, `claude` 2.1.251 and `opencode` 1.18.12, not read from docs.

| | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| JSON Schema on final output | `--output-schema FILE` | `--json-schema <schema>` | **none** |
| Machine-readable stream | `--json` (JSONL) | `--output-format stream-json` | `--format json` |
| Unattended user-managed auth | `login --with-access-token` | `setup-token` | `providers login` |
| Suppress repo-local instructions | `--ignore-rules`, `--ignore-user-config` | `--bare` | unverified |
| Restrict built-in tools | sandbox modes only | `--restricted`, `--disallowed-tools` | permission config |

Two facts inverted the framing this decision started from. First, the CLI is **more** capable than
the harness adapter for several controls Reprove needs: [#4](https://github.com/nick-neely/reprove/issues/4)
found no way to suppress `CLAUDE.md` and no built-in tool filtering on Codex, and the CLIs have
`--bare`, `--ignore-rules` and `--restricted`. Second, credential brokering was never going to
protect a user-managed credential anyway - [#3](https://github.com/nick-neely/reprove/issues/3)
established that `auth.json` is a self-refreshing OAuth token, so a refresh returns new tokens
*into* the sandbox. Brokering protects static API keys, which is precisely the case the Brokered
Route serves.

## Decisions

- **Reprove supports multiple invocation Routes behind the Adapter**, and Route is an
  implementation detail of the Adapter rather than a concept the control plane branches on.
  - **Brokered Harness Route**: `@ai-sdk/harness` with an API key or AI Gateway credential. It
    **must** run against a Sandbox provider that implements credential brokering. Valid for hosted
    **and** self-hosted Workers.
  - **Native Auth Route**: direct invocation of the installed `codex`, `claude` or `opencode` CLI
    using authentication the user manages, which `@ai-sdk/harness` cannot consume. Self-hosted
    Workers only.
- **Provenance classifies a Run's input risk**: `internal` when the head is a branch of the same
  repository **and** the pull request's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`;
  `external` otherwise. It is computed from the pull request, never configured. `CONTRIBUTOR` is
  `external`: having had a change merged before is not a trust credential.
- **Provenance is a risk classification, not a security guarantee.** `internal` means an attacker
  would have to be a collaborator, which is materially weaker than an open door but is not a closed
  one.
- **The Native Auth Route serves `internal` Provenance only** by default. Anything else requires an
  explicit per-Repository opt-in that names the risk.
  [#10](https://github.com/nick-neely/reprove/issues/10) owns the full policy surface.
- **A denied Run fails loudly.** The failure is reported through a GitHub Check or status rather
  than a pull request comment, because no review occurred and a comment would imply one did. Falling
  back to the Brokered Route is permitted only when explicitly configured, never inferred. Worker
  pool failover belongs to [#12](https://github.com/nick-neely/reprove/issues/12).
- **Capability descriptors are keyed by `(Harness, Route)`**, not by Harness. They are probed when a
  Worker registers and again immediately before a Run is dispatched to it. A Route is advertised
  with `installed`, `authenticated` and `usable` rather than disappearing when unavailable, so the
  control plane can distinguish "not present" from "present but logged out."
- **Reprove owns Result conformance.** The Adapter always parses and validates a Result with zod;
  native schema enforcement is an optimization where it exists, not the guarantee. Where it is
  absent, one bounded repair turn is permitted.
- **Reprove drives a generic turn on every Harness**, never a Harness's native review mode.
- **Reprove will author a local, broker-capable `HarnessV1SandboxProvider`** implementing the
  `HarnessV1SandboxProvider` contract with exposed ports and mandatory credential brokering.
  Docker or Podman is the expected implementation technology. What it must enforce is
  [#10](https://github.com/nick-neely/reprove/issues/10)'s to define.
- **Upstream gaps are reported, never depended on.** Reprove's roadmap does not wait on a
  `vercel/ai` review queue.
- **The product claim is:** a self-hosted Worker orchestrates Harnesses the user has configured on
  infrastructure they control. Reprove does not promise that subscription authentication is cheaper
  or permanently available, and does not claim the Native Auth Route is safe for untrusted code
  until [#10](https://github.com/nick-neely/reprove/issues/10) establishes and verifies its
  isolation boundary.
- **Build order:** Codex across both Routes, then Claude Code across both, then OpenCode. OpenCode
  is last deliberately: it is the only Harness with no CLI schema flag, so it exercises the
  validation and repair path, which is worth landing when that layer is mature rather than new.
- **This ADR does not fix the Native Auth Route's per-Harness isolation shape.** That is
  [#10](https://github.com/nick-neely/reprove/issues/10)'s, including the conclusion that some
  native Routes remain credential-co-located and `internal`-only permanently.

## Considered options

**Harness-only, one abstraction everywhere.** API keys or AI Gateway for hosted and self-hosted
alike. Architecturally the simplest answer and the one we would take if the self-hosted Worker's
only promise were confinement. Rejected because it discards a real capability for no gain: the
Native Route costs a second invocation path, and #3 and #4 already proved that path is *better*
resourced than the harness one for instruction suppression and tool restriction. It would also have
meant Reprove could not drive a Harness on a machine where the user has one authenticated and
working, which is an indefensible thing to explain.

**A second path defined as "self-hosted uses the CLI."** Same two code paths, different framing.
Rejected because it makes deployment topology and security architecture the same axis, so a
self-hosted Worker could never use credential brokering, and a hosted Worker could never use
user-managed auth even if that became viable. Defining the split by authentication keeps the axes
independent, and it is why the local sandbox provider below is a decision rather than an
optimization.

**Contribute subscription auth upstream to `vercel/ai` and stay harness-only.** The best long-term
outcome if it landed. Rejected as a dependency: `@ai-sdk/harness` ships ~10.8 releases per week on a
single `1.0.x` line with removals shipped as patches, every doc page says "expect breaking changes,"
and betting the differentiator on someone else's review queue is not a foundation. The two-Route
design also *reduces* the value of that specific contribution to close to zero, since Reprove no
longer needs it. The gap worth reporting instead is #3's: credential brokering silently falling back
to putting the real key in the sandbox on a `console.warn`. That is a security defect affecting
every `@ai-sdk/harness` user and the fix is small.

**Deferring the local + brokered cell** rather than committing to author a provider. The cell is
empty today: `@ai-sdk/sandbox-vercel` and `@e2b/ai-sdk-sandbox` broker but are cloud services,
`@coder/ai-sdk-sandbox` does not broker, and `@ai-sdk/sandbox-just-bash` neither brokers nor exposes
ports - its own source notes that adapters needing `getPortEndpoint` "will fail with
`HarnessCapabilityUnsupportedError` at start," which rules it out for all three Harnesses. There is
no `@ai-sdk/sandbox-docker`. Leaving the cell empty would have meant "self-hosted Worker" implies
"your code goes to Vercel or E2B," which collapses Route back onto Worker operator. Committing to
the provider is the expensive answer and it is the one that keeps the two axes independent.

**Requiring Project commands to always execute outside the credentialed process** on the Native
Route. Attractive, and rejected as unenforceable: #3 established that Claude Code and OpenCode
expose no seam for relocating tool execution at all, and Codex's `exec-server` seam is experimental,
undocumented and ships an unauthenticated `ws://` listener by default. Writing the constraint would
have committed Reprove to an architecture it cannot deliver on two of three Harnesses. It would also
have bought less than it appears to: it stops a malicious `postinstall` from reading a credential
and does nothing about a `CLAUDE.md` that talks the agent into reading it itself. The trust rule,
not the sandbox split, is what keeps this Route safe.

## Consequences

- **The Adapter abstracts Route, not just Harness.** `CONTEXT.md`'s definition of Adapter as code
  "wrapping the third-party harness layer" was true of one Route and is amended accordingly. Whether
  the Adapter seam survives the Route difference is the real test of
  [#11](https://github.com/nick-neely/reprove/issues/11), and it is why the build order takes one
  Harness across both Routes before adding a second Harness.
- **A `(Harness, Route)` pair with divergent capabilities is now the unit** the ask-time capability
  descriptor from #4 describes. Codex-via-CLI can suppress `AGENTS.md` and constrain output by
  schema; Codex-via-harness can do neither. One descriptor per Harness would be false on one of its
  Routes.
- **Structured output is no longer uniform.** #4's finding that all three Harnesses support
  schema-constrained output holds on the Brokered Route only. On the Native Route it holds for Codex
  and Claude Code and fails for OpenCode, which is why Result validation moved into the Adapter
  rather than being delegated to the Harness. Reprove needed that layer regardless:
  [ADR 0002](0002-severity-verification-and-no-confidence.md) requires cross-checking that a
  `verified` Finding's claimed command appears in the session transcript, which no JSON Schema can
  enforce.
- **Worker registration carries Routes, not just Harnesses**, and dispatch re-probes before
  committing a Run. This lands on [#12](https://github.com/nick-neely/reprove/issues/12).
  User-managed credentials expire and get revoked in a way API keys do not, so registration-time
  state is not trustworthy at dispatch time.
- **Repository configuration gains a Route and Provenance surface** - which Routes a Repository
  permits, and any opt-in past the `internal` default. This adds to the config format still parked
  in the map's fog.
- **[#16](https://github.com/nick-neely/reprove/issues/16) applies to both Routes.** A repo-controlled
  `CLAUDE.md` steers a brokered Reviewer just as effectively; it merely has less to steal. The Native
  Route's better suppression flags are a mitigation, not a reason to scope #16 to one Route.
- **Provenance is a new axis on the Run** and must be recorded with it, because a Run's Route
  eligibility has to be auditable after the fact.
- **The Native Auth Route is a trusted-code execution route until #10 says otherwise.** Nothing in
  the README, the marketing site or the PRD may describe it as safe for arbitrary pull requests
  before then. [#9](https://github.com/nick-neely/reprove/issues/9) writes the copy within that
  constraint.
