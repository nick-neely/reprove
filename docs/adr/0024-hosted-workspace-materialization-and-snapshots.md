# A hosted Pass builds its own Workspace, and reviews inputs snapshotted at Run creation

[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) required a self-contained Workspace
with every remote and host reference stripped, and assumed the Worker builds it host-side.
[ADR 0021](0021-hosted-composition-and-brokered-sandbox-seam.md) §4 left "the bootstrap set" to this
ticket, and [ADR 0012](0012-author-controlled-narrative-input.md) put the narrative bounding on the
Worker without saying which pull request state it reads. On a hosted Worker there is no host: the
Worker is a Vercel Function with no durable disk and no memory between invocations, and the only
place with room for a repository is the Sandbox itself. [Fix what a hosted Pass materializes and when
it is snapshotted](https://github.com/nick-neely/reprove/issues/110) settles where the Workspace is
built, what is fetched, who owns what afterwards, when the narrative is frozen, and how the fetch
credential is proven gone before the Reviewer runs.

## 1. The Workspace is built inside the Pass's own Sandbox, as a root-only setup phase

Materialization runs in the same Vercel Sandbox the Pass will review in, before any Reviewer process
exists, under the Sandbox's root identity. The phase **runs no repository code**: no hooks, no
filters, no submodule or LFS smudge. Nothing the head contains executes until authorization.

This is conditional on the evidence [Prototype one real Codex Pass in a Vercel Sandbox from a
Workflow step](https://github.com/nick-neely/reprove/issues/114) must return (§12). Three
alternatives were rejected:

- **Building in the Function's `/tmp`.** A Function's disk and its invocation time cannot hold or
  build an arbitrary repository, and the bytes would then have to cross into the Sandbox anyway.
- **A separate builder Sandbox.** More moving parts, a second lifecycle to reap, and no boundary the
  root-only phase does not already give: the credential is gone before untrusted code runs either
  way.
- **`Sandbox.create({ source: { type: "git" } })`.** It fetches one revision, and a Run needs two
  SHAs with full ancestry. Its stripping behaviour and credential residue are unknown, and it offers
  less control over what is fetched. It stays the **fallback** if header-injected `git fetch` fails
  in the prototype.

Both mechanisms are operated by Vercel, so "Vercel sees the token" is not the distinction between
them and does not argue for either.

## 2. Two SHAs, by SHA, with full ancestry, and then an offline verification

The setup phase fetches exactly `baseSha` and `headSha` **by SHA**, with full ancestry. No tags, no
other branches, and **never `refs/pull/N/head`**. A fork head is fetched through the **base
repository**, where GitHub already exposes it, so the Pass never authenticates against a repository
the Installation does not grant.

History depth is a **guarantee, not a number**: enough ancestry for `git log`, `git blame` and
`merge-base` to be honest. Phase 1 has no depth knob, because a knob invites a value nobody can
justify.

After the fetch process has exited, the phase verifies offline - no network operation may satisfy a
missing object, and the absence of a promisor remote means git cannot fetch one lazily:

```text
both baseSha and headSha resolve to commits
HEAD equals headSha
merge-base of base and head is non-empty
no .git/shallow file
no promisor remote and no partial-clone configuration
git rev-list --objects --missing=error <base> <head> exits successfully
```

The `rev-list` output is discarded; only the exit status matters. **These checks establish that the
objects are present, not that they are intact.** A full `git fsck` is not run, and the ADR claims
nothing about object integrity. The current head of a branch is **never** substituted for a pinned
commit: if a pinned commit cannot be retrieved, the Pass ends (§11).

## 3. Submodules and LFS are not resolved, and each is a named Limitation

Phase 1 resolves neither. Both are **detected** rather than guessed at:

- submodules from **actual gitlink entries** in the trees being reviewed, not from the presence of
  `.gitmodules`;
- LFS from **effective attributes and pointer files**, including nested `.gitattributes`, not from
  the presence of a top-level one.

Each detection records a named **Limitation** on the Result. Under
[ADR 0020](0020-reviewer-method-under-verify.md) a Limitation does not change completeness on its
own; where the missing bytes prevent finishing the requested scope, that surfaces through
`unfinished`, as ADR 0020 §5 already requires. Opt-in resolution is a later configuration key and is
not designed here.

## 4. The narrative is snapshotted at Run creation and carried on `RunSpec`

The pull request title and body are snapshotted **at Run creation**, inside
[ADR 0013](0013-github-ingress-and-run-creation-idempotency.md)'s per-pull-request critical section,
which already fetches canonical pull request state. The Worker no longer reads pull request content
at all.

The control plane bounds the snapshot there, using **one shared pure function importable by both
sides**, so there is one implementation of the bounding rule rather than two that can drift. The
snapshot preserves every distinction ADR 0012 requires: absent versus deliberately empty, original
byte counts, and truncation flags.

**`narrativeDigest`** is computed over one canonical, versioned representation of the exact bounded
snapshot supplied to the Worker. It is carried on `RunSpec`, sits **outside `configDigest`**, and
joins [ADR 0022](0022-manual-review-request.md) §6's compared inputs, so editing the description and
re-running does not no-op against a live Run that holds the old narrative.

The Worker re-validates the size limits, encodes the file, and **recomputes the digest** before
materializing it. ADR 0012's protected file, its ownership and its Refusal on failure are unchanged.

The snapshot is pull request content and follows the **same retention purge as Finding content**
under [ADR 0008](0008-persistence-tenancy-and-retention.md); the digest survives the purge, because
a digest is not the content.

## 5. Configuration reaches the Worker only through `RunSpec`

Configuration is already snapshotted at creation as `resolvedConfig` with `configDigest`
([ADR 0019](0019-phase-1-repository-configuration-subset.md) §3). The Worker receives it **only**
through `RunSpec`, recomputes the digest, and **never reads configuration from the Workspace**. The
head's `.reprove.yml` is a file under review and nothing more.

A mismatch on either `configDigest` or `narrativeDigest` is a **Failure, `spec_inconsistent`**.
[ADR 0023](0023-worker-refusal-over-a-dispatched-run.md) §2 allows a non-Refusal stop before the
authorization line, and this is one: a mismatch means corrupted internal state, not an unmet
requirement the repository could fix. It is named on the Check as a Reprove fault and is not retried
automatically.

## 6. Two independent copies of history, with ownership doing the work

```text
authoritative history   root-owned, outside the writable tree, parent directory protected too
Workspace working tree  Reviewer-owned, fully writable under verify, .git included
/reprove/input          root-owned, as ADR 0012 requires
```

The **authoritative history** is the only copy trusted code reads. Trusted git commands run against
it with a **scrubbed environment** and no Reviewer-reachable configuration, so nothing the Reviewer
can write changes what trusted code sees.

The **Workspace working tree** and its ordinary `.git` belong to the Reviewer's user and are fully
writable under `verify`, which is what ADR 0020 requires of a Reviewer that writes scratch tests.
That copy **carries no authority**: nothing trusted reads it.

The copies are **real copies**. No Git alternates and no hardlinks, because both would let the
writable copy reach objects the authoritative one depends on. The cost is deliberate: both copies,
the checkout, dependencies and fetch temporaries all count against the deployment disk ceiling
(§11).

Attribution stays where ADR 0020 left it, **instructional**. An ordinary `git diff` omits untracked
files, and an end-state diff cannot show what ran earlier, so this ADR makes **no claim of a
trustworthy record of what the Reviewer changed**, and the Check must not say attribution was
checked. A read-only tree under `inspect` is a dormant input for whoever reopens that level, not a
Phase 1 requirement: Phase 1 does not offer `inspect` ([amended by #117](#amended-by-117)).

## 7. The Reviewer gets its own user, and the protections are checked rather than assumed

The setup phase creates a **dedicated Reviewer user**. Every Reviewer-side command names that user
explicitly; nothing relies on the platform's default command identity being what it was yesterday.

Evidence comes from two places. The prototype (#114) establishes the baseline behaviour once. A
**per-Pass preflight**, run before authorization and checked against the approved image, establishes
it for this instance:

```text
effective sudo policy
privileged group membership
setuid and setgid executables
file capabilities
write, rename, unlink and replace attempts against /reprove/input,
  the authoritative history, and their parent directories
```

These checks **establish specific protections**. They do not establish that privilege escalation is
impossible, and the ADR does not say they do.

A **demonstrated unmet requirement** is a Worker Refusal, `sandbox_unenforceable`. A checker that
crashes or times out is a **Failure**, not that Refusal: a Refusal names a requirement that was shown
to fail, and a broken checker showed nothing.

## 8. `installScripts` moves to `review.installScripts` and is best-effort install behaviour

The key leaves `security:` and becomes **`review.installScripts`**, default **`deny`**.

`deny` means the Worker configures the known package managers - npm, pnpm, yarn, bun - through
**root-owned system-level configuration** to skip lifecycle scripts, both the repository's own and
its dependencies'. `allow` means normal package-manager behaviour; it does not force scripts to run.

It is **install behaviour under `verify`, not an enforced security restriction**. Repository
configuration, the environment or command-line options can override it without any deliberate
disobedience, and under `verify` the Reviewer holds a shell anyway. It is therefore **not part of the
deployment-policy meet**, it is not subject to an Owner Ceiling, and **the Check never says scripts
were blocked**. Under `inspect` no install would run at all, so the key would have no effect
there; that clause is dormant, since Phase 1 does not offer `inspect` ([amended by #117](#amended-by-117)).

This is why ADR 0019's `policy_unenforceable` contingency for the key disappears (amendment below):
there is no longer an enforcement claim that could fail.

## 9. The fetch credential is proven invalid before the Reviewer is authorized

The step mints an **installation token per Pass**, scoped to the single repository, with
**`contents: read` only**.

The token exists transiently in the trusted minting and configuration path and in the firewall. It is
**never** in the VM and never in durable Run state, with one narrow exception: **encrypted temporary
custody**, which exists so that a Function that dies mid-Pass still leaves something the revocation
path can act on.

```text
custody record   keyed by Pass; authenticated encryption bound to the Pass under a
                 deployment key read from the environment; minted and expiry times
never in         a Workflow payload, RunSpec, the execution record, or logs
read by          the host-side revocation path, and nothing else
```

**Order matters: custody is persisted before the token is installed into any Sandbox firewall.** If
persistence fails, the Pass does not proceed. A token installed before it is recorded is a token
nobody can be sure of revoking.

The token reaches `git` through a **firewall transform that injects the `Authorization` header for
`github.com`**, with TLS terminated at the proxy under the per-Sandbox CA. No credential helper, no
URL-embedded token, nothing on disk.

### The closure sequence, in order, before authorization

```text
1  the fetch process has exited, and all setup processes and helpers are confirmed terminated
2  remotes, credential helpers, hooks and extraheader settings are stripped from both copies
3  the completeness checks of §2 run
4  the trusted host revokes the token (DELETE /installation/token, 204) and confirms the exact
   stored token is invalid - two host requests per Pass
5  sandbox.update({ networkPolicy }) sets the full Reviewer-phase policy, with no GitHub transform
6  the privilege preflight of §7
7  the single instruction probe, which runs here and nowhere earlier
8  authorization
```

Step 5 rewrites the **whole** policy every time, because header transforms are **redacted on
read-back**, so a partial update cannot preserve what it cannot read. The Worker therefore owns the
entire policy it sets. What that policy actually permits belongs to [Decide what egress a verify
Sandbox is allowed](https://github.com/nick-neely/reprove/issues/113); this ADR fixes only that the
GitHub transform rule is removed, **even where GitHub stays reachable for dependency downloads**.
Reachability and authority are different things.

### Authorization requires confirmed invalidity, not a performed revocation

The condition is that **the exact stored token is invalid**, not that this invocation is the one that
revoked it. If GitHub revoked the token and the Function died before recording that, a retry
establishes invalidity again and persists it. This is the only recovery shape that survives a
Function dying at the wrong moment.

The **authenticated 204 is the evidence the token was valid**. A successful fetch is not: a public
repository fetches anonymously, so a fetch proves nothing about the credential.

Anything **unconfirmable or inconclusive** is `materialization_failed`, never success.

The custody record is **deleted in the same transaction that records invalidity**, and a sweep
deletes records past their expiry. An ending **without** authorization - a Refusal or a Failure -
attempts revocation best-effort, with GitHub's one-hour token expiry as the stated backstop. That is
acceptable precisely because **no Reviewer ever ran beside that token**.

Transform absence rests on the Worker owning the policy it set. It is **not tested from inside the
VM**: no in-VM request to `api.github.com` is required, so a Reviewer-phase policy that blocks the
API does not fail a correct Run.

**The trust statement, plainly.** Custody adds a key and a secret-storage lifecycle. It adds **no
additional privileged actor**, because the environment already holds the GitHub App private key, from
which every one of these tokens is minted. The custody record must never be reused for a
longer-lived secret; its safety argument depends on holding something that expires in an hour.

## 10. Materialization is driven across Slices, and nothing restarts automatically

Materialization runs **detached in the Sandbox** and is **polled across the Slices before
authorization**, with a cursor on the hosted-pass execution record, exactly as the turn is driven
under ADR 0021 §7. Its time counts against the configured `deadline`.

**There is no automatic restart in Phase 1.** On ambiguous execution the Pass fails closed under
ADR 0021 §7 unchanged, retains the cleanup identity - the Sandbox name - for [Decide how an abandoned
hosted pass's Sandbox is reaped](https://github.com/nick-neely/reprove/issues/88), and a person may
re-run through the Check.

Restart was rejected for reasons worth recording, because they will be re-proposed:

- a client timeout does not bound server-side completion of an in-flight create;
- a negative lookup proves only a moment, not a state;
- post-call checks do not run at all if the Function dies.

A safe restart needs documented server-side cancellation or completion semantics, or idempotent
create, and the platform has not been shown to give either. **Sandbox name uniqueness and by-name
lookup semantics are load-bearing** for step retries, and are prototype evidence (§12).

## 11. Endings

| Ending | Kind | When |
| --- | --- | --- |
| `workspace_too_large` | Refusal | measured bytes - both histories, the checkout and fetch temporaries - exceed the deployment disk ceiling |
| `commit_unavailable` | Refusal | the server reports the object unavailable in a session where an authenticated request to the same repository succeeded |
| `sandbox_unenforceable` | Refusal | a privilege requirement of §7 is demonstrated unmet |
| `materialization_timeout` | Failure | the setup time ceiling passed without a size verdict |
| `materialization_failed` | Failure | authentication, rate limit, network, a failed completeness check, a crashed checker, ambiguity, an unreadable custody record, or unconfirmable revocation |
| `spec_inconsistent` | Failure | a `configDigest` or `narrativeDigest` mismatch, per §5 |
| the existing deadline Failure | Failure | the Run's `deadline` runs out first |

`commit_unavailable` has a **narrow** trigger on purpose, and its Check wording is **"the pinned
commit could not be retrieved"**, never "no longer exists". Authentication failures, rate limits and
network failures do not establish it; only the server saying the object is unavailable, in a session
that authenticated successfully against that repository, does.

**"Retryable" means a manual re-run through the Check is permitted**, which is true of the Refusals
here as well. It does not mean the fault is transient, and nothing re-offers a Run automatically
(ADR 0023 §5).

The **numbers** for the setup-time ceiling and the disk ceiling belong to [Replace the Phase 0
windows with measured deadlines](https://github.com/nick-neely/reprove/issues/115).

## 12. Handoffs

[#114](https://github.com/nick-neely/reprove/issues/114) must report:

- which user a command runs as by default;
- that the Reviewer user cannot escalate, against the named checks of §7;
- that header-injected `git fetch` by SHA works, **including a fork head through the base
  repository**;
- whether a policy update removes the transform for `github.com` and for `api.github.com`
  **separately**;
- whether a connection opened before the update retains injection;
- Sandbox name uniqueness and by-name lookup semantics;
- whether a second create under an existing name is rejected.

[#115](https://github.com/nick-neely/reprove/issues/115) receives the setup-time and disk ceilings.
[#113](https://github.com/nick-neely/reprove/issues/113) receives the Reviewer-phase network policy.
[#88](https://github.com/nick-neely/reprove/issues/88) receives the cleanup identity.

## Consequences

- ADR 0004's host-side materialization, ADR 0012's Worker-side bounding, ADR 0019's `installScripts`
  row and its `policy_unenforceable` contingency, ADR 0011's and the PRD's `security:` examples,
  ADR 0021 §7, ADR 0022 §6 and ADR 0023 §2 are amended, each below its own text.
- `RunSpec` gains the bounded narrative snapshot and `narrativeDigest`, outside `configDigest` and
  inside ADR 0022 §6's compared set. The schema, defaults, examples and digest handling in code move
  with `review.installScripts`; that is implementation handed off by [the Phase 1
  map](https://github.com/nick-neely/reprove/issues/102), not decided again here.
- The control plane gains one durable custody record per Pass, read only by the host-side revocation
  path, deleted on recorded invalidity and swept past expiry. It is not a general secret store.
- `CONTEXT.md`'s **Workspace** entry is amended: the working tree is the Reviewer's to write under
  `verify`, and the pinned history trusted code reads is held apart from it. No new noun: the
  narrative snapshot is machinery, as ADR 0012 already says of the file it becomes.
- `docs/codex-adapter.md`'s "root-owned and unwritable by uid 1000" Workspace requirement is replaced
  by the split of §6.

## Amended by [#112](https://github.com/nick-neely/reprove/issues/112)

2026-09-23. §11 gains a Failure row, `required_permission_missing`. It applies when the §9 fetch mint
is short of `contents: read`, as [ADR
0026](0026-phase-1-app-grant-and-missing-permission-diagnosis.md) §4 establishes it: a successful mint
that returns a narrower grant, or a `403` or `422` that a failure-path lookup proves is a shortfall.
The Failure carries the per-permission comparison. That case leaves `materialization_failed`'s
"authentication". A mint failure that the lookup does not establish as a shortfall stays
`materialization_failed`.

## Amended by [#88](https://github.com/nick-neely/reprove/issues/88)

[ADR 0028](0028-reaping-a-hosted-pass-sandbox.md) changes §9 and §10.

- **§9's "a sweep deletes records past their expiry" is the ADR 0008 purge job**, reaching custody
  through `SECURITY DEFINER` functions owned by a `NOLOGIN` maintenance role (ADR 0028 §8). The
  lifecycle's reap step first attempts revocation of a token not yet confirmed invalid and deletes
  the record when invalidity is confirmed. Owner deletion cascades to custody.
- **§10's cleanup identity is the `create_requested` intent row**, written before create. The
  reaper trusts it; a negative lookup alone never confirms a Sandbox is gone.

## Observed by [#114](https://github.com/nick-neely/reprove/issues/114)

The conditions §12 handed the prototype, as observed on the `vercel/sandbox/universal` image
(Ubuntu 26.04, Node 24, git 2.53):

- **Default command user** is `ubuntu` (uid 1000), in `sudo` and `adm`, with passwordless `sudo`;
  `HOME` and the working directory are `/vercel`.
- **The Reviewer user as created cannot use `sudo`**, is in no privileged group, and the image has
  no file capabilities and only the stock setuid set (`su`, `sudo`, `passwd`, `mount` and their
  kin). **But §7's parent-directory check fails on the stock image.** The image ships
  `/usr/local/bin`, `/usr/local/lib` (with the global `node_modules`, including `@openai/codex`) and
  `/usr/local/bin/node` owned by uid 1001, which has no user; `createUser` hands the first created
  user uid 1001, so the Reviewer owns `node` on root's `PATH`. The setup phase must re-own
  `/usr/local` to root before creating the Reviewer, and the preflight must assert that no
  Reviewer-writable directory or executable lies on the `PATH` of root, the default user or the
  bridge. This is exactly the replacement §7 exists to catch.
- **Header-injected `git fetch` by SHA works**, full and `--depth=1`, with no credential inside the
  Sandbox, and a fork head fetched by SHA through the base repository's `refs/pull/*/head` works.
  A fork of a *private* base was not available to test.
- **Transforms are removed per domain**: dropping `api.github.com`'s transform left `github.com`'s
  working. A policy update took 0.3 to 0.7 s from a Function.
- **A connection opened before an update keeps its injection**: a reused keep-alive socket still
  got `200` after the transform was removed while a fresh one got `401`. §9's host-side revocation,
  confirmed invalid, is required, not belt and braces.
- **Names are unique per project while the Sandbox exists**, running or stopped: a second create
  gets `400 bad_request` ("already exists ... delete it first"); the name is free again after
  `delete()`. Names must match `^[a-zA-Z0-9_-]+$`.
- **A transform and a `forwardURL` on one domain do not compose**: in either rule order the
  forwarded request arrives without the injected header. Materialization completes under the
  transform policy and the Reviewer-phase policy replaces it; they cannot overlap. How GitHub is
  reached during review is [#127](https://github.com/nick-neely/reprove/issues/127).

## Amended by [#117](https://github.com/nick-neely/reprove/issues/117)

Phase 1 does not offer `inspect`: `review.autonomy: inspect` is a control-plane
`config_unsupported` at Run creation ([ADR 0019](0019-phase-1-repository-configuration-subset.md#amended-by-117)).
The `inspect` sentences in §6 and §8 are **dormant**: ideas for whoever reopens the level, not
Phase 1 requirements. §12's handoff of the read-only tree to #117 is withdrawn; no Phase 1 ticket
owns it.
