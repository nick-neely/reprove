# Security Policy

Reprove runs coding agents against pull requests. That means it does two things
that are dangerous when combined: it **executes code it did not write** and it
**holds credentials worth stealing**. Keeping those two apart is the project's
central architectural claim, so a report that breaks the separation is the most
valuable thing you can send us.

Please read this before reporting - the scope section below is unusually
specific, because the interesting attacks against Reprove are not the usual web
application ones.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion.**

Report privately, either way:

- **[GitHub private vulnerability reporting](https://github.com/nick-neely/reprove/security/advisories/new)** - preferred. It keeps the report, the fix and the advisory in one place.
- **security@reprove.dev** - if you would rather not use GitHub. Say up front that it is a security report.

A useful report includes what an attacker gains, the steps to reproduce it, and
the commit or version you tested. If you have a proof of concept, send it -
Reprove is a project built on the belief that a claim should be demonstrated by
execution rather than asserted, and we hold incoming reports to the same
standard we hold our own Findings to.

### What to expect

| | |
|---|---|
| Acknowledgement | Within 3 working days |
| Initial assessment | Within 10 working days |
| Fix or mitigation plan | Communicated with the assessment |

Reprove is currently maintained by one person. If you have not heard back within
those windows, send a follow-up rather than assuming the report was dismissed.

You will be credited in the advisory unless you ask not to be. There is no bug
bounty; the project has no revenue.

## Current status: pre-implementation

**No Reprove code has been released.** There is no package to install and no
hosted service to attack. What exists is a specification
([`docs/prd.md`](docs/prd.md)) and a decision record
([`docs/adr/`](docs/adr/)).

Reports against the *design* are in scope and genuinely wanted right now. If you
read [ADR 0003](docs/adr/0003-two-invocation-routes.md) or
[ADR 0004](docs/adr/0004-sandbox-boundary-and-credential-isolation.md) and see a
way through the boundary they draw, that is worth more today than it will be
after the code exists. Design reports may be discussed in the open at our discretion, since
there is nothing deployed to protect - we will ask you first.

### Supported versions

None yet. Once releases begin, this table will name the supported ones; until
then, the `main` branch is the only thing that exists.

## What Reprove claims, and what it does not

The scope list below is only meaningful against a stated posture, so here it is.
The architecture behind it is
[ADR 0004](docs/adr/0004-sandbox-boundary-and-credential-isolation.md).

**Three claims, each falsifiable:**

1. **On the Brokered Route, no usable credential enters the Sandbox.** The
   Sandbox receives a placeholder; the real credential is spliced in at an
   egress proxy outside it. Upstream this is default-off and degrades on a
   `console.warn`, so Reprove enforces it with a guard that throws on any
   non-placeholder value, covered by a regression test.
2. **The Sandbox has no GitHub authority.** The Worker materializes a
   self-contained repository with every remote and host reference stripped and
   copies it in. Nothing inside can fetch, push, or reach a ref the Worker did
   not put there.
3. **A weakened posture never runs quietly.** A missing hard requirement is a
   refusal; a missing strength signal narrows which pull requests the Worker may
   review. Both are visible in the Worker's advertised capabilities and both
   surface on a GitHub Check.

**And one non-claim, stated as plainly as the claims: Reprove does not isolate
repository execution from the Reviewer.** The Harness, the Workspace and any
code that Workspace runs share one Sandbox. Separating them would require
relocating a Harness's tool execution, which two of the three Harnesses do not
support at all. On the Native Auth Route the user's own credential is inside
that Sandbox and Reprove does not claim otherwise; what bounds the risk there is
Provenance, Isolation and the credential's revocability, not separation.

**Revocability there is yours, not ours.** Reprove neither mints nor can revoke a
Native Auth Route credential. Where one can be revoked, you revoke it in the
harness vendor's own surface - for `claude setup-token` that is per-token
deletion at `claude.ai/settings/claude-code`, which Anthropic describes in a
support article rather than in its documentation, and nowhere states to be
immediate or to leave your interactive login intact. Treat revocation as a real
but user-driven and vendor-documented-at-best control, not as something Reprove
guarantees on your behalf.

**The residual, recorded rather than argued away:** a compromised Sandbox cannot
steal a brokered credential, but it may spend the Run's remaining budget against
the endpoint the Run is allowed to reach, or attempt exfiltration through a
destination the Repository explicitly permitted. Credential brokering converts
credential *theft* into bounded authorized-service *abuse*. It does not
eliminate it. Reports that widen those bounds are in scope.

## Scope

### In scope

These are the failures Reprove's architecture is specifically meant to prevent.

**Credential exposure.** Any path by which a Harness credential - an API key, a
Gateway token, or a user-managed authentication cache such as `~/.codex/auth.json`
- becomes readable by code from the repository under review. This includes
reaching a credential through the agent itself (persuading a Reviewer to print
or exfiltrate it), through the Sandbox's environment or filesystem, or through
network egress from inside the Sandbox. Credential brokering is
[default-off upstream](docs/research/harness-tool-execution-seam.md); a way to
make Reprove silently run unbrokered is in scope.

**Sandbox escape.** Anything that lets Workspace code reach the host, the
control plane, another Owner's Run, or the network beyond the egress allowlist.

**Repository-controlled instructions.** A Reviewer reads the repository under
review, and some of what it reads is instruction-shaped: `CLAUDE.md`,
`AGENTS.md`, other harness configuration files, pull request descriptions,
commit messages, code comments. A crafted repository that makes a Reviewer
suppress a real Finding, fabricate a false one, run an attacker's command, or
act outside its Autonomy is in scope. Note that repo-local `CLAUDE.md` is loaded
into the reviewer's context with no upstream way to disable it - see
[issue #4](https://github.com/nick-neely/reprove/issues/4).

**Dispatch-gate misclassification.** Three computed axes decide whether a Run may
happen at all: `Provenance` (`internal` vs `external`), `Exposure` (what a
compromised Sandbox would yield) and `Isolation` (how strong the Sandbox is).
Anything that makes an external pull request classify as internal, understates
what a credential can do, or overstates a Worker's isolation is in scope, since
each moves a Run into a cell it should never have reached. Note that `internal`
is a *risk classification, not a guarantee* - it means an attacker would have to
be a collaborator, not that there is no attacker - so "a collaborator could abuse
it" is a known and accepted property rather than a vulnerability.

**Tenancy and access control.** One Owner reading another's Runs, Results,
Findings, Evidence, Workers or settings. Reprove derives what a User may see
from their GitHub permissions, so a way to see more than GitHub would allow is
in scope.

**GitHub integration.** Webhook signature forgery, replay of a delivery,
Installation token scope escalation, or a Run acting on a repository its
Installation does not grant.

**Worker protocol abuse.** A forged or replayed Result accepted as genuine, a
self-hosted Worker made to execute a Run it was never assigned, or a Worker
registration that claims capabilities it does not have.

**Silent downgrade.** Reprove is designed to fail loudly: a denied dispatch
surfaces as a failed GitHub Check, never as a quiet fallback to a weaker one,
and a Worker that misses a hard isolation requirement is refused rather than
warned about.
Any path that weakens the security posture of a Run without surfacing it is in
scope, and we consider this a security property rather than a usability one.

### Not in scope

- **Vulnerabilities in the harnesses themselves** (Codex, Claude Code,
  OpenCode), their SDKs, or the models behind them. Report those to their
  maintainers. If a harness weakness lets an attacker break a boundary *Reprove
  claims to hold*, that is in scope here as well - report it to both.
- **Vulnerabilities in third-party infrastructure** (Vercel, Neon, GitHub,
  Cloudflare). Report to the vendor. Reprove *misusing* one of them is in scope.
- **The quality of review output.** A missed bug, a false positive, or a Finding
  with a Severity you disagree with is a bug report, not a security report.
- **Anything requiring an already-compromised host.** A self-hosted Worker's
  operator can read their own credentials by definition; Reprove does not
  defend a machine against its own owner.
- **Cost from ordinary use.** A large pull request being expensive to review is
  a product concern. A way to make *someone else's* Owner pay for your Runs is
  in scope.
- **Reports generated by a scanner with no demonstrated impact**, and missing
  hardening headers with no attack behind them.

## Disclosure

We ask for **90 days** from acknowledgement before public disclosure, and will
usually move faster. If a fix will take longer, we will say so and agree a date
with you rather than let the window lapse silently. If a vulnerability is being
exploited, we will publish and fix immediately regardless of the window.

Fixes ship as a GitHub Security Advisory with a CVE where one applies.
