# Protecting a suspended turn's cursor and the bridge endpoint

[ADR 0021](0021-hosted-composition-and-brokered-sandbox-seam.md) §7 treated the suspend cursor as
opaque and let a step carry it. [Prototype one real Codex Pass in a Vercel Sandbox from a Workflow
step](https://github.com/nick-neely/reprove/issues/114) showed it is a credential. The pinned
Harness (`@ai-sdk/harness-codex@1.0.104`, `@ai-sdk/harness@1.0.102`) behaves as follows:

- **One field is a live credential.** The cursor is about 490 bytes. `data.bridge.token` is a
  64-hex bearer token and the only secret in it. `threadId` is meaningful only inside the bridge,
  and the credential placeholder is valid only behind the OIDC-checked Provider route.
- **The bridge is publicly reachable and the token is its only guard.** The bridge binds `0.0.0.0`
  with no option to change that, and the host reaches it only by WebSocket at the public
  `sandbox.domain(port)` route, which Vercel does not authenticate. The token travels as the query
  parameter `agent_bridge_token` and is compared with `!==`. A missing environment token defaults
  to `""`, so an empty query parameter would then pass.
- **Holding the token is control of the Sandbox.** A holder can replay the turn's event log, inject
  tool results, abort the turn, or send `start` with any prompt, instructions, `codexConfig` and MCP
  servers under `danger-full-access`. That is arbitrary execution in the Sandbox plus Provider spend,
  bounded only by the firewall and the Binding.
- **The token reaches the Reviewer.** The bridge passes its whole environment, including
  `BRIDGE_CHANNEL_TOKEN`, to the Codex SDK. The SDK passes it to `codex` unchanged, and Codex
  0.156.1's default `shell_environment_policy` passes it to every tool command. In the prototype,
  the bridge, Codex and every tool ran as `ubuntu`, which has passwordless sudo.
- **The token cannot be rotated without a respawn.** `attach` reuses the cursor's token, and the
  bridge has no command to change it.
- **A lost `attach` falls back silently.** On resume, a failed `attach` is swallowed and the
  Harness falls to `replay` or `rerun`, with `isResume` true on every rung. The caller-supplied
  `mintBridgeToken` is called only after `attach` has failed and before any spawn, and a throw from
  it rejects `doStart`.
- **`doStart` and `doPromptTurn` are separate.** `doStart` launches and connects to the bridge.
  `doPromptTurn` sends the turn's `start` message, and only then does the bridge construct the Codex
  SDK. Between the two calls the bridge is idle and no Reviewer process exists.

Settled with the maintainer on 2026-09-24 in [Decide how a suspended turn's cursor and the bridge
endpoint are protected](https://github.com/nick-neely/reprove/issues/128). This ADR amends ADR 0021
§7, ADR 0024 §7 and §9, and ADR 0023's Failure reasons.

## 1. The bridge token is random and held in encrypted custody

The token is a fresh CSPRNG value, **never derived**. Deriving it from a deployment key and the Pass
identifiers would let anyone holding the key produce a live token without reading the database.

It is held in the same form as [ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md)
§9's fetch-token custody: authenticated encryption under the deployment key, in its own field and
never inside the cursor. The AAD binds the purpose `bridge-token`, the `passId`, and the recorded
Vercel instance ID (`sbx_…`), not the Sandbox name. It shares the fetch-token custody key, with the
purpose separated in the AAD, so the blast radius stays key plus database and a deploy-your-own
adopter provisions no new secret.

**Order.** The instance ID is recorded under ADR 0028 §3's create intent. The token is then
generated and committed encrypted in the Slices before authorization, and only then may `doStart`
launch the bridge. `mintBridgeToken` returns that already-committed token; it never mints and
persists later. In a continuing Slice it throws (§3). It rejects any token that is not 64 hex
characters.

**Key rotation.** Each ciphertext records a key ID. A retired key stays available for decryption
until the longest possible Pass (the absolute deadline plus the cleanup margin) has drained. A
continuing Slice decrypts only after ADR 0028 §3's exact-ID check.

## 2. The cursor stays on the Slice row, projected and cleared

A drive step's result carries only its Slice number, never the cursor, so no cursor reaches
Workflow's event log. The Slice row is the authority, and ADR 0021 §7's claim already replays from
it.

The row stores a **projection**, not the Harness's object. The pinned cursor shape is parsed
strictly, including `data.bridge.sandboxId` and `data.sandboxCredentialEnvironment`. Any other field
means the Slice fails to persist, which is ADR 0021 §7's ambiguous case and fails closed. Only
`threadId`, `port`, `lastSeenEventId`, `turnConfigurationFingerprint` and the credential placeholder
are kept. On resume, `harnessId` and the spec version are rebuilt from constants,
`bridge.sandboxId` from the session identity below, and the token from custody.

The hosted Sandbox session that `@reprove/sandbox-vercel` builds sets its `id` to the **recorded
instance ID**, not the name; the prototype set it to the name. That `id` feeds `bridge.sandboxId`
and the `.agent-runs/<id>` path. ADR 0028 §3's exact-ID check stays a separate step.

**Clearing.** The transaction that terminalizes the Pass and revokes its Binding also clears every
Slice's projection, the encrypted token, and every Slice `outcome` payload. By then an accepted
Result lives on the Run. A late final-Slice retry then finds a durable terminal outcome kind and
returns without driving anything; an empty payload beside a terminal kind is never the ambiguous
case. The [ADR 0008](0008-persistence-tenancy-and-retention.md) purge job clears the same fields
for any Pass past its Sandbox deadline plus cleanup margin, through a fixed `SECURITY DEFINER`
function under ADR 0028 §8's maintenance role. What survives is bounded: Slice number, state,
timestamps, outcome kind and enumerated resume facts. ADR 0008's content purge applies to anything
textual among them. Slice `outcome` and `facts` are not audit metadata by default, since either can
carry Reviewer text or source-derived output.

## 3. A continuing Slice spawns nothing; a lost `attach` is `resume_lost`

In a continuing Slice, `mintBridgeToken` throws. Neither `replay` nor `rerun` can spawn. `rerun`
re-drives the turn, which ADR 0021 §8 forbids. `replay` would re-emit a log from a disk the
Harness chose, which is weak Evidence and breaks the one rule.

The Pass ends as ADR 0021 §7's ambiguous case: a Failure, the Binding revoked, and teardown
initiated. The Failure reason is **`resume_lost`**, in the `execution` phase. It means "could not
reattach", **not** proof that the bridge died. It carries one bounded detail:

| Detail | Meaning |
|---|---|
| `attach_failed` | the Harness reached `mintBridgeToken` on resume |
| `instance_mismatch` | the Sandbox found by name is not the recorded instance |
| `token_key_unavailable` | the key that encrypted the token is unavailable; the Check describes it as a custody failure |
| `token_unreadable` | the ciphertext is missing or fails authentication |

`resume_lost` reaches the Run and its Check only through [Carry a Worker-reported Failure onto the
Run instead of closing it as worker_lost](https://github.com/nick-neely/reprove/issues/83);
without it the reason is lost as `worker_lost`.

## 4. Three identities inside the Sandbox

```text
root            setup and the bridge
ubuntu          the host's file API only; nothing Reviewer-side runs as it
Reviewer uid    Codex and all its descendants; no sudo, no privileged groups, no_new_privs
```

The bridge is launched with `runCommand({ sudo: true, env })`, never through a `SandboxUser`
handle, whose `sudo -u … env KEY=VAL` form puts the environment in a world-readable `cmdline`. This
launch is **conditional** on the proof (§8) showing the token in no `cmdline` and no command history.
If it fails, the bridge is launched as `ubuntu` and the wrapper escalates through `sudo -n` with an
explicit preserve list that excludes the `BRIDGE_*` variables, and this section is amended.

This makes ADR 0024 §7's "dedicated Reviewer user" concrete for the bridge path: the Reviewer uid is
distinct from the bridge's identity and from the file API's.

## 5. The Codex launch boundary is Reprove's root-owned wrapper

`codexPathOverride` is exactly what the Codex SDK spawns, and it points at the image's root-owned
`/opt/reprove/codex/reprove-codex`. Running as root, the wrapper:

1. removes `BRIDGE_CHANNEL_TOKEN`, `BRIDGE_WS_PORT`, `BRIDGE_REPLAY_FROM_DISK` and
   `AI_SDK_HARNESS_CLIENT_APP` from the environment;
2. sets `HOME` and `CODEX_HOME` to stable Reviewer-owned directories outside the Workspace and
   outside `.agent-runs`;
3. copies the SDK's `--output-schema` file to a root-owned, Reviewer-readable path and rewrites the
   argument, after validating the source and destination against symlinks;
4. runs `setpriv --reuid --regid --init-groups --no-new-privs` into a second stage.

The second stage runs as the Reviewer. It asserts the Reviewer uid and `no_new_privs`, then runs the
pinned `codex` with `--cd` set to the Workspace, keeping `--ignore-user-config --ignore-rules`,
which are part of the proven instruction boundary. A failed assertion happens after authorization,
so it is a `pass_failed` Failure with bounded detail `launch_guard`.

No `shell_environment_policy.exclude` rule is added. Once the wrapper has removed the variables they
don't exist, and changing `codexConfig` would change the qualified Revision for no added
protection. The wrapper is part of the image digest, so changing it is a Revision change that
requires requalification.

`.agent-runs` sits outside the Workspace, mode `0700`, owned by `ubuntu`. The file API keeps
working, root writes regardless, and the Reviewer can neither read nor write it. Being writable
would let the Reviewer forge the event log the host reads to choose a rung. That `ubuntu` can read
back what the root bridge writes is part of the proof.

## 6. The bridge is patched to refuse a malformed token and compare in constant time

The image already patches the bridge for `codexPathOverride`. A second patch in the same file makes
the bridge exit **before binding the port** unless `BRIDGE_CHANNEL_TOKEN` matches `^[0-9a-f]{64}$`,
and compares tokens with `timingSafeEqual` after validating both as 64 hex characters. The patch
asserts exactly one source match, so a pin change cannot silently skip it. Tests cover empty,
malformed, wrong and correct tokens. `mintBridgeToken`'s format check stays as the first line.

## 7. The Pass's own bridge is checked before authorization

ADR 0024 §9's closure sequence gains two steps between the probe and authorization:

```text
5  sandbox.update({ networkPolicy }) sets the full Reviewer-phase policy
6  the privilege preflight of ADR 0024 §7
7  the single instruction probe
8  the bridge token is committed encrypted (§1), then doStart launches the Pass's bridge
9  the bridge checks, against that idle bridge
10 authorization, then doPromptTurn sends start
```

The bridge checks, run as the Reviewer uid:

- `id` is the Reviewer uid, and `sudo -n true` is denied;
- reading the bridge's `/proc/<pid>/environ` is denied;
- `.agent-runs` cannot be listed or read;
- a loopback WebSocket connection with an empty or a wrong token is closed with `1008`.

And host-side, comparing without ever printing the token: the token appears in no `/proc/*/cmdline`
and not in the Sandbox's command history.

A demonstrated breach is the Worker Refusal **`sandbox_unenforceable`** (ADR 0024 §7). A checker that
crashes or times out is a Failure. The five-minute capability bound still holds through turn start.

## 8. The public bridge route is accepted only after proof

The bridge stays on the public `sandbox.domain(port)` route, guarded by the token, **only once**
[Prove a Reviewer cannot read or use the hosted bridge
token](https://github.com/nick-neely/reprove/issues/135) passes on the target Codex 0.156.1 pin.
That ticket blocks every implementation handoff that exposes the route. If it fails, this endpoint
decision reopens. Relaying the bridge through `openInteractive` is unproven and is not an
established fallback.

With the route in place:

- Reprove never logs, records or returns a token-bearing URL. Its errors and traces redact them.
- Whether Vercel's router logs query strings is **unverified**, and recorded as such rather than
  assumed.

The decision reopens if a Harness bump offers header authentication or a loopback bind.

## 9. Scope: hosted only, with a known local exception

The invariant **a Reviewer cannot read the bridge token** is stated for the hosted runtime. The local
container runtime violates it: the bridge and the Reviewer share uid 1000. Its bridge is reached
through the stdio relay, which limits remote exposure but does not stop a local Reviewer from taking
over its own bridge. That is [Keep the bridge token away from a local
Reviewer](https://github.com/nick-neely/reprove/issues/136), outside the Phase 1 map. It does not
block the hosted exit.

## Rejected

- **Plaintext cursor on the row** (the prototype): a live credential in durable state.
- **Deriving the token with `HMAC(key, passId, sandboxId)`**: the key alone yields live tokens, and
  a mid-Pass key rotation ends every live Pass.
- **Returning the cursor as a step result**: writes a credential, or at least a second copy, into
  Workflow's event log, outside ADR 0008's retention rules.
- **Allowing `replay`**: re-emitting a log from disk is weak Evidence and breaks "a continuing Slice
  spawns nothing".
- **Closing the port between Slices** with `update({ ports: [] })`: gaps are seconds against Slices
  of minutes, it adds a policy update to every Slice, and whether `domain()` stays stable is
  unproven.
- **Codex's `shell_environment_policy.exclude`** as the boundary: the same uid could still read the
  bridge's and Codex's `/proc/<pid>/environ`.
- **A canary bridge** for the per-Pass checks: unnecessary, because `doStart` and `doPromptTurn` are
  separate and the Pass's own bridge can be checked while idle.

## Handoffs

- [Prove a Reviewer cannot read or use the hosted bridge token](https://github.com/nick-neely/reprove/issues/135),
  **blocking**: every §7 check against the actual bridge before `doPromptTurn`; a real Codex tool
  call confirming the environment, uid and `no_new_privs` after the wrapper; `ubuntu` readback of the
  root bridge's files; the token's absence from command history under `sudo: true`; the session
  `id` as the stable instance ID across reattach; and the bridge patch's refusal to bind.
- [Fix the Phase 1 exit scenario and hand off the tracer bullets](https://github.com/nick-neely/reprove/issues/116):
  put the regression checks (§5, §6, §7 and the pinned-cursor parse of §2) into the **permanent
  pin-bump contract suite**, so any change to the Harness, bridge, SDK or CLI pins, the wrapper, the
  bridge patch, the image recipe or `@vercel/sandbox` re-proves them. A closed prototype ticket
  enforces nothing on a future bump. Wire [#83](https://github.com/nick-neely/reprove/issues/83) as
  a blocker of the ticket that first returns `resume_lost`.

## Consequences

- ADR 0021 §7's "a step carries only the opaque cursor" is replaced by §2: a step carries only its
  Slice number.
- ADR 0024 §7 gains the three identities and the bridge checks; §9's closure sequence gains steps 8
  and 9.
- ADR 0023's Failure reasons gain `resume_lost`, and `pass_failed` gains the detail `launch_guard`.
- The image gains the wrapper's second stage and a second bridge patch; both change the image digest
  and so the Revision.
- The hosted-pass execution record gains the encrypted bridge token with its key ID, and the purge
  job gains one fixed function.
- `CONTEXT.md` gains nothing. Cursor and bridge are implementation terms.
