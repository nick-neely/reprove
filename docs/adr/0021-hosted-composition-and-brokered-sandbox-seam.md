# How a Workflow step reaches a Sandbox and an Adapter

[ADR 0010](0010-package-graph-and-open-core-boundary.md) confined `@ai-sdk/*` to two packages and
made `@reprove/worker-hosted` the only edge on which a control-plane deployment may reach
`worker-core`. [ADR 0014](0014-workflow-orchestration-seam.md) fixed that a `'use step'` function's
module graph is settled at build time, so the package that defines steps is the only one that can
configure them. Neither said where a hosted Sandbox provider lives, who composes the real hosted
core, or how a step on Vercel drives the Codex Adapter against a Vercel Sandbox. Today
`worker-hosted` ships a fixture core and its README says composing a real one needs packages ADR
0010 keeps out of it. [Fix how a Workflow step reaches a Sandbox and an
Adapter](https://github.com/nick-neely/reprove/issues/109) settles the seam. This ADR is the
decision; the prototype ticket proves the parts it cannot settle on paper, and §9 says which.

Three facts shaped it. Vercel's firewall forwards a domain's traffic to a `forwardURL` with the
original request intact plus an OIDC token naming the team, project, sandbox id and sandbox name,
and its matchers never block, so path and method are enforced by whoever receives the forward. A
Vercel Function invocation holds no memory between calls, so everything the local proxy keeps in a
closure needs a durable home. And a Vercel Sandbox is reattached by name, outlives the invocation
that created it, and does not keep a process alive across stop and resume, so a Pass spanning steps
keeps its Sandbox running.

## 1. The provider is `@reprove/sandbox-vercel`, a ninth package

A new published package, `@reprove/sandbox-vercel`, implements the `SandboxProvider` and `Sandbox`
interfaces `@reprove/sandbox-container` defines, over `@vercel/sandbox`. It depends on
`@reprove/sandbox-container` for those interfaces, the placeholder guards and the portable policy
logic, on `@vercel/sandbox`, and on `@ai-sdk/harness` core. It reaches no other Reprove package and
no per-Harness bridge.

A second provider inside `sandbox-container` was rejected because `@reprove/worker` reaches that
package through `worker-core`, so a Vercel SDK there installs on every self-hosted Worker. Reprove
owns the Vercel session rather than consuming `@ai-sdk/sandbox-vercel`, as the hosted-Sandbox
research recommended: the brokered Adapter already hand-implements the session shape and validates
every transform, and owning the session is what reaches the forwarding rule.

The container proxy's local HTTP server, TLS termination, relay subprocess and zstd plumbing do not
move; they are loopback machinery. What the new package reuses is the pure part: target
permission, header forwarding, byte-capped body reading, encoding validation, credential-binding
validation and the placeholder guards. ADR 0010's rule "`@ai-sdk/*` appears in exactly two
packages" becomes a named set: `adapters` and the Sandbox providers.

## 2. `worker-hosted` composes the real core from explicit configuration

`@reprove/worker-hosted` gains edges to `@reprove/adapters` and `@reprove/sandbox-vercel` and
exports a composition function that builds `createWorkerCore({ adapter, sandboxes, materialize,
... })` from values it is handed. It still reads no environment: `control-plane-workflow`'s hosted
composition reads the environment at the step boundary and passes values in, which is ADR 0014's
invariant kept literally. The `harness-reach` rule generalises from "reach `worker-core` only
through `worker-hosted`" to "reach any of `worker-core`, `adapters`, `sandbox-container`,
`sandbox-vercel` only through `worker-hosted`". `apps/control-plane` still declares none of them.

A separate composition package was rejected as a package with one export. Composing inside
`control-plane-workflow` was rejected because that package is installed by every self-hosted
deployment and its forbidden row is what keeps harness code out of them.

## 3. The workflow bundle stays Harness-free; the gate gains a startup check

The ticket assumed the bundle gate must invert. It must not. `tools/verify-workflow-build.mjs`
inspects the `'use workflow'` bundle, and the hosted stack is reached only from inside the
`'use step'` body, which ships through the separate step route. Both workflow-bundle assertions
stay verbatim and `@vercel/sandbox` joins the names the bundle may not carry.

The output trace cannot prove a package shipped, because bundled code ships without its package
paths, and a doubled Harness cannot prove the real bridge loads. So the gate gains two measured
checks:

- **Files the step needs as files.** The trace requirements are extended with the runtime files the
  hosted step reads from disk, determined by building and reading the output: the pinned bridge and
  launcher bytes the Adapter's preflight verifies, and the Vercel provider's bootstrap assets.
  Package names are not asserted.
- **A built-artifact bridge startup check.** A step in `control-plane-workflow`, started by the
  gate through the Workflow runtime after `next start`, composes the real hosted core from the
  built module graph with a doubled Sandbox that is a local subprocess provider, runs the shipped
  launcher and bridge to the bridge's handshake, stops it before any turn, and reports the bridge
  version, the launcher and bridge digests the preflight computed, and the Adapter's fingerprint.
  The gate compares the digests with the pinned ones.

The startup check proves that the shipped launcher and bridge execute from the deployment artifact.
It does not prove Vercel Sandbox transport, cross-process continuation, or `verify` capability, and
the fingerprint it reports is configuration identity, not capability evidence. Those remain
prototype and scenario obligations.

## 4. The broker is a route on the hosted deployment, not the platform firewall

The Sandbox's network policy is deny-by-default with no catch-all, and the Provider domain carries
one unconditional `forwardURL` rule pointing at a proxy route on the hosted deployment. The route
is exported by `worker-hosted` over ports, mounted by `control-plane-workflow`'s hosted composition
with a binding store and the deployment's Provider key, and runs under `defineSandboxProxy`, which
verifies the OIDC token's signature, issuer, expiry and audience. The Sandbox holds a placeholder;
`Exposure` resolves to `none`. The Provider key is one per deployment, read from the environment
at the composition boundary, and is never written to a row.

Letting the firewall inject the real header with a `transform` rule was rejected. It is simpler,
but the firewall is blind to request bodies, and the Codex Adapter's instruction probe grants
`verify` only after observing outbound Provider bodies for canaries. Header transforms are also
redacted on readback, so an updated policy cannot preserve them. With forwarding there are no
transforms, so that hazard never arises.

The policy is installed at create. If materialization needs broader access during bootstrap, a
policy narrowed before untrusted execution begins is legitimate, and the materialization ticket
decides the bootstrap set. Registry and GitHub traffic is not routed through the Provider broker to
keep an install-once rule; any shared route keeps their authorization and credentials separate.

## 5. The Binding: durable per-Pass broker state

The local proxy's closure state moves to a **Binding** row in the control plane, written through
ports: one row per Sandbox, keyed by the Sandbox name, with a kind of `review` or `probe`. The step
writes the row at provision with the sandbox id Vercel assigned, the Provider origin with scheme
and port, and the method and path rules; it writes the placeholder when the Harness declares its
transform through `addRequestTransformations`, in the same step and before the Sandbox's first
Provider call; for a probe row it writes the canary. The row holds no secret. Slice state is not on
it (§7).

Admission is one serialized transaction per Binding: lock the row, then reject unless all of the
following hold, then reserve. The token's team id and project id equal the deployment's own; the
token's sandbox name resolves to a Binding whose recorded sandbox id equals the token's sandbox id,
so a later Sandbox reusing the name is refused; the Binding's kind admits this Sandbox; the Pass is
`executing`, not superseded, and inside its ceiling; the destination origin, scheme, port, method
and path match the bound rules; the `Authorization` header carries the bound placeholder; the
request count is under the cap; and the count of unexpired admissions is under the concurrency cap.
On success the same transaction increments the request count and inserts an admission row whose
expiry equals the upstream request ceiling the route enforces, including the streamed response.
The route aborts upstream at that ceiling and releases the admission when the response body
finishes, is cancelled, or errors, not when the handler returns a `Response`.

What this guarantees and what it does not: revocation and expiry stop later admissions and do not
cancel a request already admitted; aborting upstream initiates cancellation and does not prove the
Provider stopped; the concurrency cap bounds active proxy requests, not Provider concurrency. A
rejection with a trustworthy Binding is recorded on that Binding; a rejection without one, such as
an unknown sandbox name or a foreign project, goes to bounded operational logs, because a caller
that failed authorization must not write onto another Pass's row. Caps start at today's four
concurrent and one hundred requests per Binding until the prototype measures otherwise.

## 6. The probe has its own Binding, budget and teardown

The instruction probe runs as its own step before the first drive slice, in a Sandbox named
`<passId>.probe`, under a `probe` Binding with its own request caps sized to one turn. For a probe
Binding the route inspects the body under the byte cap, persists the observation, and only then
forwards; an inspection that cannot complete or persist rejects the request. The probe step reads
the observations back and succeeds only when the probe completed, at least one request was
inspected, no request carried the canary, and the canary command never executed. Absence of an
observation row is failure, never success. The probe Sandbox is torn down on both outcomes, with
the same platform timeout and independent cleanup path as the review Sandbox, because a `finally`
covers exceptions and not process termination.

Probe usage counts toward the Pass's configured `budget` and shares its deadline, including a
failed probe. **Today it does not**: the Result's Usage is the pass's own and the probe reports
none, so this is a change the handoff carries, not a property inherited. One probe per Pass in
Phase 1; a deployment-wide five-minute measurement cache stays in the map's fog.

## 7. Slices: one running Sandbox, one turn, several steps

A hosted Pass is one authorized turn driven across several Workflow steps, each a **Slice**. The
Sandbox is named by the Pass id, created with a platform timeout equal to the remaining time to the
absolute Pass deadline plus a cleanup margin during which the Binding admits nothing, and kept
running between Slices; stop and resume are never used mid-Pass. Detach and resume stay inside the
Adapter per [ADR 0005](0005-adapter-boundary.md); a step carries only the opaque cursor.

Slice state lives in a hosted-pass execution record owned by the control plane, separate from the
Binding: the sandbox id at provision, persisted before any driving so cleanup never depends on
Workflow progress, then one row per Slice. Claiming Slice n is a serialized transition under a
uniqueness constraint on `(passId, sliceNumber)`: it succeeds only when the Pass is active and
within its deadline, Slice n-1 holds a persisted cursor or outcome, and no Slice is open. Completed
outcomes are persisted the same way as suspended cursors, so a final Slice whose Workflow
acknowledgement was lost replays its outcome instead of becoming a Failure.

With that record in place the drive step keeps Workflow's default bounded retries. A retried
attempt whose claim finds Slice n already persisted returns that cursor or outcome and drives
nothing. An attempt that finds Slice n `started` with nothing persisted treats execution as
ambiguous, not stopped: it ends the Pass as a Failure, revokes the Binding, and initiates Sandbox
teardown, so an overlapping attempt cannot continue unchecked. Two failures are distinct and both
fail closed: suspension succeeded but the database write failed, which leaves no durable cursor
and is that ambiguous case; the write succeeded but Workflow lost the step result, which is the
recoverable case. Who sweeps an abandoned Sandbox sooner than the platform timeout is [Decide how
an abandoned hosted pass's Sandbox is reaped](https://github.com/nick-neely/reprove/issues/88).

## 8. Capability carries across Slices while nothing changes

Worker core resolves capability fresh per dispatch and the Codex Adapter checks it again when
`pass()` starts the turn. The probe, authorization and turn start happen in the first drive Slice
within the five-minute bound. Later Slices resume through the Adapter and pass through neither
check, so no freshness check is bypassed: capability carries only while the authorized runtime,
the policy and the turn remain unchanged, and Pass liveness, revocation and deadline still apply at
every Slice. If resumption were found to call `pass()` and start another turn, re-probing would
not repair it: that breaks the same-turn requirement and means the design is unproven.

## 9. What the prototype must prove, and the one-Slice scaffold

[Prototype one real Codex Pass in a Vercel Sandbox from a Workflow
step](https://github.com/nick-neely/reprove/issues/114) must show that a second process resumes
the **same active turn** on a reattached Sandbox, with complete Evidence and Usage accounting,
without issuing another turn. Serializing the cursor through Workflow's step result is necessary
and not sufficient. A one-step experiment is legitimate scaffolding for isolating failures; the
sliced shape is the only shipped path, and it is committed only once that resumption is proven.

## Consequences

- Nine published packages. ADR 0010's table gains a `sandbox-vercel` row and the `worker-hosted`
  row gains `adapters` and `sandbox-vercel`; the self-hosted deployment table is unchanged because
  every new edge hangs off `worker-hosted`.
- The control plane gains two records written only through `worker-hosted`'s ports: the Binding
  with its admissions, and the hosted-pass execution record with its Slices. Neither is Workflow's
  storage, and both fall under [ADR 0008](0008-persistence-tenancy-and-retention.md)'s tenancy.
- The hosted deployment exposes one public route it did not before, the proxy. It admits nothing
  without a verified token and a live Binding.
- [Decide what egress a verify Sandbox is allowed](https://github.com/nick-neely/reprove/issues/113)
  inherits the deny-by-default policy and the forwarded Provider; [Fix what a hosted Pass
  materializes and when it is snapshotted](https://github.com/nick-neely/reprove/issues/110)
  decides the bootstrap set; [Replace the Phase 0 windows with measured
  deadlines](https://github.com/nick-neely/reprove/issues/115) receives the platform timeout
  formula and the per-request ceiling as inputs.

## Amended by [#95](https://github.com/nick-neely/reprove/issues/95)

[ADR 0023](0023-worker-refusal-over-a-dispatched-run.md) changes four things here.

- **§8 contradicted §6 and is corrected.** The probe is its own step before the first drive Slice
  (§6). What happens in the first drive Slice is capability resolution **from the probe step's
  measurement** within the five-minute bound, core's gates, authorization and turn start, not the
  probe itself.
- **§5's `executing` requirement is met by ordering.** The pass records `executing` as its first
  step, before the probe step, so probe admission never races `markExecuting`.
- **§6 and §7: the probe step has a durable outcome.** The execution record gains a probe-step row
  under the Slice claim-and-replay rule, holding the verdict, any Refusal, and the probe's Usage or
  an explicit `unknown`. A probe found claimed with no durable outcome is §7's ambiguous case and
  fails closed; a second paid probe is never run silently. A Refusal from the first drive Slice is
  persisted as that Slice's outcome and replays like any other.
- **§6: probe Usage is attributed to the Run**, for a refused Run as for any other, as part of an
  aggregate of distinct increments with a completeness. Unknown is never zero.

## Amended by [#110](https://github.com/nick-neely/reprove/issues/110)

[ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md) decides the bootstrap set this
ADR deferred, and puts materialization inside the Pass's own Sandbox.

- **§7: materialization is driven like the turn.** It runs detached in the Sandbox and is polled
  across the Slices before authorization, with a cursor on the hosted-pass execution record, under
  the same claim-and-replay rule as a drive Slice. Its time counts against the configured
  `deadline`.
- **§7's ambiguity rule is unchanged and covers materialization too.** A Slice that finds the
  previous one `started` with nothing persisted ends the Pass as a Failure, revokes the Binding and
  initiates teardown, whether the work in question was materialization or the turn. **There is no
  automatic restart** in Phase 1; ADR 0024 §10 records why one was rejected and keeps the Sandbox
  name as the cleanup identity for
  [#88](https://github.com/nick-neely/reprove/issues/88).
- **§6's probe is re-ordered.** It is still one probe per Pass with its own Binding, budget and
  teardown, but it runs **after** materialization rather than before the first drive Slice, in
  ADR 0024 §9's closure sequence.
