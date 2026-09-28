# The Phase 1 App grant, and how a missing permission is diagnosed

[ADR 0013](0013-github-ingress-and-run-creation-idempotency.md) kept the Phase 0 grant to
`Metadata: read` and `Pull requests: read`. It said the migration to the write set would be paid
"exactly once, deliberately, before Phase 1 launches". Phase 1 now has named consumers:
- [ADR 0019](0019-phase-1-repository-configuration-subset.md) §3 reads configuration at the base ref.
- [ADR 0022](0022-manual-review-request.md) uses the Check's native re-run.
- [ADR 0024](0024-hosted-workspace-materialization-and-snapshots.md) §9 mints the per-Pass fetch token.
- [ADR 0025](0025-how-a-run-appears-on-the-pull-request.md) publishes the Review, Comments and Check.

[Fix the App's one permission migration to the Phase 1 write
set](https://github.com/nick-neely/reprove/issues/112) fixes the grant and how Reprove behaves when
the grant it holds is smaller than the one it needs. Settled with the maintainer on 2026-09-23.

The facts come from the [write-surface research](../research/github-write-surface.md) §4. Three of
them shape everything below:
- **No API updates an existing App's permissions.** `manifest.ts` is a first-registration artifact.
- **Every installation must approve a widening.** Until it does, the installation keeps its old grant
  and calls that need the new permission return `403`.
- **Nothing lists which installations are pending.**

Deploy-your-own is the Phase 1 install path
([Walk the Phase 1 user journey](https://github.com/nick-neely/reprove/issues/103)). So an adopter
registers a fresh App from the manifest and gets the whole grant at once. Only the maintainer's
existing App migrates.

## 1. The grant is four permissions

```text
Metadata: read          mandatory for every App
Pull requests: write    the Review and its Comments (ADR 0025)
Checks: write           the Reprove and Reprove config Checks, annotations, and re-run (ADR 0022)
Contents: read          configuration at the base ref (ADR 0019 §3), and the per-Pass fetch (ADR 0024 §9)
```

Some consumers need nothing extra:
- The narrative is the pull request title and description only (ADR 0012), under `Pull requests`.
- Reconciliation links the prior Comment (ADR 0025 §3), under `Pull requests`.
- The pull request file list used for anchoring is `Pull requests: read`.

**`Issues: read` is excluded.** It grants read access to every issue in the repository. It belongs
to the Phase 2 comment trigger and is not declared in advance. Credential minimalism is the product's
claim, and paying for this now would contradict it.

**`Commit statuses: write` is an open question, not a decision.** GitHub's rulesets documentation
says an App pinned as a required-check source "must be installed in the repository with the
`statuses:write` permission". That has not been tested. The Check can already be required by name
without it, so it does not block Phase 1. §6 places the test. If the test shows the permission is
required, the next decision is whether pinned-source rulesets are a supported Reprove setup. The
extra grant is justified only if they are. No future migration is committed here.

## 2. `APP_EVENTS` stays the explicit subscriptions

`APP_EVENTS` stays `["pull_request"]`. The constant means *what the manifest subscribes to
explicitly*. It is not a list of what arrives. `Checks: write` automatically subscribes the App to
`check_run` and `check_suite` (ADR 0013's #108 amendment). The three default deliveries
(`installation`, `installation_repositories`, `github_app_authorization`) are absent from the
constant and cannot be declared. Adding the two check events would not make the list complete. It
would only blur what the constant means.

The automatic arrivals are documented beside the constant. **A test covers how the handler treats
each of them**, including `check_suite.requested` on every push, which stays inert.

Rejected: **listing `check_run` and `check_suite` explicitly.**

## 3. Every control-plane token is narrowed

A full-grant installation token after the migration could write Reviews and Checks and read code on
every repository in the installation. The token exchange accepts `repository_ids` and `permissions`,
and ADR 0024 §9 already uses both for the fetch token. **Every mint is narrowed** to the one
repository, by repository ID, and to the permissions its purpose needs:

| Purpose | Permissions |
| --- | --- |
| Run creation: canonical fetch and configuration reads | `pull_requests: read`, `contents: read` |
| Publication: Review, Comments, Check | `pull_requests: write`, `checks: write` |
| Per-Pass fetch (ADR 0024 §9, unchanged) | `contents: read` |

As a result, a defect in the configuration loader cannot write, and a defect in publication cannot
read code.

Rejected: **full-grant tokens** and **narrowing by repository alone**.

## 4. `required_permission_missing` is established, never inferred

A token missing a permission, or a `403` whose `X-Accepted-GitHub-Permissions` header names one,
proves that the authority was insufficient. It does **not** prove why. Two causes produce the same
signal: the installer has not yet approved a widening, or the App's own settings were never updated.
So Reprove records a reason. It does not claim a diagnosis.

**The reason is `required_permission_missing`**, and it carries the permission names that are
missing. It is assigned in exactly three cases:
- **The mint succeeds** and the returned `permissions` are narrower than the set requested.
- **The mint fails with `403` or `422`** and a lookup establishes the shortfall (below). GitHub
  documents both statuses for a request that names an unapproved permission, and neither proves a
  shortfall on its own. **If the lookup does not establish one, the existing classification stands.**
- **A call returns `403`** and the lookup establishes the shortfall.

**The lookup happens on the failure path only.** It reads the App's configured grant with
`GET /app` and the installation's approved grant with `GET /app/installations/{id}`. It records the
comparison **per permission**:

| Field | Values |
| --- | --- |
| `app` | `present`, `absent`, `unknown` |
| `installation` | `present`, `absent`, `unknown` |

`unknown` means that read failed. Either lookup can fail, and a failed read is recorded as such. It
is never guessed.

**Remedy guidance is given only when both reads succeed.** The deploy guide maps each permission's
outcome to one action:

| `app` | `installation` | Remedy |
| --- | --- | --- |
| `present` | `absent` | approve the new permissions on the installation |
| `absent` | any | edit the App's permissions in its GitHub settings, then approve |

With any `unknown`, the record names the missing permissions and says the cause is undetermined.

The normal path makes no extra calls.

Rejected: **`grant_not_approved`**. It names a cause that the evidence cannot distinguish.
Rejected: **a single `appGrantHasIt: boolean`**. Several permissions can be missing, and either read
can fail.

## 5. The reason lives on the record whose work failed

Today the ledger stores `retry_class: operator_attention` and no reason. So an operator reading the
ledger learns only that attention is needed. Each place a permission can be missing gains a durable
field on its own record:

| Where | Record | Field |
| --- | --- | --- |
| Run creation (configuration reads, canonical fetch) | ingress delivery | nullable `retry_reason` beside `retry_class`; the retry class stays `operator_attention` |
| Publication (Review, Comments, Check) | `publication` row | nullable `failure_reason` beside `state` |
| Per-Pass fetch mint | the Run | a Failure with reason `required_permission_missing` |

Each field holds the reason and §4's per-permission detail. The name differs by record because the
records differ. An ingress delivery is retried. A `publication` row can end `failed`, and there a
"retry reason" would mislead.

### The `publication` row exists before the first write

A publication failure can be recorded only if its row exists **before** the first GitHub write.
[ADR 0025](0025-how-a-run-appears-on-the-pull-request.md) §5's invariant therefore becomes **one row
per intended Check**, not one per published Check:
- **The row is created `pending` with a durable subject identity**: its `external_id`
  (`reprove.run.<id>`, `reprove.refusal.<id>` or `reprove.config.<id>`), unique per Owner. Each
  subject has exactly one intended Check, so a retry finds the existing row and never creates a
  second one.
- **The Check Run id and suite id are nullable** until GitHub returns them. `github_review_id` is
  already nullable.

## 6. One handoff, one migration, and the window is the experiment

The migration is a single handoff ticket and lands first. It widens `APP_PERMISSIONS` to §1, adds
§2's test, §3's narrowing, and §4 and §5's reason fields. **It blocks every handoff ticket that
consumes the new grant.** No consumer widens the constant piecemeal, so the maintainer's App migrates
once.

The maintainer performs the migration on the deployment's App:
1. Read `GET /app/installations/{id}` `permissions` as the baseline.
2. Edit the App's permissions in its GitHub settings and save.
3. **In the window before approving**, do three things:
   - Mint a token narrowed to `checks: write` and record the status and body. This settles which of
     `403` and `422` an unapproved narrowed mint returns.
   - Read the installation's `permissions` again. This settles whether an owner's own installation
     is approved automatically, which is inferred today as "not" and never documented.
   - Confirm that §4 records `required_permission_missing` with `app: present, installation: absent`.
4. Approve on the installation, then confirm that `permissions` has widened and that
   `installation.new_permissions_accepted` arrived and was handled as inert.

**`new_permissions_accepted` stays inert.** It triggers no catch-up review, because reviewing pull
requests already open at install time is deferred
([Walk the Phase 1 user journey](https://github.com/nick-neely/reprove/issues/103)).

The same handoff runs §1's pinned-source ruleset test on
[`nick-neely/reprove-fixture`](https://github.com/nick-neely/reprove-fixture) with the scratch App.
It adds a ruleset that requires the Check pinned to the App, with and without `statuses: write`, and
records whether the App can be selected as the source and whether the required check is satisfied.
This is an observation, not a blocker.

## 7. Each grant widening is an adopter upgrade step

With deploy-your-own, every adopter owns an App. **A widening is paid once per grant widening, by
every adopter.** Each adopter edits their App's permissions by hand and approves on each installation.
Neither step has an API. The trigger is the widening itself, not a phase boundary, and one phase may
contain several widenings.

Each widening is therefore an **adopter upgrade step**. It ships with the release that needs it,
states the permissions and why, and relies on §4's reason to point an adopter who skipped it at the
fix. Declaring grants before they are needed is still rejected, for §1's reason.

## Consequences

- **ADR 0013 is amended**: its grant is replaced by §1, and "exactly once, deliberately, before
  Phase 1 launches" becomes §7's "once per grant widening, by every adopter". Its "one explicit
  subscription" framing stands, per §2. The amendment lands below that ADR.
- **ADR 0024 §11 gains a Failure row**: `required_permission_missing`, for a per-Pass fetch mint §4
  establishes as short. It is taken out of `materialization_failed`'s "authentication". The amendment
  lands below that ADR.
- **ADR 0025 §5 is amended** to one row per intended Check, created `pending` with `external_id` as
  its durable identity, and nullable Check Run and suite ids. The amendment lands below that ADR.
- `manifest.ts`'s doc comment, `APP_PERMISSIONS`, `manifest.test.ts`, the token mint sites, the
  ingress, `publication` and Run schema changes, and the deploy guide's remedy table are implementation
  handed off by [the Phase 1 map](https://github.com/nick-neely/reprove/issues/102). None of it is
  made here.
- `CONTEXT.md` gains nothing. An adopter upgrade step is release process, not domain vocabulary, and
  the **Installation** entry ("a live grant") already covers the approved grant.
