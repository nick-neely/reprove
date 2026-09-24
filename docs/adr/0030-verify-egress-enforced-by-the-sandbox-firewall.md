# Verify egress is enforced by the Sandbox firewall

[ADR 0027](0027-verify-sandbox-egress.md) §2 forwarded every Reviewer-phase host to a Reprove egress
proxy and said to reopen that choice, not weaken it quietly, if a proxied install proved too slow.
[Prototype one real Codex Pass in a Vercel Sandbox from a Workflow
step](https://github.com/nick-neely/reprove/issues/114) measured it: `npm install` of typescript,
eslint and vitest (343 requests, 160 MB) took **149 s** through the egress route, **11.8 s** direct
and **14.1 s** under firewall-native rules. The premise of §2's rejection has also moved:
`@vercel/sandbox@3.5.0` `response` rules let the firewall deny unclaimed methods, and a
TLS-terminating rule makes it reject `Host` ≠ SNI. Settled with the maintainer on 2026-09-24 in
[Decide whether verify egress is enforced by the firewall or by the egress
proxy](https://github.com/nick-neely/reprove/issues/127).

This ADR supersedes ADR 0027 §2, §3, §6, §7 and §8 and ADR 0028 §7. ADR 0027 §1, §4 and §5 stand:
the boundary is constrained egress, not leakage prevention; the default registry set and its
methods are unchanged; `security.egress` still names exact extra hostnames, `GET`/`HEAD` only.

## 1. The firewall enforces method, path and authority; there is no egress proxy

The Reviewer-phase network policy gives **every** allowed host, default set and `security.egress`
alike, explicit rules:

- a rule claiming `GET` and `HEAD` on any path, with a no-op transform, which makes the rule
  TLS-terminating so the firewall rejects a `Host` header that differs from the SNI;
- on `github.com` only, a rule claiming `POST` on paths ending `/git-upload-pack`;
- a **trailing deny**, `response: 403` with a per-Pass nonce body (§4).

The trailing deny is essential. Vercel documents that traffic unmatched by a matcher passes directly
to an allowed domain; without the deny, the method rules would select, not block.

The only `forwardURL` is the Provider route (ADR 0021 §4), which keeps its Binding and per-admission
liveness. The **egress route and the per-Pass egress authorization are deleted.** Because nothing
forwards `github.com`, ADR 0024's firewall-injected fetch token no longer conflicts with the
Reviewer phase.

**Scope.** Method and path enforcement applies to HTTPS traffic. Vercel ignores transformation rules
for Postgres traffic to an allowed domain; no default host serves Postgres, and an extra host that
does gets reachability without method rules. Redirects are unchanged: the client's next request
meets a fresh firewall decision.

## 2. Private addresses are denied by an explicit CIDR list

Omitting IP literals and ranges from the allowed set does not prove an allowed hostname cannot
resolve to a private address. The policy therefore compiles `deniedCIDRs` for private, loopback,
link-local, carrier-grade NAT and metadata ranges (RFC 1918, `127.0.0.0/8`, `169.254.0.0/16`,
`100.64.0.0/10`, and the IPv6 loopback, link-local and unique-local ranges). Vercel documents that
denied ranges take precedence over allowed domains.

DNS resolution and pinning are the platform's. Reprove makes no claim about them beyond this list.

## 3. Liveness after a Run ends is cleanup, not an admission check

ADR 0028 §7 stopped new Reviewer-phase egress on the next request once the Run was terminal, even
if the lifecycle wake was lost. With no egress route there is no per-request check, and **that
guarantee is given up.** It is accepted explicitly: the Provider route keeps its per-admission
liveness, so model spend stays bounded without the wake; Reviewer-phase egress to approved hosts is
not.

On `ended` and `worker_lost`, cleanup attempts a bounded `sandbox.update({ networkPolicy: deny-all })`
and ADR 0028's `stop()` **concurrently**; the update never delays the stop. Both are prompt, not
guaranteed; the platform timeout remains the backstop. Neither recreates per-request liveness.

## 4. `policy_unenforceable`: partial readback and sampled enforcement probes

Exact readback is impossible: the session record returns domains, injected header names, forward
URLs and response status codes, never matchers or bodies. ADR 0027 §8's exact comparison is
replaced, at ADR 0024 step 5, by two checks, both before Reviewer authorization.

**Partial readback.** The domain set equals the compiled set; no header is injected on any
Reviewer-phase domain; the only forward is the Provider route; every Reviewer-phase domain carries a
`403` response rule; and, if the session record exposes them, the denied CIDRs equal the compiled
list. If it does not, per-Pass verification does not cover them; the claim rests on the compiled
policy, Vercel's documented precedence, and the handoff test below.

**Enforcement probes**, run by trusted setup code in the root-only phase. They are **sampled
enforcement checks**, not exact verification: they exercise every host's trailing deny but not
every method or path.

- One request per compiled domain with an unusual **bodyless** method (`PROPFIND`) on an independent
  random path, so a broken rule cannot deliver a write to a repository-supplied host.
- A `POST` to a `github.com` path that does not end in `/git-upload-pack`.
- One request whose `Host` header differs from its SNI.
- One **control**: an allowed `GET` to a default host, which must receive a response that does not
  carry the nonce, proving the policy is not simply denying everything.

A probe passes only on a `403` whose body carries this Pass's **response nonce**. The nonce is
generated per Pass, known only to the trusted setup code until the probes finish, and never
appears in any request, so a host that receives a probe cannot forge the answer. The Reviewer is
authorized only after the probes; it may later see the nonce, which no longer matters.

**Outcomes.** A readback mismatch, or a probe answered with a non-nonce response, demonstrates an
unmet rule: `policy_unenforceable`, `actual: policy_readback` or `actual: enforcement_probe`. A
transport failure, an unreachable control upstream or a checker error proves nothing about the
policy and takes the ordinary retry or Failure path (ADR 0023, ADR 0021), as ADR 0024's preflight
does. ADR 0027 §8's other rules stand: `required` never names a host or a count, a storage error is
never `policy_unenforceable`, and every local-container `verify` Run refuses.

## 5. What is no longer measured or limited

The firewall exposes no per-request counts, sizes or denial reasons. So:

- **The egress-denial aggregate is dropped.** The Run records none and the Check's facts table does
  not show one (ADR 0027 §7's handoff to ADR 0025 is withdrawn).
- **Per-request egress limits are dropped.** PRD §35's request count, request size, body size and
  concurrency limits no longer apply to hosted egress. Nothing replaces them: the `deadline`, the
  budget and the Sandbox's resources do not cap egress request count, bytes or concurrency.
- A `403` does not itself make a Limitation. The Reviewer records `dependency_unavailable` only
  when it identifies work a denial blocked (ADR 0027 §7).

If the platform later exposes denial logs, the aggregate may return without reopening this ADR.

## Rejected

- **Keep the egress proxy** (ADR 0027 §2): 149 s against 14.1 s for the same install, for checks
  the firewall now performs.
- **Hybrid, proxy for `security.egress` only**: keeps a whole route for rare hosts and gives them
  different semantics.
- **Trust `update()` succeeding**: cannot tell a policy that compiled from one that enforces.
- **Nonce in the probe path**: a repository-supplied host receiving the probe could echo it in a
  forged `403`.
- **`PUT /` as the probe**: a broken rule would deliver a write to the host.

## Handoffs

- Prove CIDR precedence once: a Reprove-controlled hostname resolving to a **reachable public IP**,
  fetched with and without a temporary `/32` deny for that IP. Test the private ranges separately.
  A private-resolving hostname alone cannot prove precedence, since it may be unreachable anyway.
- Establish whether the session record exposes denied CIDRs.
- The exit scenario ([#116](https://github.com/nick-neely/reprove/issues/116)) exercises the probes
  and the concurrent deny-all and `stop()`.

## Consequences

- ADR 0004's Sandbox property "egress only through Reprove's proxy" becomes "default-deny egress
  enforced by Reprove's policy, at the Sandbox firewall or Reprove's proxy"; its always-at-the-proxy
  limits apply to the Provider route only.
- ADR 0027 §2, §3, §6, §7 and §8 and ADR 0028 §7 are superseded; ADR 0029's reliance on terminal
  Runs losing egress admissions narrows to Provider admissions.
- `CONTEXT.md`'s **Sandbox** and PRD §23 and §35 are amended to match.
- The egress authorization record and the egress route are removed from the plan.
