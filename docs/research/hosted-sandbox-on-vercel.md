# A hosted Pass on Vercel: what Sandbox and Workflow actually carry

Research for [#104](https://github.com/nick-neely/reprove/issues/104) (child of
[#102](https://github.com/nick-neely/reprove/issues/102)).
Research date: **2026-09-14**. Every Vercel number was read from `vercel.com/docs` on that date;
every package fact was read from a published tarball or from the exact artifact this repository
already installs.

Every claim is tagged **VERIFIED** (with the source that owns it), **INFERRED** (reasoning over
verified facts, not itself documented), or **UNVERIFIED** (not established - recorded as a gap
rather than guessed at).

Two prior in-repo documents were treated as claims to re-check, not as sources:
[`long-running-jobs-on-vercel.md`](long-running-jobs-on-vercel.md) and the "Hosted path" section of
[`harness-tool-execution-seam.md`](harness-tool-execution-seam.md). Both were re-verified; §9
records what survived and what did not, including **a cost error that understates the bill by a
factor of the vCPU count.**

---

## TL;DR

**A Vercel Sandbox is a stronger boundary than anything Reprove implements today, and it cannot
answer the questions ADR 0004 asks.** Those are both true at once, and the second one is the work.

- **Credential brokering is a first-party platform feature, not an SDK convention.** The firewall
  terminates TLS with a per-sandbox CA and injects headers on the way out: *"Credentials brokering
  injects credentials into egressing traffic. The secrets never enter the sandbox, so code running
  inside it cannot exfiltrate them."* **VERIFIED.** It is **default-off** - you get it only by
  writing a `transform` rule - and nothing on the platform enforces that you wrote one.
- **The default network posture is wide open.** `allow-all` is the documented default. **VERIFIED.**
- **Vercel's firewall cannot restrict by method or path.** It allows by domain and CIDR only, and
  the docs say so in as many words: *"Matchers never block traffic."* Path/method matchers exist
  only to *select which requests get a transform*. ADR 0004 requires egress *"restricted by host
  **and** method **and** path"*, so the only compliant shape is `forwardURL` pointed at a Reprove
  proxy that does the rejecting. **VERIFIED** (the limitation), **INFERRED** (the consequence).
- **Isolation is a Firecracker microVM with a dedicated kernel** - ADR 0004's top `Isolation` rung,
  which nothing in this repository implements. **VERIFIED.**
- **But a microVM cannot attest ADR 0004's container vocabulary.** Seccomp is not mentioned in any
  Vercel Sandbox doc; capabilities are not mentioned; a process-count limit does not exist; and root
  with `sudo` is an advertised feature rather than a refusal. Those four properties are
  **unattestable by construction**, not merely unimplemented - three of them are things a dedicated
  kernel makes moot. A fifth, the **read-only root filesystem**, is genuinely absent rather than
  untranslatable. This is the finding that changes the plan.
- **A Sandbox outlives the Function that created it** and is reattachable from a later step - but
  **by `name`, not by id**. `@vercel/sandbox@3.3.0` has no sandbox `id` getter at all. **VERIFIED.**
- **Snapshots are filesystem-only.** Running processes do not survive a stop/resume; that is what
  `onResume` exists to repair. A Pass that spans Workflow steps must keep the Sandbox **running**,
  paying Provisioned Memory for the whole wall clock. **VERIFIED** (filesystem-only),
  **INFERRED** (the consequence).
- **The pinned Harness already has the seam ADR 0005 reserved.** `@ai-sdk/harness@1.0.102` ships
  `doDetach()` / `doSuspendTurn()` and `doStart({ resumeFrom | continueFrom })`, documented for
  cross-process resume, and `@ai-sdk/harness-codex@1.0.104` implements all four. Reprove calls none
  of them today. **VERIFIED.**
- **A Workflow step that overruns its duration is killed and silently retried** - *"no error will be
  visible in the Observability UI"* - three more times by default, with no backoff. Against a live,
  stateful Sandbox that is silent double-execution, and taking the default is choosing it.
  **VERIFIED.**
- **One 20-minute review at 2 vCPU costs $0.05-0.11 of Vercel infrastructure**, dominated by Active
  CPU rather than memory - the opposite of what the prior research concluded, because that document
  forgot to multiply Active CPU by the vCPU count. **VERIFIED** rates, **INFERRED** arithmetic.
- **Churn is real, asymmetric, and removals genuinely ship as patches.** The `@ai-sdk` harness family
  has published **137 patch releases and zero minor releases** since 1.0.0; within the last six weeks
  a patch deleted two public settings properties, another made an interface member mandatory, and a
  third reverted a default model. `@vercel/sandbox`, by contrast, is at **3.3.0** and versions its
  breaks correctly. **VERIFIED.** `@ai-sdk/sandbox-vercel` is self-labelled *experimental* and
  **hard-pins `@ai-sdk/harness` as an exact dependency** - adopting it forces a second copy of the
  Harness into the graph or drags the catalog with it.

---

## 1. Credential brokering

### 1.1 The platform mechanism

**VERIFIED.** Vercel Sandbox brokers credentials at the firewall, and says exactly what that buys:

> "Credentials brokering injects credentials into egressing traffic. The secrets never enter the
> sandbox, so code running inside it cannot exfiltrate them."
>
> "**Protect your credentials**: Untrusted code running within the sandbox cannot be trusted with
> credentials, but needs to authenticate to external services (e.g. AI Gateway)."
>
> <https://vercel.com/docs/sandbox/concepts/firewall>

The shape is a `transform` on an allowed domain. From the published type surface,
`@vercel/sandbox@3.3.0` `dist/network-policy.d.ts`, **VERIFIED**:

```ts
type NetworkPolicyRule = { match?: NetworkPolicyMatch } & (
  | { transform: NetworkTransformer[]; forwardURL?: never }
  | { transform?: never; forwardURL: string }
);
type NetworkTransformer = { headers?: Record<string, string> };
```

and in use:

```ts
networkPolicy: {
  allow: {
    'ai-gateway.vercel.sh': [
      { transform: [{ headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_TOKEN}` } }] },
    ],
  },
}
```

This is materially the same design as `packages/sandbox-container/src/proxy.ts`: terminate TLS at a
proxy outside the boundary, match the request, substitute the header. **VERIFIED** that the
mechanics match:

> "Only connections targeting domains with defined transformation rules are terminated in the proxy.
> A unique, per-sandbox CA is added to the system certificates."
> <https://vercel.com/docs/sandbox/concepts/firewall>

The CA lands at `/etc/pki/ca-trust/source/anchors/vercel-proxy-ca.pem` and
`/usr/local/share/ca-certificates/vercel-proxy-ca.pem`, with the usual dozen CA environment
variables (`NODE_EXTRA_CA_CERTS`, `PIP_CERT`, `REQUESTS_CA_BUNDLE`, ...) preset. **VERIFIED.**
Reprove's local proxy does the same thing with `openssl` and hands in only the public CA
(`packages/sandbox-container/README.md`).

**Vercel's AI Gateway is the documented keyless path to a model. VERIFIED:**

> "Model requests route through AI Gateway, while Vercel credentials authenticate the sandbox."
> <https://vercel.com/docs/sandbox/ecosystem>

### 1.2 Is it default-off, and what enforces it?

**Default-off, and nothing enforces it. VERIFIED, at three separate layers.**

1. **The platform.** A sandbox with no `networkPolicy` gets `allow-all` and no transforms. There is
   no account setting, project setting, or policy that makes brokering mandatory, and the ordinary
   `env` option on `Sandbox.create()` puts a real secret inside the microVM with no ceremony:
   *"`env`: Default environment variables for commands run in this sandbox."*
   <https://vercel.com/docs/sandbox/sdk-reference>. There is no secrets primitive, no vault, and no
   masking feature. **VERIFIED** (the `env` option), **VERIFIED as absent** (a mandatory-brokering
   control; searched the firewall, concepts, authentication and SDK-reference pages).

2. **The Harness.** Unchanged in substance from the 2026-08 finding, and re-read at the version this
   repository pins. `@ai-sdk/harness-codex@1.0.104` `src/codex-harness.ts:274-301` still gates
   brokering on a duck-typed capability check, and `:447` still falls through to forwarding the real
   key:

   ```ts
   if ('addRequestTransformations' in sandboxSession && sandboxSession.addRequestTransformations != null) {
     /* placeholder in, real key into the transformation */ credentialsBrokered = true;
   }
   ...
   if (!credentialsBrokered) { warnCredentialBrokeringUnavailable({ ... }); }
   ```

   **VERIFIED**, read from
   `node_modules/.pnpm/@ai-sdk+harness-codex@1.0.104_zod@4.5.4/.../src/codex-harness.ts`.

3. **The only signal is still a `console.warn`, and it got quieter in a patch.** At
   `@ai-sdk/harness@1.0.100` the changelog records *"fix(harness): avoid warning about lack of
   credential brokering support when `credentialForwarding` callback is used to replace all
   credentials with ephemeral fake secrets"*. At 1.0.102 the warning now fires only if a real
   credential substring actually survives into the forwarded environment
   (`src/utils/sandbox-credential-brokering.ts`, the `credentials.some(... forwardedCredential.includes(credential))`
   guard). **VERIFIED.** The change is defensible - it removes a false positive - but it means the
   sole failure signal is now itself conditional, which strengthens rather than weakens ADR 0004's
   decision to refuse instead of warn.

**INFERRED:** brokering on Vercel is default-off in exactly the sense ADR 0004 already anticipated,
and Reprove's answer does not change. The `credentialForwarding` guard in
`packages/adapters/src/brokered.ts` (*"a real credential would enter the Sandbox"*) and the
request-layer refusal in `packages/sandbox-container/src/broker.ts` are both provider-agnostic, and
both keep working against a Vercel-backed session because the check is on the value, not the
provider.

### 1.3 Two sharp edges specific to Vercel

**VERIFIED.** Under a catch-all `*` allow rule, *"connections without a detectable domain pass
through unmodified"* - so a wildcard policy silently disables brokering for anything that does not
present SNI. <https://vercel.com/docs/sandbox/concepts/firewall>

**VERIFIED**, and this one is not in any doc page - it is in the adapter's source
(`@ai-sdk/sandbox-vercel@1.0.110`, `src/vercel-network-policy-manager.ts:116-129`):

> `Vercel redacts transformed header values when a policy is read back.` ... `'Cannot add request
> transformations because the current Vercel Sandbox policy contains request transformations that
> cannot be attributed to this call. Their header values are redacted, so preserving them safely is
> not possible.'`

Injected secrets are write-only. A process that did not install a transform cannot preserve it while
adding another, so **any code path that resumes a sandbox and then modifies its policy must own the
full set of transforms**. **INFERRED:** for Reprove this argues for installing the complete
transform set once, at create time, from the step that holds the credential - not incrementally
across steps.

---

## 2. Network policy: granularity and default posture

### 2.1 Default posture is open

**VERIFIED.**

> "### `allow-all` - Default policy. This gives the sandbox unrestricted access to the public
> Internet."
> <https://vercel.com/docs/sandbox/concepts/firewall>

> "Sandboxes can make outbound HTTP requests by default, so you can install packages from public
> registries like npm or PyPI."
> <https://vercel.com/docs/sandbox/concepts>

Three modes: `allow-all`, `deny-all`, and an object form that is an allowlist. An empty object,
`{ allow: {} }`, or an object carrying only `subnets.deny` behaves as `deny-all`. **VERIFIED.**

### 2.2 Granularity: domain and CIDR only

**VERIFIED**, and this is the most consequential limitation in the document:

> "The firewall makes two separate decisions: 1. **Access**: the three lists above decide whether
> traffic gets through at all. 2. **Handling**: rules on an allowed domain decide what happens to the
> requests they match... A rule never changes whether a request is allowed."
>
> "**Matchers never block traffic.** To allow only certain paths on a domain, define a `forwardURL`
> rule without `match` for the domain and reject unwanted requests in your proxy"
>
> <https://vercel.com/docs/sandbox/concepts/firewall>

The access decision has exactly three dimensions - allowed domains, allowed CIDRs, denied CIDRs:

> "**Allowed domains**: Allow traffic by domain (for example, `api.example.com` or `*.example.com`)...
> **Allowed address ranges**: Allow traffic by CIDR range... **Denied address ranges**: Block traffic
> to specific CIDR ranges... Denied ranges take precedence over allowed domains and address ranges, but
> only remove access that an allow rule already granted."

Wildcards replace a whole DNS label; `api*.example.com` is not supported. **VERIFIED.**

The `match` object (`path`, `method`, `queryString`, `headers`, each `exact` / `startsWith` /
`regex`, RE2) exists **only to scope a `transform` or a `forwardURL`**. **VERIFIED** from the type
surface and from the doc text above.

| ADR 0004 requires | Vercel firewall | Tag |
| --- | --- | --- |
| restrict by **host** | yes, domain allowlist with whole-label wildcards | **VERIFIED** |
| restrict by **method** | **no** - `method` matchers select, never block | **VERIFIED** |
| restrict by **path** | **no** - `path` matchers select, never block | **VERIFIED** |
| "never `subnets.allow` with a broad range" | still correct; the docs themselves say it bypasses SNI filtering, brokering and proxying and leaves DNS unrestricted | **VERIFIED** |
| plain HTTP denied | plain HTTP cannot be filtered by domain at all | **VERIFIED** |
| domain fronting is real | *"a client inside the sandbox can send an allowlisted hostname as the SNI while sending a different hostname in the HTTP `Host` header... the firewall does not prevent the mismatch by default"* | **VERIFIED** |

**INFERRED, and load-bearing:** the only shape that satisfies ADR 0004's host-**and**-method-**and**-path
requirement on Vercel is a `forwardURL` rule pointing at a Reprove-operated HTTPS proxy, which does
the rejecting itself. Vercel supplies the authentication for that hop: forwarded requests carry
`vercel-forwarded-host/scheme/port/path` plus a `vercel-sandbox-oidc-token` whose `aud` is the
`forwardURL` and whose claims include `team_id`, `project_id`, `sandbox_id`, `sandbox_name`, and
`@vercel/sandbox/proxy` exports `defineSandboxProxy`, which *"automatically verifies the OIDC token
included in proxied requests"* and 403s otherwise. **VERIFIED**
(<https://vercel.com/docs/sandbox/concepts/firewall>, `@vercel/sandbox@3.3.0` `dist/proxy.d.ts`).

That is a real architectural difference from the local Sandbox: Reprove's proxy stops being a
loopback process attached to the container's pipes and becomes a **publicly reachable HTTPS
endpoint**, authenticated by a Vercel-issued OIDC token rather than by being unreachable.
**INFERRED.**

**VERIFIED, and a problem for `@ai-sdk/sandbox-vercel`:** that adapter parses and preserves
`forwardURL` rules but exposes **no public API to set them** (`src/vercel-network-policy-manager.ts`,
`ForwardRule`). Its only policy mutators are `setNetworkPolicy`, `setRequestTransformations` and
`addRequestTransformations`. So the ADR-0004-compliant egress shape is reachable only by driving
`@vercel/sandbox` directly.

### 2.3 Changeable after launch

**VERIFIED.** *"Policies can be updated on running sandboxes, allowing for incremental
restrictions."* The call is `await sandbox.update({ networkPolicy })`;
`sandbox.updateNetworkPolicy()` is deprecated; the REST form is
`POST /v2/sandboxes/sessions/{sessionId}/network-policy`.
<https://vercel.com/docs/sandbox/concepts/firewall>

**INFERRED:** this is exactly the primitive ADR 0004's phased egress needs - *"Network policy changes
live between phases"* - Install phase open to the configured registries, then narrowed to the
Provider endpoint before the Reviewer runs. It is one of the few places where the hosted path is
strictly easier than the local one, where `--network none` is all the container provider renders
today.

### 2.4 Ingress

**VERIFIED.** Up to 15 ports may be exposed (`ports?: number[]`), and `sandbox.domain(port)`
*"resolves a publicly accessible URL for a port you exposed during creation"*. The concepts page
warns: *"Exposed ports are accessible via a public URL, so be mindful of what services you run."*
`ports` is mutable via `sandbox.update({ ports })`, and the provided list is treated as the full
desired set.

**VERIFIED as absent:** no authentication, deployment protection, or signed-URL option on those URLs
appears on the SDK reference, concepts, or working-with-sandbox pages. Vercel's own guides put HTTP
basic auth in the user's own in-sandbox server.

**INFERRED:** Reprove should expose no ports at all. The Codex bridge needs a WebSocket, but
`@ai-sdk/harness` reaches it through `getPortEndpoint({ port, protocol: 'ws' })` on the sandbox
session, which the Vercel adapter implements - so port exposure is the provider's business and a
public URL is not obviously required. **UNVERIFIED** whether the Vercel adapter's `getPortEndpoint`
resolves to a public `sandbox.domain()` URL or to something narrower; if it is the public URL, an
unauthenticated bridge endpoint is a finding in its own right and must be checked before any hosted
Pass ships.

---

## 3. Lifetime, resources, and whether a Sandbox outlives its Function

All **VERIFIED** from <https://vercel.com/docs/sandbox/pricing> (page states `last_updated`
2026-09-02) unless noted.

| | Hobby | Pro | Enterprise |
| --- | --- | --- | --- |
| Max **session** duration | 45 minutes | 24 hours | 24 hours |
| Max vCPUs | 4 | 8 | 32 |
| Max memory | 8 GB | 16 GB | 64 GB |
| Max exposed ports | 15 | 15 | 15 |
| Disk | 64 GB | 64 GB | 64 GB |
| Concurrent sandboxes | 10 | 10,000 | 10,000 |

- Default timeout **5 minutes**, set with `timeout` (milliseconds) on create, extended at runtime
  with `sandbox.extendTimeout(duration)`. There is no `ttl` option; `timeout` is the only lifetime
  knob in the type surface. **VERIFIED.**
- **Memory is a fixed ratio.** *"Each vCPU includes 2 GB of memory."* You may provision 1, or an even
  number between 2 and 32; the default is 2 vCPUs. There is no independent memory dial.
  **VERIFIED.**
- **Disk:** *"automatically provisioned 64 GB of ephemeral NVMe storage"*; the deprecated
  `runtime`-based sandboxes get 32 GB. **VERIFIED.**
- **No process-count limit exists.** Searched the pricing, limits, concepts and SDK-reference pages
  and the whole `@vercel/sandbox@3.3.0` type surface. **VERIFIED as absent.**
- **Creation is rate-limited by a dynamic vCPU quota**, not a fixed cap: Hobby min 20 / ramp 20 / max
  40 vCPUs per minute; Pro and Enterprise min 150 / ramp 500 / max 5,000. *"After 10 minutes without
  creating sandboxes, the rate goes back to the starting rate."* Control-plane requests: 1,000 /
  10,000 / 100,000 per minute; deletions 20/second on every plan. **VERIFIED**
  <https://vercel.com/docs/limits>.

### 3.1 The cap is per session, not per sandbox

**VERIFIED**, verbatim:

> "The maximum duration applies to a single session, not to the sandbox itself. The limit resets
> every time a sandbox stops and resumes, so the total lifetime of a persistent sandbox is
> effectively unbounded."

**INFERRED:** a 20-minute review fits inside one Pro session with 23h40m to spare, and even inside
one *Hobby* session with 25 minutes to spare. Session length is not a design constraint for Reprove;
it would only become one for a review that needed to outlive 24 hours, which nothing plans.

### 3.2 A Sandbox outlives the Function that created it

**VERIFIED**, though the sentence that says it plainly is in a KB guide rather than the core docs:

> "When you create a sandbox, it continues running until it times out or you explicitly stop it."
> <https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox>

Corroborated in the docs by *"Later, in a separate process: resume the same sandbox by name"*
(<https://vercel.com/docs/sandbox/working-with-sandbox>).

**One counterweight worth recording**, same docs set: *"Sandboxes are not designed to run
continuously... not suitable for: Permanent hosting."* **VERIFIED.** Nothing Reprove wants is
permanent hosting, but a design that parks a Sandbox for hours between Passes is arguing with the
vendor's stated intent as well as with the memory bill.

---

## 4. Snapshot, reattach, and what they cost

### 4.1 Reattach is by name, and there is no id

**VERIFIED**, and this corrects the prior research. `@vercel/sandbox@3.3.0`:

```ts
interface GetSandboxParams {
  name: string;          // "The name of the sandbox."
  resume?: boolean;      // defaults false; a persistent sandbox auto-resumes on the first
                         // SDK call that needs a running session (such as runCommand)
  signal?: AbortSignal;
  onResume?: (sandbox: Sandbox) => Promise<void>;
}
static get(params: ...): Promise<Sandbox>;
```

The transport underneath is name-keyed too (`api-client.d.ts`: `getSandbox({ name, projectId, ... })`).
The `Sandbox` class exposes `get name(): string` and **has no `id` getter at all**; `sandboxId`
appears in the whole `dist` only inside a command serde payload and in `ProxyMeta`, and no API
accepts it. Vercel's own migration note says it outright:

> "Before (v1) `Sandbox.get({ sandboxId: 'sbx_123' })` -> After (v2) `Sandbox.get({ name: 'my-sandbox' })`"

**INFERRED:** the durable key a Workflow step must persist is a **name Reprove chooses** - the Pass
id is the obvious candidate, and it is already the identifier `packages/adapters/src/brokered.ts`
passes as `sessionId`. This is not a burden; it is strictly easier than recording a server-minted id.
It is also precisely what `@ai-sdk/harness` assumes: the `HarnessV1NetworkSandboxSession.id` doc
comment names the convention, **VERIFIED**:

> "Stable identifier for the underlying sandbox resource. Used by the harness session manager as the
> durable lookup key for cross-process resume... Providers populate it from their native identifier
> (Vercel: the sandbox name; just-bash: a UUID minted at create time)."

### 4.2 Snapshots exist, are the default, and are filesystem-only

**VERIFIED** <https://vercel.com/docs/sandbox/concepts/snapshots>,
<https://vercel.com/docs/sandbox/concepts/persistent-sandboxes>:

> "**Persistence is the default.** Every sandbox created with `Sandbox.create()` or `sandbox create`
> is persistent unless you explicitly opt out."

Opt out with `persistent: false` / `--non-persistent`. The API surface is
`sandbox.snapshot({ expiration })`, `sandbox.stop()` (which returns snapshot metadata),
`Sandbox.create({ source: { type: 'snapshot', snapshotId } })`, `Sandbox.fork({ sourceSandbox })`,
`Snapshot.get/list/tree/delete`. **VERIFIED.**

**The material caveat, and the one that decides Reprove's shape: a snapshot captures the
filesystem, not the VM.** The docs say *"the SDK automatically snapshots its **filesystem**"*, and
the `onResume` hook exists precisely because processes do not survive: *"Use it to restart background
services or rehydrate caches."* **VERIFIED** (the filesystem wording and the `onResume` guidance);
**INFERRED** (that a running Codex process and its bridge therefore die on stop).

**INFERRED, and this is the design consequence:** there is no freeze-and-thaw. A Pass that spans
Workflow steps either
 (a) keeps the Sandbox **running** between steps - paying Provisioned Memory for the whole wall clock
     and re-attaching to a live bridge; or
 (b) stops it and re-provisions the process tree on resume, which for Codex means restarting the
     model turn, not continuing it.
Only (a) is compatible with a single 20-minute review. §6 turns this into a step plan.

### 4.3 What a snapshot costs, in time and in money

**Money: VERIFIED.** Snapshot Storage is **$0.08/GB-month**, with 15 GB lifetime included on Hobby.
Default expiry is 30 days after last use, tunable with `snapshotExpiration` and `keepLastSnapshots`
(`count` 1-10). Snapshots are region-pinned (`snapshot_region_mismatch`). And the residue rule
matters for teardown hygiene: *"Deleting a sandbox removes the sandbox and its sessions, but its
snapshots stay available until they expire or you delete them, and they keep incurring storage
charges in the meantime."* `delete({ deleteOrphanSnapshots: true })` is the lever.

**Time: UNVERIFIED in the docs.** No documentation page states a snapshot or resume latency. The
docs say only *"Resuming from a snapshot is even faster than starting a fresh sandbox"* and
*"Sandboxes start in milliseconds (Firecracker optimized for fast boot)"*. The only first-party
numbers are in a blog post five months old: *"p75 dropped from 40s to sub-second"*, p95 *"from 50s to
under 10s"* (<https://vercel.com/blog/optimizing-vercel-sandbox-snapshots>, 2026-04-02) -
**VERIFIED as a blog claim, not as a documented SLO.** Separately, the reconnect KB guide lists
*"Reconnect with `Sandbox.get()` | ~0.3s"*, which is reattaching to an **already-running** sandbox
and is not the same measurement. Do not conflate the two.

**INFERRED:** budget a resume as "sub-second typically, up to ten seconds at the tail" and do not
build a design whose correctness depends on it. Reattaching to a *running* sandbox at ~0.3s is the
number the recommended shape actually depends on.

---

## 5. The pinned Codex stack inside a Vercel Sandbox

### 5.1 What Reprove pins today

Read from this repository, **VERIFIED**:

| Thing | Pin | Source |
| --- | --- | --- |
| Codex CLI + SDK | `0.153.4` | `packages/adapters/src/bootstrap.ts` (`CODEX_CLI_VERSION`) |
| Harness core | `@ai-sdk/harness` **1.0.102** | `pnpm-workspace.yaml` `catalogs.harness` |
| Codex bridge | `@ai-sdk/harness-codex` **1.0.104** | same |
| Workflow | `workflow` **4.8.5**, `@workflow/world-postgres` 4.3.5, `@workflow/vitest` 4.0.21 | same |
| Image | `node:22.19.0-bookworm-slim` (digest-pinned), pnpm 11.25.0 | `packages/adapters/src/image.ts` |
| Sandbox profile | 2 vCPU, 4 GiB, 512 processes, read-only root + tmpfs scratch | `packages/worker-core/src/sandbox.ts` |
| `@vercel/sandbox` / `@ai-sdk/sandbox-vercel` | **not installed at all** | `pnpm-lock.yaml` (zero matches) |

Note the Node discrepancy, **VERIFIED**: Reprove's own packages declare `engines.node >= 24`, but the
Codex image is built on Node **22.19.0** because that is what the bridge and the Codex SDK require
(`@ai-sdk/harness@1.0.102` and `@ai-sdk/harness-codex@1.0.104` both declare `engines.node >= 22`;
`@openai/codex-sdk@0.153.4` declares `>= 18`).

### 5.2 Can the stack run inside a Vercel Sandbox?

**Node 24: yes. VERIFIED.** The image catalogue is `vercel/sandbox/universal:latest` (Node 24 LTS +
Python 3.14 + coding agents), `vercel/sandbox/node:22|24|26`, `vercel/sandbox/python:3.14`,
`vercel/sandbox/ubuntu:latest` (Ubuntu 26.04), `vercel/sandbox/arch:latest`. The `runtime` option
(`'node24'`, `'node22'`, ...) is **deprecated** in favour of `image`.
<https://vercel.com/docs/sandbox/concepts/images>

**Installing the bridge and the CLI: yes, and the bytes are free. VERIFIED.** Outbound HTTP is on by
default, npm installs work, and *"Data your sandbox downloads from the internet, such as packages,
Git repositories, artifacts, and datasets, is free."* Root and `sudo` are available
(`runCommand({ sudo: true })`), so apt and global installs work.

**Custom OCI images: supported, with a trap. VERIFIED.** Custom images are pulled from the Vercel
Container Registry, and *"Vercel Sandbox does not run Docker `ENTRYPOINT` or `CMD` for custom
images."* **INFERRED:** Reprove's existing `Dockerfile` in `packages/adapters/src/image.ts` is
therefore *mostly* portable - the `CMD ["node","-e","setInterval(...)"]` keep-alive is the one line
that does nothing on Vercel, and it is unnecessary there anyway because a Vercel Sandbox stays up on
its own `timeout` rather than on a held-open PID 1.

**`createUser` / `asUser`: present, and weaker than it sounds. VERIFIED.**

```ts
createUser(username: string, opts?): Promise<SandboxUser>;
asUser(username: 'root' | (string & {})): SandboxUser;
createGroup(groupname: string, opts?): Promise<{ groupname: string; sharedDir: string }>;
```

*"Call `sandbox.createUser()` to add a Linux user with an isolated home directory. Each user gets
`/bin/bash` as their login shell and a home directory at `/home/<username>`."* Usernames are
validated against `/^[a-z_][a-z0-9_-]*$/`, *"which prevents command injection through a crafted
name."* **Multi-user support is JS-SDK-only.**
<https://vercel.com/docs/sandbox/concepts/multi-agent>

The implementation is cooperative Unix permissions, not a second boundary, and the package says so -
`@vercel/sandbox@3.3.0` `dist/sandbox-user.d.ts` describes *"the wrapped command args to run as this
user via `sudo -u`"*, and the README states: *"**The SDK can read all users' files** because home
directories are group-owned by the sandbox's default user group."* **VERIFIED.** That is close to
what ADR 0012's two in-container identities need and it is not the same as a privilege boundary;
`packages/sandbox-container`'s protected-write scheme (root-owned direct children of
`/reprove/input`, ancestor-ownership checks) has no Vercel equivalent and would have to be rebuilt on
top of `sudo`.

**Read-only root filesystem: not offered. VERIFIED as absent.** No page documents a read-only-root
mode, and no such option exists in the `@vercel/sandbox@3.3.0` type surface (searched
`rootfs|read-only|readOnlyRoot|immutable`; the only hits are per-*Drive* mount modes,
`SandboxMountMode = 'read-write' | 'snapshot'`). The platform's posture is the opposite of ADR
0004's: *"Provides full root access to install any package or binary"*, and Docker-in-sandbox, VPN
clients and FUSE are explicitly supported workloads.

### 5.3 Scoring against ADR 0004's property table

The table in `packages/sandbox-container/README.md` has three columns - request check, argument
audit, attestation - because a container is inspectable. A microVM is not inspectable in that
vocabulary at all. The honest scoring:

| ADR 0004 property | Vercel Sandbox | Tag |
| --- | --- | --- |
| Its own network namespace | Yes, and stronger: *"Each sandbox has its own network namespace"*, inside a microVM with its own kernel | **VERIFIED** |
| Its own PID namespace | Subsumed: *"Process isolation: Kernel-level isolation"*, a dedicated kernel per sandbox. No namespace field to read back | **VERIFIED** as satisfied, **unattestable** as stated |
| Its own mount namespace, **read-only root** | Private filesystem yes; **read-only root not offered** | **VERIFIED as absent** |
| Not privileged | Not representable. Root and `sudo` are advertised features | **cannot attest** |
| No added capabilities | Never mentioned in any doc; the platform advertises system-level privileges inside the microVM | **cannot attest** |
| No container-runtime socket | No host socket is reachable. A sandbox may run its *own* Docker, which is a different thing | **VERIFIED** as satisfied |
| No host bind mount | No host bind mounts exist; the only mounts are Vercel-managed Drives | **VERIFIED** |
| Seccomp enabled, never `unconfined` | **Not mentioned anywhere in the Vercel Sandbox documentation.** The microVM replaces the threat model it addressed | **VERIFIED as absent** |
| CPU, memory **and process** limits | vCPU settable; memory fixed at 2 GB/vCPU and not independently settable; **no process-count limit exists** | **partial**; process limit **VERIFIED as absent** |
| Ephemeral, sandbox-owned Workspace | 64 GB ephemeral NVMe, private per sandbox | **VERIFIED** |
| No credential in a brokered Sandbox | Achievable and first-class (§1), but enforced only by the caller | **VERIFIED** mechanism, **no platform enforcement** |
| The host has not drifted | No host to fingerprint and no equivalent read-back. `Sandbox.list()` returns the network policy shape, nothing about the enforcing host | **UNVERIFIED / not applicable** |
| Local capability not quarantined | Not applicable - there is no local runtime to quarantine | n/a |
| Teardown leaves no residue | `stop()` / `delete()` exist and are checkable, **but snapshots survive deletion and keep billing** unless `deleteOrphanSnapshots` is passed | **VERIFIED**, residue is by design |

**INFERRED, and this is the headline:** ADR 0004 says a Sandbox is *"defined by properties, not by a
technology"*, and then names its properties in one technology's vocabulary. Four of them - no
privilege, no added capabilities, seccomp, and a process-count limit - have **no Vercel answer at
all**, and three of those four are things a microVM makes moot rather than things it fails. ADR 0004
says *"a missing hard requirement is a refusal"*, and `packages/sandbox-container/README.md` sharpens
it to *"a missing one is a Refusal, never a narrowing and never a log line."* Applied literally,
**a Vercel Sandbox is refused by Reprove's own contract**, while being a strictly stronger boundary
than the container it would replace. That is a defect in the contract's expression, not a verdict on
Vercel, and §10 says what to do about it.

The one genuinely missing property, as opposed to untranslatable, is the **read-only root
filesystem** - Vercel simply does not offer it, and the mitigation ADR 0004 bought with it (an image
`VOLUME` directive cannot smuggle in writable executable storage) has no hosted equivalent.

### 5.4 What a Vercel Sandbox buys that the local one cannot

**VERIFIED** <https://vercel.com/docs/sandbox/concepts>:

> "Unlike Docker containers, each sandbox runs in its own Firecracker microVM with a dedicated
> kernel. This provides stronger isolation than container-based solutions, which makes sandboxes
> ideal for running untrusted code."

Vercel's own comparison table: Docker *"Shares host kernel; relies on namespaces and cgroups"* /
*"container escapes are possible"*, versus Sandboxes *"Dedicated kernel per sandbox; full VM
isolation"* / *"microVM boundary prevents escapes"*. Infrastructure is SOC 2 Type II; 19 regions,
default `iad1`.

**INFERRED:** this is ADR 0004's `microvm` rung, the one `packages/worker-core/src/dispatch.ts`
deliberately left in the `IsolationLevel` union with nothing implementing it. On the Brokered Route
(`Exposure: none`), `microvm` unlocks `internal` **and** `external` Provenance with no opt-in - the
top-left cell of ADR 0004's dispatch matrix. **That is the strategic reason the hosted Pass exists:
it is the only configuration in which Reprove can review a pull request from an untrusted fork
without an opt-in.**

---

## 6. The Workflow step that drives the Adapter

### 6.1 Step duration is the Function ceiling

**VERIFIED** <https://vercel.com/docs/workflows/pricing>: *"Max runtime of individual step | see
Vercel Functions limits."* And **VERIFIED**
<https://vercel.com/docs/functions/configuring-functions/duration> (fluid compute):

| Plan | Default | Maximum | Extended maximum |
| --- | --- | --- | --- |
| Hobby | 300s | 300s | - |
| Pro | 300s | **800s** | **1800s (Beta)** |
| Enterprise | 300s | **800s** | **1800s (Beta)** |

> "The 800 second maximum is generally available for Pro and Enterprise teams. The 1800 second
> extended maximum is in beta."

For workflow steps specifically there is an extra gate, **VERIFIED**
<https://vercel.com/changelog/workflow-steps-now-support-extended-function-durations> (2026-07-24):
*"Workflow steps on Pro and Enterprise plans can now run for up to 30 minutes (1800 seconds), up from
800 seconds, using extended function durations (in beta)"* - and it requires setting
`VERCEL_ENABLE_WORKFLOW_EXTENDED_MAX_DURATION` to `1`, a workflow-specific environment variable
distinct from the ordinary `maxDuration` path.

**A step is not reliably its own invocation, and that changes the arithmetic. VERIFIED**, from the
docs the `workflow` package ships (`docs/foundations/workflows-and-steps`, read at
`workflow@5.0.0-beta.51`):

> "The step usually executes inline in the same invocation; when the invocation's inline budget is
> exhausted or its timeout approaches, the step is handed to the queue and the workflow resumes in a
> later invocation."

Up to three newly-created steps run inline inside the invocation already replaying the workflow
(`WORKFLOW_MAX_INLINE_STEPS`, default `3`, clamp `1`-`16`), and the inline budget itself is derived
from the runtime deadline: `WORKFLOW_V2_TIMEOUT_MS` is *"`600000` when the invocation has 25 minutes
or more left, `300000` when it has 10 minutes or more, and `120000` otherwise"*. **VERIFIED**
(`docs/configuration/runtime-tuning`). **INFERRED:** at the GA 800-second ceiling the inline budget
is 300s, so a multi-minute slice step will be pushed to the queue and get a fresh invocation with
the full ceiling - which is what you want, but it means a slice's real budget depends on a
configuration value nobody set deliberately.

**Blowing a step's budget is a silent duplicate execution, not a clean error. VERIFIED**, verbatim
(`docs/errors/step-executed-multiple-times`):

> "**Function timeouts**: if your step code runs longer than the configured maximum function
> duration, it will be killed... The step will be re-tried according to your retry policy in this case,
> but no error will be visible in the Observability UI."

Default retry policy is **3 retries (4 attempts total), enqueued immediately with no backoff**;
`maxRetries` is set as a property on the step function. **VERIFIED**
(`docs/foundations/errors-and-retries`). **INFERRED, and this is a real hazard for Reprove:** a slice
step that overruns is killed and silently re-run against a **live, stateful Sandbox** up to three more
times. The mitigation Workflow itself documents is the stable `stepId`: *"Every step invocation has a
stable `stepId` that stays the same across retries... Use it as the idempotency key"* - so a slice step
must be idempotent against the sandbox, and the harness cursor from `doSuspendTurn` is the natural
idempotency token. Setting `maxRetries = 0` on the drive step and letting ADR 0015's lifecycle own the
retry decision is the alternative worth weighing.

### 6.2 Run limits: "no limit" has teeth behind it

**VERIFIED**, the run-limits table at <https://vercel.com/docs/workflows/pricing>:

| Limit | Value |
| --- | --- |
| Maximum run duration | No limit |
| Maximum `sleep` duration | No limit |
| Steps per run | 10,000 |
| Events per run | 25,000 |
| Max payload size | 50 MB (any run/step/hook input or output; streams are excluded and bounded separately) |
| Maximum total entity storage per run | 2 GB |
| **Max workflow replay duration** | **240s** |
| Max runtime of individual step | see Vercel Functions limits |

The 240-second replay budget is the one the prior research missed: *"If a workflow orchestration
attempt takes longer than 240 seconds, due to memory pressure, a large amount of events, or complex
code within your workflow functions, the run may be aborted."* It excludes time inside inline
`'use step'` bodies. **VERIFIED.**

Three more facts from the same page, all **VERIFIED**: a step costs about three events
(`step_created`, `step_started`, `step_completed`, plus `step_retrying` per retry); exceeding the
event ceiling is the named terminal failure `MAX_EVENTS_EXCEEDED`; and there is a soft cliff well
below the hard cap - *"Runs that exceed 2,000 events or 1 GB of total entity storage have slower
replay times. To maintain high performance, we recommend creating child workflows to break
long-running workflows into smaller pieces."* Completed-run data retention is **Hobby 1 day, Pro 7
days, Enterprise 30 days**, and *"Storage retention is not configurable by default"* - which matters
because ADR 0014 puts a Run's plaintext execution token in the World's storage for the life of the
durable run.

**INFERRED:** none of these bind a single review - a Pass is tens of steps, not thousands - but the
25,000-events-per-run cap and the 240s replay budget both scale with **how chatty the orchestration
is**, and a per-minute watchdog poll across a 24-hour ceiling is the kind of design that would find
them. Reprove's `runLifecycle` already sleeps toward deadlines rather than polling on a fixed tick
(ADR 0015), which is the right shape for reasons that now include this.

**One operational fact worth carrying into the hosted design, VERIFIED**
(<https://vercel.com/docs/workflows/concepts>, Skew Protection): a run stays pinned to the deployment
that started it, and *"a rollback does not stop runs on the deployment you rolled back from. A run
whose steps keep failing on that deployment is retried there, and each retry is a function invocation
on it, until the run fails or is cancelled."* **INFERRED:** a long-lived hosted Pass therefore holds a
deployment alive, and a bad deploy cannot be rolled away from mid-review.

### 6.3 Durable sleep, and what it does to a live Sandbox

**VERIFIED:** *"Sleep pauses a workflow for a specified duration without consuming compute
resources"* (<https://vercel.com/docs/workflows/concepts>), and the function instance behind it is
torn down: *"After all requests complete, the instance is paused, and no CPU or memory charges apply
until the next invocation"* (<https://vercel.com/docs/functions/usage-and-pricing>).

**But sleep is not free.** *"Every state transition in a workflow run is persisted as an event"*, so
each sleep costs Workflow Events plus Data Written and Data Retained. **VERIFIED.** State it that
way: **no compute is billed during sleep; events and storage still are.**

**INFERRED, and it is the crux of the hosted Pass:** durable sleep suspends the *orchestrator*, and a
Vercel Sandbox's `timeout` keeps running while it sleeps. Those two clocks are independent, and
nothing reconciles them for you. A workflow that sleeps 20 minutes toward a deadline while a Sandbox
bills Provisioned Memory has not saved money - it has moved the bill from Functions to Sandbox, where
memory is twice the rate ($0.0212 vs $0.0106 per GB-hour, **VERIFIED**). What sleep buys is
*durability and resumability*, not cost.

### 6.4 Bounding a wait, and the trap in it

**VERIFIED.** Hooks and webhooks have **no documented maximum wait**: `HookOptions` in
`@workflow/core` carries exactly `token`, `experimental_minRetention`, `metadata`, `isWebhook` - no
timeout - and the only stated bound is the run-limits table's "No limit". The documented way to bound
one is `Promise.race` with `sleep`, and it is a first-party cookbook entry
(`workflow` docs, `cookbook/common-patterns/timeouts`): *"Use `Promise.race` with `sleep()` to bound
the time any step, hook, or webhook is allowed to take, and recover gracefully when the deadline
fires first."* Determinism holds under replay because both branches are event-log-backed. This
**resolves** the prior research's open question about whether racing a webhook against a sleep is
supported: it is, and it is documented.

**The trap, VERIFIED verbatim:** *"**The losing operation keeps running.** `Promise.race` doesn't
cancel: when the sleep wins, the underlying step (or model call, or HTTP request) continues to
completion in the background."* And cancellation is cooperative: *"Aborting a signal doesn't
forcefully kill a step."*

**INFERRED:** for Reprove the losing operation is a **live Sandbox burning memory**. A watchdog that
fires must therefore do more than return - it must reattach by name and `stop()`. ADR 0015 already
records that *"a cancelled pass is not a torn-down Sandbox"*; on Vercel that gap has a per-minute
price attached to it.

### 6.5 The seam ADR 0005 reserved already exists upstream

**VERIFIED**, read from the exact artifact this repository installs
(`@ai-sdk/harness@1.0.102`, `src/v1/harness-v1-session.ts`):

```ts
/** Detach from the underlying runtime without tearing it down, returning a payload the host can
 *  later pass to `HarnessV1.doStart({ resumeFrom })` to reconnect before a new turn. ...
 *  Required. Adapters that cannot keep a live runtime parked still return the best resume session
 *  state they can while leaving the sandbox running. */
doDetach(): PromiseLike<HarnessV1ResumeSessionState>;

/** ... the cursor in the returned state equals the last event delivered to the host - guaranteeing
 *  the next slice's attach replays with no gap and no duplicate. ... Required on every adapter. */
doSuspendTurn(): PromiseLike<HarnessV1ContinueTurnState>;
```

`doDetach` is a between-turn handoff; `doSuspendTurn` slices an **active turn** at a slice boundary.
Both leave the sandbox running. `@ai-sdk/harness-codex@1.0.104` implements `doDetach`,
`doSuspendTurn`, `doStop` and `doDestroy` (`src/codex-harness.ts:1102, 1256, 1168, 1135`), and
reconnects by opening a WebSocket to the surviving in-sandbox bridge, falling back to a re-spawn if
the bridge is gone. **VERIFIED.**

**VERIFIED that Reprove uses none of this today**: a repository-wide grep for
`doDetach|doSuspendTurn|resumeFrom|continueFrom` across `packages/` returns nothing.
`packages/adapters/src/brokered.ts` calls `doStart` and runs the Pass to completion in one process.

**INFERRED:** this is exactly ADR 0005's reserved surface - *"Session creation, `detach`/`resume`,
the bounded repair turn, and reattachment across Vercel Workflow step boundaries all stay inside"* -
and it means a 20-minute Pass can be sliced under the **800s GA** ceiling without depending on the
1800s beta. The recommended shape:

```
passWorkflow ('use workflow')
  step provisionSandbox     Sandbox.create({ name: passId, timeout, networkPolicy: install-phase })
                            -> record the name; nothing else durable is needed
  step narrowEgress         sandbox.update({ networkPolicy: pass-phase + transforms })
  loop, bounded by the Run's executionExpiresAt:
    step driveSlice         Sandbox.get({ name: passId })
                            harness.doStart({ continueFrom })  ... 10 minutes of turn ...
                            harness.doSuspendTurn()  -> return the cursor (well under the 50 MB cap)
  step collectAndValidate   read the Result outside the boundary (ADR 0004)
  step teardown             sandbox.delete({ deleteOrphanSnapshots: true })
```

Each slice should target **five to eight minutes**, not the full 800s: the ceiling is a kill, not a
signal (§6.1), and the margin is what keeps a slow model turn from becoming a silent retry against a
live Sandbox. The Sandbox stays running across the seam, which costs memory but is the only thing a
filesystem-only snapshot permits; and a crashed or redeployed step resumes at the last cursor rather
than restarting the review. **UNVERIFIED:** whether `doSuspendTurn`'s returned state round-trips
cleanly through Workflow's serde and back into a *different* process's `doStart({ continueFrom })`
against a *reattached* sandbox session. That is the one spike to run before committing, and it is a
half-day, not a redesign.

### 6.6 Vercel's own Sandbox-in-Workflow pattern, and why Reprove cannot use it

**VERIFIED**, from the cookbook the `workflow` package ships
(`docs/cookbook/integrations/sandbox`, read at `workflow@5.0.0-beta.51`):

> "The `@vercel/sandbox` package has first-class support for the Workflow SDK: the `Sandbox` class is
> serializable, and its methods (`create`, `runCommand`, `stop`, `snapshot`) implicitly run as steps.
> You can use `Sandbox` directly inside a workflow function without wrapping each call in a separate
> `"use step"` function."
>
> "Each sandbox method is an implicit step, so the event log records every command and the workflow
> replays from the last completed call on restart."

The documented pattern owns one VM across the run's lifetime, hibernates it with `snapshot()` during
`sleep()`, and rotates it before its session cap. It also names the pinning cost: *"An effectively
unbounded sandbox session is still one workflow run, so it stays on the deployment that started it."*

**INFERRED, and it is a clean "no" for Reprove:** ADR 0014 exists because a `'use workflow'` body is
inlined into a bundle that runs in a VM with **no `require`**, and
`tools/verify-workflow-build.mjs` asserts that the emitted bundle names no `@reprove/*` and no
`@ai-sdk/*` module. Calling `Sandbox` methods from a workflow body would pull `@vercel/sandbox` into
exactly that bundle. Reprove's Sandbox work must stay inside `'use step'` bodies, which means
ordinary explicit steps and an explicitly persisted sandbox `name` - not the implicit-step
convenience. The cookbook is still valuable as confirmation that Vercel expects a Sandbox to span a
workflow run; Reprove just has to spell the pattern out.

**A first-party contradiction worth recording, UNRESOLVED.** The cookbook describes rotating the VM
before a **five-hour** hard cap. The pricing page states the session maximum as **24 hours** on Pro
and Enterprise. Both are Vercel sources read on the same day. Nothing Reprove plans runs long enough
for the difference to matter, but a design that assumed 24 hours would be resting on the more
generous of two conflicting first-party numbers.

---

## 7. Cost of a 20-minute review

Rates are **VERIFIED** for the default `iad1` region on Pro (<https://vercel.com/docs/sandbox/pricing>,
<https://vercel.com/docs/workflows/pricing>, <https://vercel.com/docs/functions/usage-and-pricing>).
Regional rates differ and the pricing page's region selector does not render to a fetcher, so `iad1`
is the only readable table.

| Dimension | Hobby included | Pro rate (iad1) |
| --- | --- | --- |
| Sandbox Active CPU | 5 hours/month | **$0.128 per CPU-hour** |
| Sandbox Provisioned Memory | 420 GB-hours/month | **$0.0212 per GB-hour** (1-minute minimum increments) |
| Sandbox Creations | 5,000/month | $0.60 per 1M |
| Sandbox Data Transfer (egress) | 20 GB/month | $0.15/GB |
| Snapshot Storage | 15 GB lifetime | $0.08 per GB-month |
| Workflow Events | 50,000/month | **$0.02 per 1K events** |
| Workflow Data Written | 1 GB | $0.50/GB |
| Workflow Data Retained | - | $0.50 per GB-month |
| Function Active CPU | 4 hours/month | $0.128 per CPU-hour |
| Function Provisioned Memory | 360 GB-hours/month | $0.0106 per GB-hour |

Two definitional facts, both **VERIFIED**:

- **Active CPU excludes I/O wait.** *"Time spent waiting for I/O (such as network requests, database
  queries, or AI model calls) does not count toward Active CPU."*
- **Inbound data is free.** *"Data your sandbox downloads from the internet, such as packages, Git
  repositories, artifacts, and datasets, is free."* Only what the sandbox sends, plus all traffic on
  exposed ports, is billable.

### 7.1 The unit that matters

**VERIFIED, and this is where the prior research went wrong.** Active CPU is billed per **CPU-hour**,
so it scales with the vCPU count, not with wall clock alone. Two of Vercel's own published example
rows pin the model down exactly:

- *"AI code validation | 5 min | 2 vCPU | 4 GB | $0.02 | $0.007 | ~$0.03"* -
  CPU `2 x (5/60) x 0.128 = $0.0213`; memory `4 x (5/60) x 0.0212 = $0.0071`. Matches.
- *"Build and test | 30 min | 4 vCPUs | 8 GB | ~$0.34"* (stated at 100% utilization) -
  CPU `4 x 0.5 x 0.128 = $0.256`; memory `8 x 0.5 x 0.0212 = $0.0848`; total `$0.3408`. Matches.

### 7.2 A 20-minute review

**INFERRED** - arithmetic over verified rates. Reprove's `CODEX_SANDBOX_PROFILE` asks for **2 vCPU
and 4 GiB**, which is exactly one Vercel step (memory is fixed at 2 GB/vCPU), so the 2-vCPU row is
the live one.

Provisioned Memory is wall-clock and does not vary with utilization:
`4 GB x (20/60) h x $0.0212 = $0.02827`.

| CPU busy | Active CPU (2 vCPU) | + memory | Sandbox total |
| --- | --- | --- | --- |
| 30% | $0.0256 | $0.0283 | **$0.0539** |
| 40% | $0.0341 | $0.0283 | **$0.0624** |
| 50% | $0.0427 | $0.0283 | **$0.0709** |
| 100% | $0.0853 | $0.0283 | **$0.1136** |

At 4 vCPU / 8 GB the same review is **$0.108 (30%) to $0.227 (100%)**.

Orchestration on top, **INFERRED** at roughly 300 events for a sliced Pass with a watchdog:
`300 x $0.02/1K = $0.006`, plus a few tenths of a cent of step compute and negligible Data
Written/Retained. Creation, ingress and the findings payload round to zero.

**Call it $0.06-0.08 per 20-minute review at 2 vCPU, and $0.12-0.15 at 4 vCPU.** The Pro plan's
$20/month credit covers roughly 250-330 reviews at the 2-vCPU figure before on-demand billing
starts (**VERIFIED** that the credit exists and Sandbox usage draws on it; the division is
**INFERRED**).

### 7.3 What the corrected model changes

**INFERRED:**

- **CPU, not memory, is the dominant term** once you count it per-vCPU: 47-75% of the sandbox bill at
  2 vCPU. The prior research's conclusion that *"memory is the dominant term... the levers that matter
  are wall-clock duration and vCPU size, not CPU efficiency"* is **half right for the wrong reason**.
  vCPU size is still the biggest lever - it now scales *both* terms - but CPU efficiency is no longer
  irrelevant.
- **Slicing a Pass across Workflow steps is nearly free in CPU and not free in memory.** Idle
  between-slice time costs $0.0212/GB-hour and no CPU. A 20-minute review with five minutes of
  between-slice idle costs an extra $0.007. That is cheap enough that the slice boundary should be
  chosen for durability, not for cost.
- **A Sandbox left to hit its timeout is the expensive failure.** At 2 vCPU a forgotten sandbox costs
  ~$0.085/hour in memory alone even with zero CPU. Vercel says the same: *"Stop sandboxes promptly:
  call `sandbox.stop()` when done rather than waiting for timeout."* On Pro the timeout ceiling is
  24 hours, so a leaked sandbox is a ~$2 mistake, not a ~$0.05 one.
- **LLM tokens still dominate.** A 20-minute agentic review is plausibly dollars of model spend
  against $0.07 of compute. Hosted-mode unit economics remain a model-cost question.

---

## 8. Churn since the 2026-08 research

Version and date evidence is **VERIFIED** from the npm registry (`npm view <pkg> time --json`,
fetched 2026-09-14) and from `CHANGELOG.md` inside the published tarballs.

| Package | 2026-08-28/29 reading | Today (2026-09-14) | Stable releases since 2026-08-01 |
| --- | --- | --- | --- |
| `@vercel/sandbox` | not recorded | **3.3.0** (`3.4.0-beta.0` on `beta`) | **7** stable + 6 prereleases; `3.0.0` on 08-07 |
| `@ai-sdk/sandbox-vercel` | 1.0.93 | **1.0.110**, published 2026-09-14 | **52** |
| `@ai-sdk/harness` | 1.0.93 | **1.0.110** upstream; this repo pins **1.0.102** | **52** |
| `@ai-sdk/harness-codex` | 1.0.95 | **1.0.112** upstream; this repo pins **1.0.104** | **52** |
| `workflow` | 4.8.5 (pinned) | **4.8.8** latest; `5.0.0-beta.51` on `beta` | **8** stable + 12 prereleases |

**VERIFIED, and it reframes the risk:**

- **`@vercel/sandbox` is not a 0.x package.** 113 published versions, `latest: 3.3.0`,
  `beta: 3.4.0-beta.0`, and it left 0.x on 2025-10-16. It ships roughly weekly and has taken two
  majors in four months (`2.0.0` 2026-05-22, `3.0.0` 2026-08-07), so it *does* make breaking changes -
  but it signals them in the version number. The v1->v2 `Sandbox.get({ sandboxId })` ->
  `Sandbox.get({ name })` change is exactly such a signalled break, and it is the one that
  invalidated the prior research's code sample.
- **`@ai-sdk/sandbox-vercel` is the opposite.** It self-describes as *"This package is
  **experimental**"* in its own README - as does `@ai-sdk/harness` itself - has published 52 stable
  versions in six weeks (about one per weekday), and every one of them is a patch. Its version number
  tracks the AI SDK monorepo rather than its own API.
- **It hard-pins the Harness as an ordinary dependency, not a peer. VERIFIED**
  (`npm view @ai-sdk/sandbox-vercel@latest dependencies`, 2026-09-14):

  ```
  dependencies = {
    '@ai-sdk/harness': '1.0.110',
    '@vercel/sandbox': '^2.0.1 || ^3.0.0',
    '@ai-sdk/provider-utils': '5.0.40'
  }
  ```

  **INFERRED, and it is worse than a lockstep bump:** because the pin is exact and the edge is a
  dependency rather than a peer, installing this package under pnpm's strict layout resolves a
  **second copy** of `@ai-sdk/harness` beside the catalog's 1.0.102. The session interfaces are
  structural, so much of it would work by accident; anything relying on module identity would not,
  and `packages/adapters/src/fingerprint.ts` already fingerprints the resolved
  `@ai-sdk/harness` directory, so two copies is a change it would see. The only clean adoptions are
  moving the `harness` catalog to whatever `@ai-sdk/sandbox-vercel` pins that week - on a package
  that ships every weekday - or not adopting it. That is a direct cost against ADR 0014's principle
  that a pinned dependency bump is *"a reviewed change"*.
- **`workflow` is GA on 4.x and pre-releasing a major.** *"Today, Vercel Workflows is generally
  available"* (<https://vercel.com/blog/a-new-programming-model-for-durable-execution>, 2026-04-16).
  `latest` is **4.8.8**; `5.0.0` has been in beta for 51 pre-releases. This repository pins **4.8.5**
  (2026-08-25), three patch releases behind. **INFERRED:** that is a comfortable position and ADR
  0014's reviewed-bump rule is doing its job - but note that the SDK's *own* bundled documentation,
  which is the best primary source for its semantics, ships on the v5 beta line, so several
  behaviours quoted in §6 are documented against `5.0.0-beta.51` rather than against the pinned
  4.8.5. Multi-region run state explicitly *"requires `workflow` version `5.0.0-beta.33` or later"*,
  so at least one documented feature does not exist on the pinned line. **UNVERIFIED** which others
  differ; a v4-versus-v5 doc diff is the cheap way to find out before the catalog moves.

### 8.1 Removals shipped as patches: established, not suspected

`packages/worker-core/src/dispatch.ts` asserts that *"`@ai-sdk/harness` ships removals as patches at
roughly eleven releases a week"*. **That claim is correct in substance and slightly high on the
rate.** Both halves are now established from the shipped changelogs.

**The structural fact, VERIFIED** by counting changelog sections in the published tarballs of all
four `@ai-sdk` harness and sandbox packages:

```
@ai-sdk/harness@1.0.110              patch=137  minor=0  major=2
@ai-sdk/harness-codex@1.0.112        patch=138  minor=0  major=2
@ai-sdk/harness-claude-code@1.0.114  patch=140  minor=0  major=2
@ai-sdk/sandbox-vercel@1.0.110       patch=138  minor=0  major=2
```

**There has never been a minor release.** The only two `### Major Changes` sections in each file are
`0.0.0-canary.1` and `1.0.0`, both carrying the same initial-release entry. Every change since 1.0.0
- feature, fix, rename, removal - has shipped as a **patch**.

**Removals and required-option changes inside the research window, VERIFIED verbatim from
`CHANGELOG.md` in the published tarballs:**

| Version | Date | Bump | Changelog line |
| --- | --- | --- | --- |
| `harness@1.0.104` | 2026-09-08 | patch | `chore(harness): remove formerly deprecated \`model\` and \`modelId\` config on harness adapter settings` |
| `harness@1.0.92` | 2026-08-27 | patch | `feat(harness): ... and remove support for the formerly deprecated legacy auth options types` |
| `harness@1.0.81` | 2026-08-21 | patch | `feat(harness): make \`destroy\` on \`HarnessV1NetworkSandboxSession\` mandatory` |
| `harness@1.0.55` | 2026-08-03 | patch | `fix(harness): remove unused and unnecessary \`workingDirectory\` property from \`HarnessV1BootstrapCommand\`` |
| `harness@1.0.55` | 2026-08-03 | patch | `fix(harness): rename harness bridge \`detach\` to \`stop\` and \`shutdown\` to \`destroy\` for clarity` |
| `harness-codex@1.0.55` | 2026-08-03 | patch | `fix(harness-codex): set default model back to \`gpt-5.5\` due to upstream SDK issue with newer models` |

Three of these are worth naming individually:

- **`1.0.104` deletes two public settings properties under a `chore:` prefix, in a patch.** A consumer
  on `^1.0.0` who updated between 2026-08-28 and 2026-09-08 saw `model` move from the adapter to
  `HarnessAgent` and then disappear from the adapter type, entirely inside the patch range.
  Corroborated in the types: `@ai-sdk/harness-codex@1.0.112`'s `CodexHarnessSettings` has no `model`
  member. **VERIFIED.**
- **`1.0.81` makes an interface member mandatory**, which breaks every third-party
  `HarnessV1NetworkSandboxSession` implementation at compile time - and Reprove writes one of those
  by hand in `packages/adapters/src/brokered.ts`. This is the single most direct churn risk to
  Reprove's own code, and it shipped as `1.0.80 -> 1.0.81`. **VERIFIED.**
- **`harness-codex@1.0.55` reverts a default model in a `fix:` patch.** A default change, not an
  additive one. **VERIFIED.**

**The rate, VERIFIED** from npm `time` metadata over 2026-08-01 to 2026-09-14 (45 days):

| Package | Stable releases in window | Cadence |
| --- | --- | --- |
| `@ai-sdk/harness` | 52 | ~8.1/week |
| `@ai-sdk/harness-codex` | 52 | ~8.1/week |
| `@ai-sdk/sandbox-vercel` | 52 | ~8.1/week |
| `@vercel/sandbox` | 7 stable (+6 beta) | ~1.1/week |
| `workflow` (4.x line) | 8 | ~1.25/week |

**INFERRED:** eight a week rather than eleven. The comment in `dispatch.ts` should be corrected to
the measured figure, and its conclusion - *"a capability is a measurement with a shelf life rather
than a fact about a version string"* - is if anything better supported now than when it was written.

**The cause is mechanical, VERIFIED:** `@ai-sdk/harness@1.0.110` depends on `ai@7.0.100` **exactly**,
not by range, and each bridge depends on `@ai-sdk/harness` exactly. Every `ai` release forces a
republish of the whole set, and the overwhelming majority of changelog entries are
`Updated dependencies [...]` with no behaviour change. **INFERRED:** the cadence is mostly noise, but
the signal is buried in it at the same patch level, which is exactly what makes ADR 0014's
reviewed-bump rule load-bearing rather than fussy.

### 8.2 `@vercel/sandbox` versions breaking changes correctly

**VERIFIED**, and the contrast is instructive. `@vercel/sandbox@3.0.0` (2026-08-07) put its break
under `### Major Changes` with a migration note: the `runtime` option was deprecated in favour of
`image`, and *"Sandboxes that do not specify an image now use `vercel/sandbox/universal`. The previous
default was the `node24` runtime on Amazon Linux 2023."* `3.1.0` declared a narrower type-level break
under `### Minor Changes`. **INFERRED:** `@vercel/sandbox` can be tracked with an ordinary range and
a changelog read; the `@ai-sdk` harness family cannot, and Reprove's exact catalog pin is the right
answer for the latter and arguably heavier than needed for the former.

And the two release cultures collide: `@ai-sdk/sandbox-vercel` absorbed `@vercel/sandbox`'s **major**
as its own **patch** `1.0.87` (2026-08-25) - *"Add support for `@vercel/sandbox` v3 while preserving
the adapter's existing Node 24 runtime default."* **VERIFIED.**

### 8.3 Two facts that touch this repository's supply-chain rules

- **`@vercel/sandbox@3.3.0` ships a beta dependency in a stable release:**
  `"@workflow/serde": "4.1.0-beta.2"`. **VERIFIED.** `pnpm-workspace.yaml` already carries
  `minimumReleaseAge: 1440` and `trustPolicy: no-downgrade`, and the lockfile already resolves
  `@workflow/serde` 4.1.0 and 4.1.2 through the Workflow family; a third, prerelease copy arriving
  under a Sandbox dependency is the kind of thing `tools/verify-workspace.mjs` exists to surface.
- **Neither `@vercel/sandbox` nor `workflow` declares an `engines` field.** **VERIFIED.** The
  `node >= 22` floor comes only from the `@ai-sdk` layer, and this repository's own `node >= 24` is
  self-imposed.

### 8.4 The Codex CLI pin is Reprove's, not upstream's

**VERIFIED**, and it is deliberate. `@ai-sdk/harness-codex@1.0.104`'s shipped bridge manifest
(`dist/bridge/package.json`, read from this repository's own `node_modules`) pins
`"@openai/codex-sdk": "0.149.1"`. `packages/adapters/src/bootstrap.ts` pins **0.153.4** and says so:
*"Kept separate from the Harness bridge version."* At `@ai-sdk/harness-codex@1.0.112` upstream still
pins 0.149.1.

**INFERRED:** Reprove therefore runs the upstream bridge against a Codex SDK several minor versions
ahead of the one it was published against. That is a defensible choice - it is the version
`tools/codex-contract.test.mjs` actually exercises end to end against the real CLI - but it means the
bridge/CLI compatibility is Reprove's to prove on every bump of either pin, and a hosted Pass does
not change that. It also means the hosted image cannot simply be "whatever the bridge bootstraps":
`getBootstrap()`'s own `pnpm install --frozen-lockfile` would install 0.149.1.

### 8.5 What exists and what does not

**VERIFIED** on the public registry, 2026-09-14: `@ai-sdk/harness`, `-codex`, `-claude-code`,
`-opencode`, `-cursor` (first published 2026-08-24), `@ai-sdk/sandbox-vercel`,
`@ai-sdk/sandbox-just-bash`, and `@ai-sdk/workflow-harness` all exist. `@ai-sdk/sandbox`,
`@ai-sdk/sandbox-daytona` and `@ai-sdk/sandbox-e2b` **do not** - all three 404.

`@ai-sdk/workflow-harness@1.0.110` is worth a look on its own: it peer-depends on `workflow ^4.2.1`
and hard-pins `@ai-sdk/harness` at 1.0.110. **UNVERIFIED** what it actually does; if it is a
first-party integration of a Harness with Workflow steps, it is directly adjacent to the seam ADR
0014 owns, and it was not examined here.

---

## 9. Corrections to prior in-repo research

Recorded explicitly, because both documents are cited elsewhere.

### `docs/research/long-running-jobs-on-vercel.md`

1. **The cost model is wrong, and it understates the bill.** §5 computes Active CPU as
   `wall-clock hours x $0.128`, ignoring the vCPU count: *"30% busy = 6.0 min = 0.1000 hr x $0.128/hr
   = $0.01280"* for a **4-vCPU** sandbox. The correct figure is `4 x (20/60) x 0.30 x 0.128 =
   $0.0512`, four times larger. The document's own cross-check against Vercel's `$0.34` example
   should have caught it: that example only reconciles under the per-vCPU model. Corrected totals are
   in §7.2 - roughly **$0.11-0.14 per review at 4 vCPU**, not $0.076-0.084.
2. **`Sandbox.get({ sandboxId })` no longer exists.** Reattach is `Sandbox.get({ name })` in
   `@vercel/sandbox` v2 and later; the class has no `id` getter. The code sample in §4 will not
   compile against 3.3.0.
3. **The run-limits table is incomplete.** "No maximum run duration and no maximum sleep duration" is
   correct and was never the whole picture: 10,000 steps per run, 25,000 events per run, a 50 MB
   payload cap, 2 GB entity storage per run, and a **240-second workflow replay budget** all bind.
4. **Two of its open questions are now closed.** Racing a webhook against `sleep` with `Promise.race`
   **is** documented and deterministic under replay (§6.4) - with the caveat that the loser keeps
   running. And a detached command's re-lookup across processes is now moot for Reprove's purposes,
   because `@ai-sdk/harness` supplies a first-class cross-process resume (§6.5) that does not depend
   on it.
5. **What survives unchanged:** Workflow is GA with no run-duration and no sleep-duration cap; sleep
   holds no compute; a Sandbox outlives its Function; Pro session max is 24 hours and Hobby 45
   minutes; memory is 2 GB per vCPU; inbound transfer is free; the Pro concurrency and vCPU-ramp
   quotas; and the conclusion that Workflow rather than Queue is the right spine.

### `docs/research/harness-tool-execution-seam.md`

1. **"Hosted path (settled: Vercel Sandbox): use `@ai-sdk/sandbox-vercel`, brokering on" is premature
   on two counts.** The adapter is self-labelled experimental, hard-pins the Harness version, and -
   decisively - **exposes no way to set a `forwardURL` rule**, which §2.2 shows is the only shape
   that satisfies ADR 0004's method-and-path requirement. Driving `@vercel/sandbox` directly behind
   Reprove's own `HarnessV1NetworkSandboxSession` implementation is the more likely answer, and it is
   what `packages/adapters/src/brokered.ts` already does for the container provider.
2. **"Set `networkPolicy` explicitly - the default is `allow-all`" is confirmed**, as are the
   warnings about `subnets.allow`, SNI matching and domain fronting. All three are stated by Vercel's
   own documentation.
3. **The brokering and silent-downgrade findings are confirmed at the pinned versions**, with the
   1.0.100 refinement noted in §1.2.

---

## 10. What this means for Reprove

**INFERRED throughout; these are readings of the verified facts above, not decisions.**

1. **ADR 0004's property table needs a second dialect, not an exemption.** The table is written in
   container vocabulary - `Privileged`, `CapDrop`, `seccomp`, `PidsLimit` - and a Firecracker microVM
   answers none of them while being strictly stronger. Read literally, ADR 0004 refuses the better
   boundary. The repair that keeps the ADR's spirit is to state each property as the *threat it
   closes* and let each technology attest it in its own terms: "the Sandbox cannot reach the host
   kernel's syscall surface" is answered by seccomp on a container and by a dedicated kernel on a
   microVM. The one property with no hosted answer either way - **read-only root filesystem** - should
   be named as a real gap and either dropped from the universal contract or accepted as a
   container-only strengthening.
2. **The hosted Pass is the only path to `external` Provenance without an opt-in.** `microvm` +
   `Exposure: none` is the one cell in ADR 0004's matrix that permits `internal` **and** `external` by
   default. Every self-hosted configuration is at best `container-rootless`. If reviewing fork pull
   requests matters to the product, it is a hosted-mode feature first.
3. **Reprove should own the Vercel sandbox session rather than consume `@ai-sdk/sandbox-vercel`.**
   `brokered.ts` already implements the `HarnessV1NetworkSandboxSession` shape by hand and validates
   every transformation before binding it. Doing the same over `@vercel/sandbox` keeps that guard,
   keeps the Harness catalog free of a lockstep pin, and is the only way to reach `forwardURL`. The
   cost is owning a second provider implementation; the benefit is that the security-critical code
   stays the code Reprove already reviews. The cost is also now quantified: `harness@1.0.81` made
   `destroy` mandatory on that very interface in a **patch**, so the hand-written session is the part
   of Reprove most exposed to upstream churn, and it is exposed whether or not the hosted path
   happens.
4. **`forwardURL` turns Reprove's proxy into a deployed service.** Locally the proxy is a loopback
   process reachable only over the container's pipes. Hosted, it is a public HTTPS endpoint with
   OIDC-verified callers. The rules, budgets and credential substitution in
   `packages/sandbox-container/src/proxy.ts` are portable; the *unreachability* is not. That is a new
   surface to threat-model, and `defineSandboxProxy`'s built-in OIDC verification is the thing to
   build on rather than around.
5. **Adopt `doSuspendTurn` / `continueFrom` before adopting the 1800s beta.** The GA 800-second step
   ceiling is enough for a 20-minute review if the Pass is sliced, and slicing is what ADR 0005
   already reserved for the Adapter. Depending on a beta environment variable to avoid writing the
   slice loop buys a shorter path to a demo and a longer path to a supportable product.
6. **The watchdog must tear the Sandbox down, not merely give up.** `Promise.race` does not cancel,
   and the loser here bills $0.085/hour. ADR 0015's *"a cancelled pass is not a torn-down Sandbox"*
   is a correctness note locally and a cost defect hosted.
7. **Decide the drive step's retry policy deliberately, because the default is wrong here.** Workflow
   retries a killed step three more times with no backoff and no visible error, and Reprove's drive
   step is not naturally idempotent - it re-enters a live model turn. Either set `maxRetries = 0` and
   let ADR 0015's lifecycle own the decision, or make the slice idempotent against the harness cursor
   and use the step's stable `stepId` as the key. Taking the default is choosing silent
   double-execution against a stateful Sandbox.
8. **Budget the hosted Pass at ~$0.07 of infrastructure per review at 2 vCPU** and stop optimizing
   there. The number is small, the model spend is not, and the prior document's more optimistic
   figure was arithmetic rather than a different design.
9. **Nothing here is measured.** Every Vercel fact is documentation or a published type; no sandbox
   was created, no workflow was run, and no Codex turn was sliced. The three things worth a spike, in
   order: `doSuspendTurn` state round-tripping through Workflow serde into a reattached session;
   whether the Vercel adapter's bridge port endpoint is a public URL; and a `forwardURL` proxy
   enforcing method and path against a real sandbox.

---

## 11. What I could not verify

- **Whether the `model` / `modelId` removal in `harness@1.0.104` had any deprecation period worth
  the name.** The changelog says "formerly deprecated" and the replacement landed in `1.0.93`
  (2026-08-28), which would make the window eleven days, but the version that first marked them
  deprecated was not located.
- **What `@ai-sdk/workflow-harness` does.** It exists, peer-depends on `workflow ^4.2.1`, and sits
  directly on the seam ADR 0014 owns. It was not examined.
- **Whether `@ai-sdk/harness`'s `1.0.104` through `1.0.110` removed anything else** beyond what the
  changelog names. Changelog entries were taken at face value; no `.d.ts` diff across versions was
  performed, and that is the mechanical check worth automating if the Harness catalog will move
  often.
- **Snapshot and resume latency as a documented figure.** Only blog p75/p95 numbers from 2026-04-02
  exist, and the docs give qualitative language.
- **Per-region Sandbox rates other than `iad1`.** The pricing page's region selector does not render
  to a fetcher, and there is no static regional-pricing page.
- **Any authentication on `sandbox.domain(port)` URLs.** The docs say only that they are "publicly
  accessible". Absence of documentation, not confirmation of absence.
- **Whether `getPortEndpoint` on a Vercel-backed harness session resolves to a public URL.** This
  decides whether the Codex bridge WebSocket is internet-reachable, and it matters.
- **Port-level allow or deny in the network policy.** No port dimension exists in the schema; denials
  are CIDR-only.
- **Whether `deny-all` blocks the sandbox's own control-plane channel.** Vercel's docs say `deny-all`
  denies all outbound access "including DNS", yet `runCommand` keeps working in their own example.
  The carve-out is undocumented.
- **The maximum accepted value of the `timeout` option** as an SDK-level constraint, separate from
  the per-plan session ceiling.
- **The five-hour versus twenty-four-hour session cap.** The `workflow` package's Sandbox cookbook
  says to rotate a VM before a five-hour hard cap; `vercel.com/docs/sandbox/pricing` says the session
  maximum is 24 hours on Pro. Two first-party sources, read the same day, disagree.
- **Whether any `workflow` behaviour quoted in §6 differs between the pinned 4.8.5 and the
  `5.0.0-beta.51` docs it was read from.** At least one feature (multi-region run state) is
  v5-only; the rest were not diffed.
- **Whether a separate idle timeout exists for Node.js functions.** Nothing documents one across the
  functions limits, duration, streaming and limits pages, but proving a negative from documentation
  is weak. Adjacent documented facts: the Edge runtime's 25s first-byte rule, the 120s proxied-request
  timeout for external rewrites, and HTTP/1.1 idle-connection closure.
- **Per-operation Vercel Queues pricing**, which sits underneath Workflow and is regionally priced
  with no public per-operation figure, and the Pro included allowance for Workflow Events.
- **Whether sandbox `name` is globally unique or project-scoped.** `getSandbox({ name, projectId })`
  implies project scoping, but no doc states the collision or reuse semantics - which matters,
  because Reprove would key on a Pass id.
- **Runtime behaviour of every claim in §2 and §5.** Egress enforcement, `sudo -u` isolation and
  header injection are asserted by types and prose; none was exercised.

---

## Sources

**Vercel Sandbox** - [docs/sandbox](https://vercel.com/docs/sandbox),
[concepts](https://vercel.com/docs/sandbox/concepts),
[concepts/firewall](https://vercel.com/docs/sandbox/concepts/firewall),
[concepts/images](https://vercel.com/docs/sandbox/concepts/images),
[concepts/multi-agent](https://vercel.com/docs/sandbox/concepts/multi-agent),
[concepts/snapshots](https://vercel.com/docs/sandbox/concepts/snapshots),
[concepts/persistent-sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes),
[concepts/authentication](https://vercel.com/docs/sandbox/concepts/authentication),
[working-with-sandbox](https://vercel.com/docs/sandbox/working-with-sandbox),
[sdk-reference](https://vercel.com/docs/sandbox/sdk-reference),
[ecosystem](https://vercel.com/docs/sandbox/ecosystem),
[pricing](https://vercel.com/docs/sandbox/pricing),
[kb: reconnect to a running sandbox](https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox),
[blog: optimizing Vercel Sandbox snapshots](https://vercel.com/blog/optimizing-vercel-sandbox-snapshots).

**Vercel Workflow and Functions** - [docs/workflows](https://vercel.com/docs/workflows),
[workflows/concepts](https://vercel.com/docs/workflows/concepts),
[workflows/pricing](https://vercel.com/docs/workflows/pricing),
[functions/configuring-functions/duration](https://vercel.com/docs/functions/configuring-functions/duration),
[functions/usage-and-pricing](https://vercel.com/docs/functions/usage-and-pricing),
[limits](https://vercel.com/docs/limits),
[blog: a new programming model for durable execution](https://vercel.com/blog/a-new-programming-model-for-durable-execution),
[changelog: workflow steps now support extended function durations](https://vercel.com/changelog/workflow-steps-now-support-extended-function-durations),
plus the documentation the `workflow` package ships in its own tarball, read at
`workflow@5.0.0-beta.51`: `docs/foundations/workflows-and-steps`, `docs/foundations/errors-and-retries`,
`docs/foundations/idempotency`, `docs/foundations/streaming`, `docs/foundations/hooks`,
`docs/configuration/runtime-tuning`, `docs/errors/step-executed-multiple-times`,
`docs/cookbook/common-patterns/timeouts`, `docs/cookbook/integrations/sandbox`,
`docs/how-it-works/event-sourcing`, and `@workflow/core@5.0.0-beta.51` `dist/index.d.ts`,
`dist/sleep.d.ts`, `dist/create-hook.d.ts`.

**Packages** - read from published tarballs (`npm pack`) and from this repository's installed
artifacts: `@vercel/sandbox@3.3.0` (`dist/sandbox.d.ts`, `dist/session.d.ts`,
`dist/network-policy.d.ts`, `dist/sandbox-user.d.ts`, `dist/proxy.d.ts`, `dist/constants.d.ts`,
`README.md`), `@ai-sdk/sandbox-vercel@1.0.110` (`src/index.ts`,
`src/vercel-network-policy-manager.ts`, `src/vercel-network-sandbox-session.ts`, `README.md`),
`@ai-sdk/harness@1.0.102` (`src/v1/harness-v1-session.ts`,
`src/v1/harness-v1-network-sandbox-session.ts`, `src/v1/harness-v1-sandbox-provider.ts`,
`src/utils/sandbox-credential-brokering.ts`, `CHANGELOG.md`),
`@ai-sdk/harness-codex@1.0.104` (`src/codex-harness.ts`, `CHANGELOG.md`), and the npm registry's
`time` metadata for all of the above.

**This repository** - `docs/adr/0004`, `0005`, `0010`, `0014`, `0015`;
`packages/sandbox-container/README.md`, `src/broker.ts`, `src/proxy.ts`;
`packages/worker-core/src/sandbox.ts`, `src/dispatch.ts`;
`packages/adapters/src/brokered.ts`, `src/image.ts`, `src/bootstrap.ts`;
`packages/control-plane-workflow/src/pass.ts`; `pnpm-workspace.yaml`; `pnpm-lock.yaml`.
