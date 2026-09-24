# Phase 1 honours a fixed subset of repository configuration under a named product default

[ADR 0011](0011-repository-configuration-contract.md) fixed the `.reprove.yml` contract and
[ADR 0013](0013-github-ingress-and-run-creation-idempotency.md) refused to let a Phase 0 fixture
become a product default. Neither said which keys the first usable release acts on, what governs a
repository that has no file, or what carries a Refusal that happens before any Run exists.
[Fix which repository configuration Phase 1 honors and how a Run's Harness and Model are
selected](https://github.com/nick-neely/reprove/issues/106) settles those. This ADR is the
authoritative policy table; ADR 0011 and ADR 0013 carry short amendments that point here rather
than restating it.

## 1. A schema-valid key is honoured or refused, never inert

ADR 0004's *nothing warns and runs* rule leaves no room for a key that parses and then does
nothing: a repository that wrote it asked for something, and silence is a downgrade. Phase 1 has
two classes.

**`review:` keys** are honoured when the product can act on the value and are otherwise a
control-plane Refusal with a new reason, **`config_unsupported`**, naming the key and the value.

| Key | Phase 1 |
| --- | --- |
| `enabled` | honoured; `false` means no Run is created (§5) |
| `worker` | `hosted` honoured; `self-hosted` is `config_unsupported`, there is no self-hosted Worker before Phase 3 |
| `harness` | `codex` honoured; `claude-code` and `opencode` are `config_unsupported` |
| `model` | honoured when it names the one Model the production catalogue holds for the Harness (§2); any other value is `config_unsupported` |
| `strategy` | `standard`, the only value the schema admits |
| `autonomy` | `inspect` and `verify` honoured; `fix` is `config_unsupported`. Whether the resolved Harness build can enforce `inspect` stays a dispatch-time Refusal per ADR 0011 §5 |
| `budget` | honoured as a soft spending limit in USD (§7); `config_unsupported` when the pricing revision carries no price for the resolved Model |
| `deadline` | honoured; bounds Reviewer execution time, not the claim window (§8) |
| `event`, `threshold`, `ignore`, `commands`, `baseConventions`, `overrides` | honoured as ADR 0011 defines them |
| `harnessOptions.codex.reasoningEffort` | honoured, narrowed by the catalogue for the resolved Model |

The distinction from ADR 0011 §5's dispatch-time Refusal is *what is known where*: "the product
has no self-hosted Worker" is known at Run creation; "this Harness artifact cannot enforce
`inspect`" is known only from the Worker's behavioural probe.

**`security:` keys** are never `config_unsupported` for the keys that exist today. Two steps apply,
kept apart: the meet of ADR 0011 §3 produces the effective policy, and whether the hosted Worker
can *enforce* that effective policy is a separate question, answered by a Refusal when it cannot,
never by choosing another policy.

| Key | Narrowing in Phase 1 | Enforceability |
| --- | --- | --- |
| `maxExposure` | none; the ceiling stays as written | the dispatch gate compares the Run's actual Exposure (brokered execution is `scoped`) against the ceiling; both `scoped` and `account` are satisfied. A ceiling is a permitted maximum, not the Exposure the Run receives |
| `allowExternalProvenance` | none | already gated at dispatch (ADR 0004) |
| `egress` | intersected with the boundary set [#113](https://github.com/nick-neely/reprove/issues/113) fixes | Worker Refusal when the Sandbox cannot enforce the resolved set |
| `installScripts` | none | Worker Refusal when the materialization [#110](https://github.com/nick-neely/reprove/issues/110) fixes cannot enforce `deny` |
| `allowHostedFallback` | none; recorded as written and mirrored onto `spec.allowHostedFallback` | trivially satisfied: the Run's placement is `hosted`, so a fallback never arises |

The `egress` and `installScripts` rows are contingent on the tickets named in them. The
"never `config_unsupported`" statement covers the current keys and is not a rule for keys added
later: a future security key may well name functionality that does not exist.

**An unenforceable effective policy is a Worker Refusal at dispatch** with the documented, stable
reason **`policy_unenforceable`**: `required` names the key and effective value, `actual` names what
the Sandbox or materialization offers. The control plane keeps no table of what the hosted Worker
can enforce, for the reason ADR 0009 retired version allowlists. A Run ended this way must remain
distinguishable from one that simply found no Worker; `unscheduled` alone cannot say which
happened, and [#95](https://github.com/nick-neely/reprove/issues/95) and
[#111](https://github.com/nick-neely/reprove/issues/111) carry that requirement.

## 2. The product default is named, and the resolved snapshot always states the selection

This is where the default ADR 0013 refused to inherit is agreed. When the file is absent or omits
the key, a Run resolves to:

```text
harness        codex
model          gpt-5.6-sol       the target lineage; unqualified until the gate says otherwise
autonomy       verify
strategy       standard
reasoningEffort medium
```

> Amended 2026-09-24: the default Model is now `gpt-6-sol`, on a Codex runtime pinned at 0.156.1.
> See [Amended by #130](#amended-by-130).

plus every default ADR 0011's schema already declares. The values live in one named
`PRODUCT_DEFAULTS` value in the control plane. The default Model is an explicit named constant,
not `MODEL_CATALOGUE[0]`.

**The production catalogue holds exactly one selectable Model per Harness** in Phase 1, keeping
[the map](https://github.com/nick-neely/reprove/issues/102)'s deferral of Model selection to
Phase 2. Fixture catalogues that existing tests need stay in test code.

**`harness`, `model`, `autonomy` and `deadline` are required in `resolvedConfig`** even though they
stay optional in the file. The snapshot then always states what was selected, and `configDigest`
changes whenever the product default changes, which is the correct outcome: a Run under a
different default ran under a different configuration. Requiring the fields makes the selection
visible; it does not force Phase 2 to reconsider it.

**Provenance of each value, `configured` or `default`, is recorded beside the snapshot and
outside the digest.** Explicitly configuring the default produces the same digest as inheriting it.
The Check summary can therefore say `codex (default)` without the digest disagreeing.

Parsing preserves explicit-versus-absent values, so the Owner layer ADR 0011 §3 designed can be
added when it has a consumer. Phase 1 adds no Owner table, no query, and **no unused Owner
argument**; the resolution is `PRODUCT_DEFAULTS -> repository file`, and the `security:` meet
applies only against the Reprove boundary.

## 3. The loader runs on the control plane, inside the critical section

The whole file is read from the base ref at Run creation, as ADR 0011 §2 requires:
`GET /repos/{owner}/{repo}/contents/.reprove.yml?ref={baseSha}`, followed by the same request for
`.reprove.yaml` when the first returns `404`, so a misnamed file is a `config_misnamed` Refusal and
not a silent fall-through to defaults. Both reads need **`Contents: read`**, which
[#112](https://github.com/nick-neely/reprove/issues/112) records as a consumer named by this ADR.

Both reads happen **inside** ADR 0013's serialized critical section, pinned to the canonical
`baseSha`, so that a Run's configuration is read from the same base its spec records. The section
is bounded as a whole: the canonical pull request fetch and both configuration reads share one
hard client timeout under the existing `idle_in_transaction_session_timeout` backstop. Reading
before the lock against the branch tip and discarding on mismatch was rejected as a retry loop
for a rare case; creating the Run first and resolving later was rejected because it breaks "the
Run is complete at creation".

**Missing permission, transient failure and missing file are three distinct outcomes**, and
failed access never selects defaults. A missing file resolves under `PRODUCT_DEFAULTS`; a `403`
is `operator_attention`; a network failure is `transient`, both in ADR 0013's existing retry
classes. There is no memoization initially. If one is added later it caches the bounded,
immutable file bytes keyed by `(repositoryId, baseSha)`, never the resolved configuration, because
resolution also depends on defaults and catalogue policy that change without the SHA changing.

`configDigest` stays `hash(canonical(resolvedConfig))` as `profile.ts` already computes it, with
`schemaVersion: 1`.

## 4. A control-plane Refusal is its own record, and no Run exists

ADR 0011 §5 said a `config_invalid` Refusal produces a failing Check and no Run. The Check still
needs something durable to be published from and retried against, and ADR 0013's ledger row is
the wrong home: it carries no head, no publication state, and a manual request from
[#108](https://github.com/nick-neely/reprove/issues/108) arrives with no delivery at all.

**A `refusal` table**, Owner-scoped and RLS-covered like every tenant row under ADR 0008:

```text
ownerId, repositoryId, pullRequestNumber
headSha, baseSha                the head the Check targets, the base the file was read from
trigger                         automatic | manual
reason                          config_invalid | config_too_large | config_misnamed | config_unsupported
keyPath                         a path such as review.worker, never file content
createdAt
Check publication identity and state, the same fields a Run's Check uses
```

The ingress ledger records `done` with a pointer to the Refusal, symmetric with a created Run.
**Ledger dispositions are still not Refusal vocabulary**: the delivery was processed to a
conclusion, and the conclusion is the Refusal record, not the disposition.

A Run with a new terminal status `refused` was rejected: a refused Run has no resolvable
`harness`, `model`, `resolvedConfig` or `configDigest`, so `spec` would need nullable fields, which
ADR 0007 and ADR 0013 exist to forbid.

**Duplicate suppression.** An automatic trigger no-ops when a Refusal already exists for the same
`(ownerId, repositoryId, pullRequestNumber, headSha, baseSha)`. The existing "any Run at this head"
rule cannot cover this, because no Run exists. A different base at the same head, for instance a
pull request reopened after the base branch fixed the file, re-evaluates, because the
configuration that refused has changed. **A suppressed repeat still reconciles the Refusal's Check
when it is unpublished.** A manual request always re-evaluates and produces a fresh Refusal or a
Run.

**Recovery after a deployment-only change requires an explicit manual retry.** Unchanged SHAs do
not imply unchanged defaults, catalogue or pricing, and a `policyRevision` digest in the
suppression key was rejected: its completeness would become correctness-critical and it would miss
loader fixes and other implementation changes anyway. Manual retry is explicit and already
required through #108. GitHub's manual redelivery is not a recovery path here either: ADR 0013
re-reads the ledger state under the lock and a terminal delivery never acts again.

## 5. `enabled: false`

No Run is created and the ledger records `discarded: disabled`. No review Check is posted, since a
Check that says "disabled" on every pull request is noise; the `Reprove config` Check still runs on
pull requests that change the file (§6).

**Newly disabled configuration and a live Run.** Whenever an eligible automatic or manual trigger
resolves the current base configuration and finds `enabled: false`, it supersedes the live Run per
ADR 0013 and creates no successor. Stopping the superseded Pass and fencing its Check is
[#118](https://github.com/nick-neely/reprove/issues/118)'s question, which gains "superseded with
no successor" as a case. **A base-only change is unobserved until such a trigger**: a push to the
base branch fires no `pull_request` event, so a Run created before the change runs to completion
under the configuration it was created with, exactly as ADR 0011 §2 intends.

## 6. The `Reprove config` Check validates the head with the same loader

It runs when the pull request's file list, which the `Pull requests: read` endpoint already
provides, touches `.reprove.yml` or `.reprove.yaml` in any status: added, modified, removed, or
renamed with either name as the previous filename. It reads the head file at `headSha` through the
same parse, schema, Phase 1 support, catalogue membership and reasoning-effort narrowing as Run
creation, and never applies the result. It reports **what would apply if merged**: on success, the
resolved values including any narrowed `security:` value as "requested X, effective Y"; on a
deletion, the product defaults; on failure, the key. It runs independently of review eligibility
and of any Refusal, as ADR 0011 §8 requires. How it publishes belongs to #111.

## 7. `budget` is USD, a soft limit, and Usage is reported regardless

`budget` is denominated in **USD**, derived from Usage through a control-plane price catalogue
under a **named pricing revision recorded on the Run at creation**. Both token Usage (input,
output, cached input, reasoning where reported) and the estimated USD cost are captured on the
Run and shown on the Check; token reporting needs no configurable token limit.

Because Usage is checked after a step, a step can overshoot, so this is a **soft spending limit**
unless [#115](https://github.com/nick-neely/reprove/issues/115) establishes a hard bound. A
`deadline` bounds time, not spend. When `budget` is configured and a step reports no Usage, the
remaining budget cannot be established: execution stops before the next step and the accounting
failure is surfaced. Without a budget, continuing with an explicitly incomplete cost estimate is
reasonable. Classifying those runtime outcomes belongs to #115, as does the default when `budget`
or `deadline` is omitted. A configured `budget` on a Model the pricing revision does not price is
`config_unsupported`; a single catalogue Model does not by itself guarantee a price exists.

## 8. `Phase0RunProfile` is replaced in three parts

```text
configuration      the loader, with PRODUCT_DEFAULTS underneath
placement          a constant: hosted, allowHostedFallback false, until Phase 3
DeploymentPolicy   claimableForMs and livenessForMs, environment-readable, values from #115
```

`PHASE_0_RUN_PROFILE` is deleted. The CI acceptance scenario feeds a fixture `.reprove.yml`
through the real loader instead of injecting a profile, so the scenario exercises the path
adopters hit.

**`deadline` means Reviewer execution time.** The protocol and spec comments that described it as
the claim window are corrected in the same change as this ADR; leaving both meanings in place
invites an implementation bug in which the claim window is set from a Reviewer key.

## Consequences

- ADR 0011 §5 gains `config_unsupported` and the Refusal record; §10's resolved snapshot gains four
  required fields and a provenance sidecar outside the digest. ADR 0013's "not Refusal vocabulary"
  explanation is revised, its dispositions gain `disabled`, and `Contents: read` gains a consumer.
- #112 adds `Contents: read` for configuration reads. #108 inherits the manual path through the
  Refusal record and the rule that a manual request always re-evaluates. #111 inherits publishing a
  Check from a Refusal and reconciling an unpublished one. #115 inherits the omitted-`budget` and
  omitted-`deadline` defaults and the classification of missing-Usage outcomes. #118 gains the
  no-successor case. #95 and #111 must keep `policy_unenforceable` distinguishable from finding no
  Worker. #110 and #113 own the enforceability of `installScripts` and `egress`.
- `CONTEXT.md` gains no noun. "Product default" is ordinary language and Refusal already covers
  the control-plane origin.

## Amended by [#108](https://github.com/nick-neely/reprove/issues/108)

2026-09-21. [ADR 0022](0022-manual-review-request.md) builds the manual request §4 relies on twice,
and two sentences there were written against a shape it does not have.

### A manual request does arrive as a delivery

§4 justifies the Refusal record partly on the claim that "a manual request from #108 arrives with no
delivery at all". It does not. The manual surface is GitHub's Check re-run, which arrives as an
ordinary signed webhook delivery and passes through ADR 0013's ingress ledger unchanged, so the
same GUID with a terminal ledger state is still a duplicate no-op and a nonterminal one still
resumes.

The conclusion is unaffected and the remaining reasons carry it on their own: the ledger row carries
no head and no publication state, so it cannot be the durable home a Refusal's Check is published
from and retried against.

### "Always re-evaluates" is about evaluation, not about the outcome

§4's "A manual request always re-evaluates and produces a fresh Refusal or a Run" overstates the
second half. The accurate statement is:

> A manual request is never suppressed by the duplicate rules above, and whenever it reaches
> evaluation it re-evaluates the current base configuration. **What it produces** is ADR 0022 §5's
> order and table: a visible no-op, before any configuration is loaded, on a closed pull request or
> a stale head; a no-op where an equivalent live Run already exists at the canonical head; and
> `discarded: disabled` where the re-evaluated configuration says `enabled: false`.

The property §4 actually needs is preserved exactly: an existing Refusal at the same head and base
never suppresses a manual request, and a manual request is what recovers from a deployment-only
change no digest captures. Equivalence there is ADR 0022 §6's named comparison, not whole-spec
equality.

## Amended by [#110](https://github.com/nick-neely/reprove/issues/110)

[ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md) settles the materialization §1's
`installScripts` row was contingent on, and the answer moves the key rather than making the row
true.

### `installScripts` leaves `security:` and becomes `review.installScripts`

The key is **`review.installScripts`**, default **`deny`**, and its row leaves the `security:`
table. `deny` configures the known package managers through root-owned system-level configuration to
skip lifecycle scripts; it is best-effort install behaviour under `verify`, which repository
configuration, the environment or a command-line option can override without any deliberate
disobedience. It is therefore not part of the deployment-policy meet, takes no Owner Ceiling, and
the Check never reports that scripts were blocked.

As a `review:` key it is honoured for both values, so it is not `config_unsupported` either.

### Its `policy_unenforceable` contingency is deleted

The `installScripts` row's "Worker Refusal when the materialization #110 fixes cannot enforce
`deny`" is **removed**, not restated: there is no longer an enforcement claim that could fail.
`policy_unenforceable` keeps its full meaning for **`egress`**, where the Sandbox either enforces the
resolved set or does not, and §1's definition of the reason is otherwise unchanged. The consequence
line "#110 and #113 own the enforceability of `installScripts` and `egress`" is narrowed to
`egress`.

Schema, defaults, examples and digest handling in code move with the key. That is implementation
handed off by [the Phase 1 map](https://github.com/nick-neely/reprove/issues/102), not a further
decision.

## Amended by [#130](https://github.com/nick-neely/reprove/issues/130)

2026-09-24. `gpt-6-sol` shipped on 2026-09-14 at half `gpt-5.6-sol`'s price. [What moving the Codex
pin to 0.156.1 changes](../research/codex-pin-bump-0156.md) found that the first Codex release with
`gpt-6-sol` metadata, 0.156.1, moves the Model onto Responses Lite with code-mode-only tools, the
request shape openai/codex#31894 reports as leaving `codex exec` with no callable tools.
[Check whether code-mode tools run on a brokered Codex turn for gpt-6-sol and
gpt-5.6-sol](https://github.com/nick-neely/reprove/issues/131) settled that live: tools executed on
13 of 13 Passes through the real brokered Adapter, on both Models, and every instruction probe
passed. The default therefore moves.

### The product default Model is `gpt-6-sol`

§2's `PRODUCT_DEFAULTS.model` is **`gpt-6-sol`**. Every other default is unchanged, including
explicit `medium` reasoning, which is also the Model's own default. The advertised reasoning efforts
stay `low` through `max`, because the bridge's typed interface stops there.

The move **replaces, it does not add.** The production catalogue still holds exactly one selectable
Model per Harness, so `model: gpt-5.6-sol` in `.reprove.yml` becomes `config_unsupported` like any
other value. The price catalogue swaps its row for `gpt-6-sol` at $2 input, $0.20 cached input and
$10 output per 1M tokens, under a **new pricing revision**. The request carries `service_tier: null`
on this route, so the Model's catalogued `priority` tier is not billed.

The target Lineage becomes **`codex/brokered/openai/gpt-6-sol/verify/standard`**. It is unqualified,
as the old one was; ADR 0018 and [#53](https://github.com/nick-neely/reprove/issues/53) qualify it.
The Phase 0 Lineage line in `CONTEXT.md` and the gate's Phase 0 record stay as history.

### The Codex runtime is pinned exactly and bumped deliberately

The Adapter-owned frozen bootstrap lock moves Codex CLI and SDK from 0.153.4 to **0.156.1**. The
Harness core stays at **1.0.102** and the bridge at **1.0.104**: the SDK's JavaScript is
byte-identical from 0.153.4 to 0.156.1, and the bridge reaches the CLI only through it.

- **Exact pins, never a floating range.** Each bump is a reviewed catalog change under ADR 0014,
  produces a new Revision, and needs the contract suite plus requalification. Automated bump pull
  requests may surface updates; they do not merge themselves.
- **"Latest" means the newest release that passes the re-check list** below when the handoff is
  cut, not the newest on npm.
- **The bridge moves separately, later.** Bridge 1.0.125 must move with core 1.0.123, and it removes
  `createCodex({ model })`, so a Pass that does not pass `model` on each turn silently runs
  `gpt-5.5`. It also moves bootstrap and session state under `$HOME/.ai-sdk-harness`, which moves
  the preflight symlink and the hosted bootstrap path, and it embeds Codex 0.155.0, which has no
  `gpt-6-sol` metadata. Nothing in it is needed for `gpt-6-sol`.

### What the bump re-checked

| Assumption | On 0.156.1 with bridge 1.0.104 |
| --- | --- |
| `gpt-6-sol` runs on fallback metadata | changed: real metadata, no warning |
| `apply_patch` is absent for `gpt-6-sol` | changed: registered, nested under code-mode `exec` |
| Tools are callable, commands reach Evidence as `command_execution` then `bash` | unchanged, proven live by #131 on both Models |
| Instruction boundary: `--ignore-user-config`, `--ignore-rules`, `project_doc_max_bytes=0`, `skills.include_instructions=false`, ADR 0009 canaries | unchanged; the checked insertion still matches and 13 of 13 live probes passed |
| Credential forwarding, the placeholder check, no ambient host credential | unchanged; the bridge's code is unchanged |
| The Harness throws on non-`allow-all` `permissionMode` and on built-in tool filtering, and forces `danger-full-access` | unchanged |
| `features.shell_tool=false` removes shell execution | the flag is unchanged, but `apply_patch` and the `collaboration` namespace survive it, so it no longer yields a read-only tool set. Input to [#117](https://github.com/nick-neely/reprove/issues/117) |
| Detach, suspend, reattach; the harness falls to `rerun` silently | unchanged, since the bridge and core are unchanged. Input to [#128](https://github.com/nick-neely/reprove/issues/128) |
| The bridge cannot interrupt a running turn | unchanged: an abort kills the CLI. Input to [#129](https://github.com/nick-neely/reprove/issues/129) |
| Slice Usage is zero until `finish` | unchanged |
| Instruction probe cost | measured at a mean of $0.019 per probe on `gpt-6-sol` |

### Handoff items

- **Bump the lock, move the default, swap the price row** as above, and correct `docs/codex-adapter.md`,
  whose pins, defaults and "latest bridge remains 1.0.104" line are all stale.
- **Give the contract suite a code-mode reply.** `tools/codex-contract.test.mjs` answers with a
  top-level `exec_command` call and cannot detect a code-mode tool failure. It gains a
  `functions.exec` custom tool call.
- **Blocked by [Parse a Codex turn's answer from its final message, not every text
  delta](https://github.com/nick-neely/reprove/issues/132).** Without it every `gpt-6-sol` Pass fails
  as `result_invalid`, so no real core is integrated before it lands.
- The provider proxy drops the `x-openai-internal-codex-responses-lite` header the CLI sends for
  these Models. #131 saw no observable difference either way; the handoff decides whether to forward
  it.
