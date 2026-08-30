# The Sandbox boundary and credential isolation

[#3](https://github.com/nick-neely/reprove/issues/3) established what is technically possible:
option (a) - the Harness on the Worker with its tool calls proxied outward into a credential-free
sandbox - is not a foundation, because Claude Code and OpenCode expose no tool-execution seam at
all and Codex's is experimental and unauthenticated. This ADR decides what Reprove actually
builds on top of that finding: where the Sandbox boundary sits, what may cross it, what a Worker
must provide to host one, and what happens when it cannot.

The premise, stated once so the rest reads correctly: **Reprove assumes the repository under
review executes arbitrary code inside the Sandbox.** That is the design's starting assumption, not
a failure of it. Everything below is about what that code can reach, not about preventing it.

## The Sandbox contract

A Sandbox is defined by properties, not by a technology. Every Sandbox, hosted or self-hosted,
must provide:

- separate network, PID and mount namespaces;
- no privileged container and no unnecessary capabilities;
- no container-runtime socket reachable from inside;
- no arbitrary host bind mounts;
- seccomp enabled, never `unconfined`;
- resource limits on CPU, memory and process count;
- a Workspace in sandbox-owned ephemeral storage, not a writable host directory;
- egress only through Reprove's proxy;
- teardown after the Run.

**The Harness's own sandbox is never this boundary.** Codex's `--sandbox workspace-write` grants
full-disk *read* in every non-`danger` mode ([#3](https://github.com/nick-neely/reprove/issues/3)
verified `~/.codex/auth.json` readable under it), Claude Code's sandbox restricts Bash while Read,
Edit and Write bypass it, and OpenCode ships no sandbox at all - its own repository
`SECURITY.md` says outright that *"OpenCode does **not** sandbox the agent ... it is not designed to
provide security isolation."* Those controls are defence in depth *inside* the boundary and are
configured as such; none of them is load-bearing.

The OpenCode citation is narrower than it first read. #19 re-checked it at `v1.18.25`: the *absence*
is verified by a repo-wide grep for `seccomp|bubblewrap|bwrap|landlock|namespaces|chroot`, which
returns only unrelated hits, but the *statement* lives in the repository's `SECURITY.md`, not in the
published documentation, where #19 could not find it. Cite the file, not the docs site.

Seccomp and resource limits are hard requirements rather than strength signals because a pull
request that can fork-bomb the Worker or reach an unrestricted syscall surface is attacking the
boundary itself, not merely the Run.

## Decisions

- **The architecture is (c) plus credential brokering, one Sandbox per Pass.** Option (a) is dead
  per #3. Option (b), short-lived credentials, is defence in depth against a brokering failure
  rather than the boundary. Egress allowlisting confines the blast; brokering removes the thing
  worth stealing; neither alone is sufficient.

- **Reprove does not separate repository execution from the Reviewer.** The Harness, the Workspace
  and any code it runs share one Sandbox. #3 recommended a second credential-free execution
  Sandbox and we are declining it: Codex refuses built-in tool approval outright
  (`"Harness 'codex' does not support built-in tool approval requests"`), so the split is
  unavailable on the first Harness in [ADR 0003](0003-two-invocation-routes.md)'s build order, and
  building it only where it works would fracture the Adapter seam
  [#11](https://github.com/nick-neely/reprove/issues/11) exists to hold together. `codex
  exec-server` is a real but rejected alternative - experimental, undocumented, Codex-only, and an
  unauthenticated `ws://` listener by default. Revisit if it graduates.

- **Two new axes, both computed and both recorded on the Run.**
  - **`Isolation`** - how strongly the Sandbox is separated from its host and from the credential:
    `microvm`, `container-rootless`, `container`. The Worker computes and advertises it; below
    `container` there is no Sandbox and no Run.
  - **`Exposure`** - what a fully compromised Sandbox would yield: `none` (no usable credential is
    inside it), `scoped` (a model-only credential revocable without disturbing the user's own
    login), `account` (a credential that can act as the user beyond this Run).

- **Dispatch gates on `Exposure`, `Isolation` and `Provenance`. It does not gate on Route.**

  | Exposure | Isolation | Provenance permitted |
  | --- | --- | --- |
  | `none` | `microvm`, `container-rootless` | `internal` + `external` |
  | `none` | `container` | `internal` only |
  | `scoped` | `microvm`, `container-rootless` | `internal`; `external` by opt-in |
  | `scoped` | `container` | `internal` only |
  | `account` | `microvm`, `container-rootless` | `internal` only |
  | `account` | `container` | **never dispatched** |

  **Exactly one opt-in exists** - the `external` cell on row three - and it is read from the base
  ref so a pull request cannot grant itself one. A matrix of opt-ins is a policy engine nobody can
  reason about at review time; one named opt-in is auditable and its name can state the risk.

  **`account` on `container` is refused outright**, not offered behind a checkbox. A self-renewing
  account credential in a rootful container running repository code is the configuration both
  OpenAI and Anthropic document as unsafe in their own devcontainer guidance. The remedy is
  rootless, and it must be documented well, because the user this refuses is a Plus/Pro Codex user
  on default Docker.

  **A hypervisor between the container and the operator's machine gets no credit.** Docker Desktop
  and Podman machine are genuinely stronger than bare rootful Docker, but detecting "am I inside a
  VM whose host is the operator's laptop" is fragile, and we would rather be conservative than
  clever. The practical consequence is that **Podman machine is the recommended macOS and Windows
  path**, because it is rootless by default and Docker Desktop is not.

- **On the Brokered Route no usable credential enters the Sandbox** (`Exposure: none`). A
  brokering-capable Sandbox provider is a hard precondition, so `@coder/ai-sdk-sandbox` and
  `@ai-sdk/sandbox-just-bash` are unsupported by construction. #3 found brokering is *default-off*
  upstream with a `console.warn` as its only failure signal; Reprove ships the
  `credentialForwarding` guard that throws on any non-placeholder value, with a regression test.
  The guard is not optional and not a lint rule.

- **On the Native Route the credential is inside the boundary and no engineering removes it.**
  `auth.json` holds a self-refreshing OAuth token, so a broker returns new tokens *into* the box.
  The rule is therefore about credential power, not about relocating it: **use the least-powerful
  officially supported user-managed credential each Harness offers, and never expose more
  credential material than that Harness requires.**

  | Harness | Preferred credential | `Exposure` |
  | --- | --- | --- |
  | Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` - one year, never written to disk, *"can only make model requests"* | `scoped`, with the revocability caveat below |
  | Codex, Business/Enterprise | `codex login --with-access-token`, which stores an Agent Identity JWT, not a bearer token | **unestablished** - see below |
  | Codex, Plus/Pro | the saved ChatGPT authentication path, which is the actual Native Auth use case | `account` |
  | OpenCode | a dedicated, separately-revocable provider API key, supplied as that provider's single models.dev environment variable, with no `auth.json` in the Sandbox and no config file holding a literal key | `scoped`; a mounted `auth.json` is categorically `account` |

  **Three corrections on that table**, found by
  [#19](https://github.com/nick-neely/reprove/issues/19) while answering a different question and
  recorded in [`docs/research/codex-credential-reduction.md`](../research/codex-credential-reduction.md).
  None of them changes a decision in this ADR.

  **The Codex Business/Enterprise row is unestablished, not `scoped`.** This ADR previously called
  `CODEX_ACCESS_TOKEN` *"a short-lived workload token"*. What `codex login --with-access-token`
  actually writes carries no `tokens` object at all: either an `at-…` personal access token, or an
  Agent Identity JWT whose `agent_private_key` claim *is* the Ed25519 signing key, used to mint a
  fresh assertion per request with no bearer token on the wire. Anyone holding that JWT can mint
  assertions for the account for the key's lifetime. Whether that is `scoped` turns on how narrowly
  OpenAI scopes an agent identity and how independently it can be revoked, and **neither was
  established**. It is recorded as unestablished rather than reclassified in either direction,
  because moving it would be a decision on evidence nobody has gathered - and nobody needs it until
  an Enterprise Codex user exists. What does follow from rules this ADR already states: `Exposure`
  is computed from the resolved credential at dispatch, and *nothing warns and runs*, so an
  unestablished class may not resolve to the favourable one on the strength of this row.

  **The revocability half of `scoped` is inferred for Claude Code, not documented.** All three
  claims in the Claude Code row are verbatim-verified against Anthropic's authentication page, and
  inference-only scope is corroborated in the shipped artifact - the credential carries
  `["user:inference"]`, and runtime messages refuse Remote Control and connectors to exactly this
  kind of token. Revocability is not. Per-token deletion at `claude.ai/settings/claude-code` appears
  only in a support article; Anthropic nowhere states that it leaves the interactive login intact or
  that it takes effect immediately, the security documentation does not mention credential
  revocation at all, and there is a community-reported, unverified issue alleging claude.ai-side
  revocation did not invalidate a token. The row stands. What does not stand is Reprove asserting
  revocability as a property of Reprove, so `SECURITY.md` states it as a user-driven action on a
  surface the vendor does not document.

  **On OpenCode every bit of narrowing is provider-side.** OpenCode has no `setup-token` analogue -
  no derived, scope-reduced, harness-issued credential exists - which is why the row now names a
  provider-issued key and the conditions around it rather than a harness mechanism. `Auth.all()`
  reads every entry in `auth.json` together, so mounting that file exposes every provider the user
  has ever connected, including stale OAuth grants that still carry refresh tokens; an `oauth`-type
  OpenCode credential is `account` for the same reason Codex's `auth.json` is. Two consequences also
  refine the per-Run limits clause below: a model allowlist is enforceable at Reprove's proxy but
  not at the credential (OpenCode's `blacklist` config is a picker filter, not a control), and a
  spend budget exists only where the provider offers one.

  Requiring `scoped` universally was considered and rejected: it would have made Codex Native Auth
  Enterprise-only at launch, which is designing away the feature the Route exists to provide, and
  ADR 0003 already accepted co-location as the Native Route's premise. The first correction above
  only strengthens that rejection - with the Enterprise row unestablished, a universal `scoped`
  requirement would remove Codex Native Auth on every plan rather than narrowing it to one.

- **Egress is default-deny and phased, restricted by host *and* method *and* path.** Every phase
  gets only the destinations it needs; Repository policy may add explicit destinations; there is
  no ordinary `allow-all`. Network policy changes live between phases.

  | Phase | Reachable |
  | --- | --- |
  | Install | configured package registries |
  | Verify / Pass | the model or Gateway endpoint, plus explicitly approved Repository endpoints |

  Codex's own `responses-api-proxy` is the reference for path restriction - *"only forwards `POST`
  requests to `/v1/responses` ... Everything else is rejected with 403 Forbidden"* - but the
  allowlist is **per `(Harness, Route)`**, not universal: a Native Route credential may need
  authentication endpoints a Brokered one never touches. Never `subnets.allow` with a broad range,
  which bypasses SNI filtering, brokering and proxying and leaves DNS unrestricted. Plain HTTP is
  denied; SNI-only matching means domain fronting works, so allowlist narrow single-purpose
  hostnames.

- **Per-Run limits split by what Reprove can always enforce.** Always, at the proxy: allowed
  host/method/path, request count, request and body size, wall-clock, concurrency, and denial of
  every unmatched request. Where the credential or provider exposes it: spend budget, token
  budget, model allowlist. A hard dollar budget is **not** part of the universal Sandbox contract,
  because direct-provider and user-managed authentication do not expose that primitive.

- **Any additional secret sandboxed code requires must be brokered and must never be injected
  directly.** This is the general rule; whether private-registry brokering ships in the first
  implementation phase is a phase decision, not a foundation one.

- **The Worker materialises a self-contained Git repository at the exact base and head state the
  Run requires, strips all remotes and host references, then copies it into sandbox-owned
  ephemeral storage.** No GitHub credential ever enters a Sandbox, and the Sandbox never reaches
  GitHub. Concretely the Worker must: strip credential-bearing URLs and credential helpers from
  `.git/config` rather than relying on `git remote remove`; leave no Git alternates or
  linked-worktree pointers referencing host locations; resolve submodules and LFS host-side if
  they are needed at all; preserve enough history for `git log` and `git blame` to be useful, with
  the depth decided separately; and remove repository Git hooks, since Reprove wants Git as a read
  surface and not as repo-controlled behavior.

  Keeping `.git` is deliberate: `git diff`, `git show`, `git log`, `git blame` and merge-base
  information are exactly what a Reviewer needs, and re-implementing them as tools would be worse
  in every respect than shipping a repository with no remote and no credential.

- **Project commands resolve from the base ref, never the head**, because configuration a pull
  request can edit is not policy. This is hygiene and **not** a security control: under `verify`
  Autonomy the Reviewer holds a shell and can run anything the head contains. The control is the
  Sandbox.

- **Dependency lifecycle scripts are disabled during install by default**, with an explicit
  `installScripts: allow` Repository opt-in. It does not solve arbitrary code execution and
  `SECURITY.md` must not pretend it does, but it removes an *implicit* supply-chain execution path
  that fires before the Reviewer has deliberately chosen to execute anything. Under `inspect`
  Autonomy there is no install and no execution at all.

- **The Worker requires a Linux kernel and a container runtime (Docker or Podman), and runs as a
  host process rather than in a container.** macOS and Windows are supported only through a Linux
  VM - Docker Desktop, Podman machine, WSL2 - which the Worker detects and reports as what it is.
  Native Windows containers cannot provide the namespace set and are unsupported. The Worker stays
  on the host because a containerised Worker needs a runtime socket to create sibling Sandboxes
  and mounting that socket is a known escalation path; it also keeps a Native Route credential
  where the user already keeps it. A containerised deployment against a rootless Podman user
  socket can be documented later as a supported variant. This resolves PRD open question 33.

- **Nothing warns and runs.** A missing hard requirement is a refusal; a missing strength signal
  narrows permitted Provenance. Both are visible in the Worker's advertised capabilities and both
  surface on the GitHub Check. `SECURITY.md` names silent downgrade as an in-scope security
  property, and a warning in a Worker log is silent to the person whose pull request is being
  reviewed.

## What Reprove promises publicly

Three claims, each falsifiable:

1. **On the Brokered Route, no usable credential enters the Sandbox.** Enforced by the
   `credentialForwarding` guard and covered by a regression test.
2. **The Sandbox has no GitHub authority.** It cannot fetch, push, or reach any ref the Worker did
   not materialise.
3. **A weakened posture never runs quietly.** Every degradation is a refusal or a narrowing of
   permitted Provenance, and both are surfaced.

And one non-claim, stated as plainly as the claims: **Reprove does not isolate repository
execution from the Reviewer.** The Harness, the Workspace and any code it runs share one Sandbox.
On the Native Route the credential is inside that Sandbox and Reprove does not claim otherwise;
what bounds the risk is Provenance, Isolation and revocability, not separation.

The residual, recorded rather than argued away: **a compromised Sandbox cannot steal a brokered
credential, but it may spend the Run's remaining budget against the allowed endpoint or attempt
exfiltration through explicitly permitted destinations.** Credential brokering converts credential
*theft* into bounded authorized-service *abuse*. It does not eliminate it.

## Relationship to ADR 0003

This ADR **supersedes ADR 0003's Route-based gating clause**. ADR 0003 stated that the Native Auth
Route serves `internal` Provenance only by default, with an explicit per-Repository opt-in beyond
it. The substance survives; the axis changes. Gating on Route was always a proxy for gating on
blast radius, and now that `Exposure` names the thing itself, the proxy goes. This also honours
`CONTEXT.md`'s definition of Route as *"an implementation detail of an Adapter, not something its
callers choose between"*, which Route-based gating contradicted. It generalises for free: a future
Brokered Route that leaks something, or a Native credential narrower than today's, lands in the
right cell without a new rule.

Everything else in ADR 0003 stands unchanged.

## Consequences for the worker protocol ([#12](https://github.com/nick-neely/reprove/issues/12))

1. **Registration carries a structured isolation report, not a boolean** - the `Isolation` level
   plus the individual hard-requirement checks that produced it, so the control plane can explain
   a refusal rather than merely issue one.
2. **`Exposure` is per-Run and resolved at dispatch, not at registration.** A `setup-token`
   expires, an `auth.json` is re-logged-in, a user adds an API key. ADR 0003 already re-probes
   capabilities before dispatch; credential class joins what gets re-probed, and a stale probe is
   a refusal rather than an assumption.
3. **The protocol never transports Harness or provider credentials.** GitHub repository
   credentials are a separate #12 decision: if the control plane supplies one, it must be
   short-lived, least-privilege, Run-scoped, and must never cross into the Sandbox. Requiring
   every self-hosted Worker to own and configure its own GitHub authority is not the obvious
   answer and should not be assumed.
4. **Refusals are first-class protocol messages** carrying which requirement failed, so the GitHub
   Check can name it. Silent downgrade is an in-scope vulnerability, which makes "why was this
   refused" part of the contract rather than a log line.

## Other consequences

- **Claude Code cannot use `--bare` and user-managed authentication together.** `--bare` is ADR
  0003's instruction-suppression flag for Claude Code, and Anthropic documents that *"Bare mode
  does not read `CLAUDE_CODE_OAUTH_TOKEN`. If your script passes `--bare`, authenticate with
  `ANTHROPIC_API_KEY` or an `apiKeyHelper` instead."* On the Native Route it is one or the other.
  Recorded here; the mitigation belongs to
  [#16](https://github.com/nick-neely/reprove/issues/16), which has to solve `AGENTS.md` anyway.
  **Resolved, and no longer binding, by
  [ADR 0009](0009-repo-controlled-instruction-boundary.md):** `--safe-mode` disables the same
  customizations as `--bare`, leaves authentication working normally, and additionally closes
  `.mcp.json` discovery, which `--bare` leaves open. The conflict is real but Reprove never has to
  choose between them.
- **`Isolation` and `Exposure` are new fields on the Run**, alongside `Provenance`, because a
  dispatch decision must be auditable after the fact. This lands on
  [#13](https://github.com/nick-neely/reprove/issues/13) and
  [#14](https://github.com/nick-neely/reprove/issues/14).
- **Repository configuration gains three keys**: the `external` Provenance opt-in, `installScripts`,
  and additional approved egress destinations.
- **Whatever leaves the Sandbox is attacker-controlled.** Evidence and Result are data to be
  validated outside the boundary, which is also where ADR 0002's transcript cross-check already
  had to run.
- **The local `HarnessV1SandboxProvider`'s contract is now fully specified** by the Sandbox
  contract above, so it remains a phase-map implementation task rather than a decision.
