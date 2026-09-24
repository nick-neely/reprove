# The egress a verify Sandbox is allowed

[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) requires egress only through
Reprove's proxy, and PRD §35 requires it default-deny, phased, and restricted by host, method and
path. The local container provider meets that by rendering `--network none`. A hosted `verify`
Reviewer must install dependencies and run the Author's build and tests
([ADR 0020](0020-reviewer-method-under-verify.md) §2), so it needs a network, and
[ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md) §9 left the contents of the
Reviewer-phase policy to [Decide what egress a verify Sandbox is
allowed](https://github.com/nick-neely/reprove/issues/113). Settled with the maintainer on
2026-09-23.

The facts come from the [hosted-Sandbox research](../research/hosted-sandbox-on-vercel.md) §2 and
the [Vercel firewall documentation](https://vercel.com/docs/sandbox/concepts/firewall). Four of them
shape everything below:
- **The firewall allows by domain and address range only.** Method and path matchers select which
  requests a rule applies to; they never block. A rule with a matcher lets unmatched requests pass
  directly to the allowed domain.
- **The forwarded host is the TLS SNI**, not the HTTP `Host` header, and the firewall does not
  prevent the two from differing. Domain fronting is possible unless something checks.
- **A wildcard domain admits arbitrary subdomains**, which can carry data in DNS and SNI before any
  HTTP-level check sees the request.
- **Plain HTTP cannot be filtered by domain**, only by address range.

## 1. What the boundary does and does not claim

The Sandbox holds nothing worth stealing except the source. Exposure is `none` (ADR 0021 §4) and
the per-Pass GitHub token is revoked and confirmed invalid before authorization (ADR 0024 §9). The
threat this ADR constrains is a compromised dependency, or the Author's own code, sending
source-derived data out.

**The boundary is constrained egress, not leakage prevention.** Method and path rules block
specific uploads: `npm publish`, `git push`, and every other write to an approved host. They do not
stop source-derived data leaving through an approved `GET`, whose path, query and headers can carry
it. Every approved host is therefore a trusted recipient of whatever the Reviewer's code puts in a
URL or a header. Reprove says this publicly rather than implying more.

## 2. Every host is forwarded to a Reprove proxy; the firewall allows nothing directly

The Reviewer-phase network policy lists allowed domains, each carrying exactly one unconditional
`forwardURL` rule and nothing else: no transforms, no matchers, no address ranges. The firewall
decides *reachability*; the proxy decides *method and path* and makes the upstream request itself.

Letting registries through as plain firewall domains was rejected. It is cheaper and faster, but it
gives up method and path entirely, leaves domain fronting open, and would have made PRD §35's claim
unbacked on the one threat that matters. Whether forwarding install traffic through a Function is
fast and cheap enough is an open measurement, not a settled fact: [Prototype one real Codex Pass in
a Vercel Sandbox from a Workflow step](https://github.com/nick-neely/reprove/issues/114) runs a real
install through the egress route (§8). If it fails, this section is reopened, not quietly weakened.

## 3. Two routes, two records

There are two proxy routes on the hosted deployment, at separate `forwardURL`s:

| | Provider route (ADR 0021 §4) | Egress route (this ADR) |
| --- | --- | --- |
| accepts | the Provider origin only | the effective egress hosts only, never the Provider |
| injects credentials | yes, from the Binding | **never** |
| authorization record | the Binding | the per-Pass **egress authorization** |

The egress authorization is written at ADR 0024 step 5, before the policy is applied. It holds the
compiled host set and each host's method and path rules. Like the Binding, it is bound to the OIDC
token's **sandbox id, team and project**, not to the Sandbox name alone. It is kept apart from the
Binding because ADR 0021 §4 requires registry and Provider authorization to stay separate. The two
routes may share OIDC verification, limit enforcement and the pure request checks. Separate URLs
and records do not require duplicate implementations; what they must not share is the decision of
what a route accepts.

## 4. One Reviewer-phase policy, and a default registry set reachable throughout it

PRD §35's install phase does not exist under `verify`. ADR 0020 §2 makes `install` conditional and
lets the Reviewer run it partway through its turn, so no boundary separates installing from
verifying. The hosted Sandbox has two network phases: **materialization** (GitHub, with the
fetch token, ADR 0024) and **Reviewer**, set once at ADR 0024 step 5 and not changed afterwards.

**The default registry set is reachable for the entire Reviewer turn**, before, during and after any
install. This is an intentional, always-on egress grant for every repository under `verify`, and
the trade is stated rather than hidden: an install-only window would narrow exposure, but only by
forcing the Worker to run `install` before the Reviewer starts, which ADR 0020 rejected.

The default set, every entry an exact hostname:

```text
npm / Yarn     registry.npmjs.org, registry.yarnpkg.com, repo.yarnpkg.com
PyPI           pypi.org, files.pythonhosted.org
crates.io      index.crates.io, static.crates.io
Go             proxy.golang.org, sum.golang.org
RubyGems       rubygems.org, index.rubygems.org
Maven Central  repo.maven.apache.org, repo1.maven.org
GitHub         github.com, codeload.github.com, objects.githubusercontent.com
```

Every host allows `GET` and `HEAD` on any path. `github.com` additionally allows `POST` only to a
path ending in `/git-upload-pack`, which is how git fetches over smart HTTP after a `GET` discovery
request ([git's HTTP protocol](https://git-scm.com/docs/http-protocol)). `git-receive-pack` and every
other `POST` are denied, so an attacker holding their own token cannot push. No GitHub request
carries a credential (ADR 0024 §9). Including GitHub is not free: it adds three reachable hosts and
an allowed `POST`. It is taken because git dependencies and release downloads are common in npm, Go
and Cargo projects, and without it they fail.

Toolchain download hosts (`nodejs.org`, `static.rust-lang.org`, Go's download site) are **not** in
the set. The Sandbox image supplies the runtime; a version manager fetching whatever the repository
names is how a runtime download becomes arbitrary execution.

## 5. `security.egress` names extra hosts

`security.egress` lists hosts **in addition to** the default set. `egress: []` means "no extra
hosts", not "no network". Each entry is an exact hostname: **no wildcards in Phase 1**, because an
arbitrary subdomain can carry data in DNS and SNI before the proxy sees the request. Every extra host
allows `GET` and `HEAD` on any path, nothing more, and is an explicitly trusted recipient of
source-derived URL and header data (§1). Structured entries (`{ host, methods, paths }`) and
credentialed private registries are not in Phase 1.

The effective host set is the Reprove boundary intersected with the Repository request (ADR 0011
§3; Phase 1 has no Owner ceiling, ADR 0019). **Denied by construction**, whatever is requested:

- the Provider origin, except through the Provider route;
- `api.github.com` and the GitHub API generally;
- the deployment's own origin, except the two proxy routes;
- plain HTTP, any port other than 443, and IP literals or address ranges;
- private, loopback, link-local and metadata address ranges.

A request for one of these is **narrowed out**, per ADR 0011's rule that a narrowing is never a
Refusal. The narrowed value is what `resolvedConfig` records and what the `Reprove config` Check
reports.

**Which Sandboxes get what.** The default set and extra hosts are a `verify` grant. The probe
Sandbox gets only the Provider forward. A Provider-forward-only policy for `inspect` is a dormant
input for whoever reopens that level: Phase 1 refuses `review.autonomy: inspect` before
resolution, so no `inspect` configuration resolves to any egress policy ([amended by
#117](#amended-by-117)).

## 6. What the proxy checks on every request

- **Authority.** The upstream host is the forwarded host, checked against the egress authorization.
  A `Host` header that differs from the forwarded host is rejected, which closes domain fronting.
  The proxy opens TLS to that name with ordinary certificate verification.
- **DNS.** The proxy resolves the name itself, refuses private, loopback, link-local and metadata
  addresses, and connects to the address it checked, so a changed answer between check and connect
  cannot slip through. #114 must prove the deployed proxy can pin the connection this way.
- **Redirects are never followed.** A `3xx` is returned to the client, whose next request passes
  the firewall and the proxy again. A redirect to an unlisted host therefore fails at the firewall.
  Actual registry redirect targets are tested in #114; one outside the default set makes that
  download fail and is fixed by amending the set, not by following it.
- **Limits.** PRD §35's request count, request size, body size, concurrency and wall-clock limits
  are enforced on every request. Their values stay with this ADR and #114 until measured. Per-request
  deadlines stay with [Replace the Phase 0 windows with measured
  deadlines](https://github.com/nick-neely/reprove/issues/115), which ADR 0021 already handed them.

## 7. How denials and outages appear

A denied or limited request gets a `403` or `429`. The proxy counts denials per Pass by a
**bounded reason** (`host_not_allowed`, `method_not_allowed`, `path_not_allowed`,
`host_header_mismatch`, `address_refused`, `limit_exceeded`) and method. The Run records the
aggregate and the Check's facts table shows it. **A denied hostname is never recorded** on the Run
or the public Check: a hostname can encode private source, and attacker-chosen hostnames would give
the record unbounded cardinality.

A denial becomes a `dependency_unavailable` Limitation only when it actually prevents an install or
a verification, not whenever code probes the boundary.

**A proxy outage after authorization is not an enforcement failure.** Requests that depended on the
unreachable route fail. When that blocks work, the Reviewer records a Limitation classified by the
work blocked (`dependency_unavailable` or `service_unavailable`), not by whether the host was a
registry, since an extra host can serve a dependency. If requested scope is left unfinished, ADR
0020 requires `unfinished`, and the Check fails. A down Provider route is an ordinary Provider
Failure. Whether an unreachable `forwardURL` fails closed is **not yet established**: Vercel
documents direct passage for unmatched rules but not outage behaviour, and #114 tests it.

## 8. `policy_unenforceable`

ADR 0019 §1's Worker Refusal applies when the **effective** policy cannot be represented, installed
or verified before Reviewer authorization, at ADR 0024 step 5:

- the effective policy cannot be compiled into the §2 shape, or a route it needs is not configured
  on the deployment;
- the platform rejects `sandbox.update({ networkPolicy })`;
- the policy read back from the Sandbox does not match the **compiled full policy**, including the
  default set and the Provider forward, not just `resolvedConfig.security.egress`. The
  Reviewer-phase policy has no transforms, so readback is not redacted and an exact comparison is
  possible.

`required` names the missing requirement, for example the Provider route as a broker requirement,
never a host count that would misdiagnose it, and never a hostname. `actual` names the check that
failed.

A failed write of the egress authorization, or any other storage error, is **not**
`policy_unenforceable`. It is not evidence that the policy is unsupported; it follows the ordinary
retry path of ADR 0023 and ADR 0021. A repository request outside the boundary is narrowed (§5),
never refused.

The local container provider renders `--network none` and nothing else, so with a non-empty default
set **every local-container `verify` Run refuses with `policy_unenforceable`** until that provider can
enforce proxy egress. There is no local exception.

## Rejected

- **Firewall-only domains for registries** (§2): no method or path, domain fronting open.
- **An install-only window** (§4): requires the Worker to run `install` before the Reviewer, which
  ADR 0020 §2 rejected.
- **One route dispatching on host** (§3): puts the route that injects credentials and the route that
  never does behind one acceptance decision.
- **Wildcard extra hosts** (§5): DNS and SNI carry data before the proxy checks anything.
- **Denied hostnames in the audit record** (§7): a covert channel into a public surface.
- **Following redirects inside the proxy** (§6): would need a second allowlist in the proxy.

## Handoffs

- [#114](https://github.com/nick-neely/reprove/issues/114): a real install through the egress route
  (throughput, cost and limits); several domains sharing one `forwardURL`; the `git-upload-pack`
  paths and body limits; actual registry redirect targets; DNS resolution with a pinned connection
  on the deployed proxy; and behaviour when the `forwardURL` is unreachable.
- [#115](https://github.com/nick-neely/reprove/issues/115): per-request deadlines only, as ADR 0021
  already handed them. Count, size and concurrency limits stay here until #114 measures them.
- [#111](https://github.com/nick-neely/reprove/issues/111) / ADR 0025: the Check's facts table gains
  the aggregate denial count.

## Consequences

- ADR 0004 is amended: egress is constrained, not leakage-proof, and the hosted Sandbox has a
  materialization phase and a Reviewer phase rather than install and verify phases.
- ADR 0011 is amended: `security.egress` names extra hosts beyond a Reprove default set, exact
  hostnames only.
- PRD §35 is amended to match §1, §4 and §5.
- ADR 0019's `egress` row is resolved by §5 and §8.
- The Run gains an aggregate egress-denial count by bounded reason.
- `CONTEXT.md` gains no noun. "Effective egress policy" is ordinary language.

## Amended by [#88](https://github.com/nick-neely/reprove/issues/88)

§3 gains a liveness rule ([ADR 0028](0028-reaping-a-hosted-pass-sandbox.md) §7). The egress route admits a request only while its Pass is live,
the predicate the Provider Binding applies, checked on every admission; a check that cannot
complete rejects. This cuts new Reviewer-phase egress once the Run is terminal or the authorization
is revoked. It does not retract a request already admitted.

## Observed by [#114](https://github.com/nick-neely/reprove/issues/114)

- **§2's measurement failed, so §2 is reopened** as [Decide whether verify egress is enforced by
  the firewall or by the egress proxy](https://github.com/nick-neely/reprove/issues/127). `npm
  install` of typescript, eslint and vitest (343 requests, 160 MB) took 149 s through the egress
  route against 11.8 s direct. The rejection's premise has also moved: `@vercel/sandbox@3.5.0` adds
  `response` rules, and claiming `GET`/`HEAD` with a no-op transform followed by a trailing
  `response: 403` enforced a method allowlist in the firewall (a made-up method was denied; a
  method deny-list let it through) with the same install at 14.1 s. A TLS-terminating rule also
  makes the firewall reject `Host` ≠ SNI itself; a plain allow does not.
- **§6.** The deployed proxy can pin DNS: an undici `Agent` with a fixed `connect.lookup` and
  `servername` works on Vercel Functions. Observed targets: npm tarballs come from
  `registry.npmjs.org` with no redirect; a GitHub archive `302`s to `codeload.github.com`, which the
  client then fetches through the route; PyPI's simple index links to `files.pythonhosted.org`
  rather than redirecting. Git over the route is `GET .../info/refs` plus `POST
  .../git-upload-pack`, with request bodies of 108 to 414 bytes for a clone and a fetch by SHA.
  Several domains sharing one `forwardURL` work, routed by the forwarded host.
- **§7: an unreachable `forwardURL` fails closed.** A non-resolving host returns `502` at once; a
  blackholed address returns `502` after about 135 s; a missing deployment or a route that `404`s
  returns that response to the Sandbox. The real upstream is never reached. An `http:` forward is
  rejected at update.
- **§8's exact readback is impossible.** The SDK getter returns domains only; the raw session
  record returns domains, injected header *names*, forward URLs and response status codes, never
  matchers or bodies. #127 decides what replaces the check.
- The route must disable Next.js's trailing-slash redirect: PyPI's `/simple/<name>/` otherwise gets
  a `308` that the client follows onto a wrong upstream path.

## Amended by [#117](https://github.com/nick-neely/reprove/issues/117)

Phase 1 does not offer `inspect`: `review.autonomy: inspect` is a control-plane
`config_unsupported` at Run creation, before resolution
([ADR 0019](0019-phase-1-repository-configuration-subset.md#amended-by-117)). §5's `inspect`
sentence is **dormant**, and the handoff to #117 is withdrawn. How a future `inspect` prevents
installation belongs to whoever reopens it.
