# Persistence, tenancy and retention

[#2](https://github.com/nick-neely/reprove/issues/2) settled that **Owner** is the tenant and
that Reprove keeps no membership table. [ADR 0006](0006-worker-protocol.md) handed here the
Worker record implied by enrollment, and [ADR 0007](0007-run-result-and-finding.md) handed
here the publication record's persisted shape and the prior-side reconciliation record, having
already deleted `Artifact` and given `Result` no table at all. This ADR decides the schema,
how the tenant boundary is enforced, what Reprove durably keeps, and what removes it.

Two of the decisions below exist only because research contradicted the assumption they were
built on, and both are recorded with the fact that moved them.

## Tenancy is enforced by Postgres, not by discipline

**Application-level scoping plus Row-Level Security**, not either alone. Under scoping alone a
forgotten `WHERE owner_id` returns another Owner's Findings, and that defect is invisible in
review and in any test suite that only ever holds one tenant. Under RLS the same bug returns
zero rows.

Schema-per-tenant was rejected on migrations: a GitHub App serving thousands of Owners cannot
fan a migration across thousands of schemas, and the self-hosted single-tenant case gains
nothing from the isolation it buys.

Six rules, all load-bearing:

1. Every Owner-scoped query executes inside an **explicit transaction**.
2. Tenant context is set with **transaction-local state only** (`SET LOCAL app.owner_id`).
3. The runtime uses an **interactive-transaction-capable driver**, not the Neon HTTP driver.
4. The runtime role is **not the table owner, not superuser, and has no `BYPASSRLS`**.
5. The migration and admin role is **separate** and never used by ordinary application traffic.
6. Boot **refuses to serve** if the runtime role or the policies are misconfigured.

Rules 2 and 3 exist because Neon runs PgBouncer in transaction mode: a bare `SET` is silently
lost when the connection returns to the pool, which is a tenant-context leak rather than an
error, while `SET LOCAL` is scoped to the transaction and cannot outlive it. Drizzle's
`db.transaction(async tx => ...)` needs the WebSocket or Pool driver, because the HTTP driver
offers only non-interactive one-shot transactions. The pooled endpoint is still correct; it is
the driver that changes.

Rule 4 exists because `neon_superuser` carries `BYPASSRLS` and is granted to roles created
through the Neon console, CLI or API, including the default project role. Connect as that role
and every policy is ignored with no error at all. `FORCE ROW LEVEL SECURITY` on Owner-scoped
tables is required as well, but it is defense in depth and **does not replace the restricted
role**.

Rule 6 is what makes the other five falsifiable. Rule 4 fails **silently**, which is the class
[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) bans outright, and without a boot
assertion the strongest guarantee in the schema is one connection-string typo away from being
decorative, in the hosted deployment and the self-hosted one alike.

All access is intended to run through a single entry point of the shape `withOwner(ownerId, tx
=> ...)`, so that a tenant-scoped query written outside a tenant transaction is difficult to
write by accident rather than merely forbidden by convention.

**Not** Neon RLS (formerly Neon Authorize): it is JWT-based via `pg_session_jwt` and expects a
per-request signed token from an external issuer, while Better Auth issues an opaque cookie
session. Using it would mean minting JWTs solely to satisfy Postgres. Plain GUC-driven RLS is
standard Postgres, fully supported on Neon, and independent of that feature.

Drizzle's RLS API moved from `.enableRLS()` to `pgTable.withRLS()` across majors, so it takes
the same exact-pin treatment [ADR 0005](0005-adapter-boundary.md) applies to churning upstream
packages.

### The tenant key is GitHub's numeric Owner id

Resolving the Owner can itself require a lookup, and a lookup needs a tenant context, so the
bootstrap is circular unless something breaks it. Leaving an accidental `BYPASSRLS` path as the
bootstrap mechanism would defeat the whole design.

Every pre-tenant entry point was enumerated:

| entry point | Owner locator available before any query |
| --- | --- |
| GitHub webhook | `installation.id` and `repository.owner.id`, signature-verified first |
| Worker enrollment | only if the enrollment code carries one |
| Worker claim, renew, progress, Result | only if the credential carries one |
| Dashboard request | Better Auth session, then live GitHub |
| Better Auth's own tables | not Owner-scoped; outside the policy |
| health checks, cron | no Owner-scoped query |

Only the two Worker paths lacked a locator, and both are credentials Reprove itself mints. So
**every Reprove-minted credential carries a non-secret Owner locator**:

```
credential = <ownerLocator>.<secret>

begin transaction
  -> SET LOCAL app.owner_id = ownerLocator
  -> verify the credential inside that tenant
  -> only after verification may normal work execute
```

A forged locator is safe by construction: it only changes which tenant's credential lookup
returns nothing. **That safety argument holds only if the pre-authentication transaction does
exactly one thing** - verify the credential - and nothing else runs until it succeeds. This
restriction is load-bearing and is part of the decision, not an implementation note.

The alternative, a narrow system-identity lookup living outside Owner RLS, was rejected because
it requires the boot assertion in rule 6 to carry an **allowlist of exempt tables**, and an
allowlist is precisely the thing that grows quietly.

**`owner.id` is GitHub's durable numeric Owner id**, and it is the tenant key throughout the
schema. A Reprove-minted uuid would reintroduce the circularity on the webhook path, since the
payload carries GitHub's id and mapping it to a uuid is itself an unscoped lookup, which would
force an exemption for `owner` and land back in the rejected option wearing a smaller hat. The
coupling to a third party's identifier is real but not meaningful here: `CONTEXT.md` defines an
Owner as a GitHub user or organization, so it has no identity independent of GitHub; GitHub
treats the numeric id as durable while logins may change; and the ids never collide across the
user and organization spaces. Carrying both an internal uuid and an external tenant id would
buy no distinction worth the second identifier.

**Every Owner-scoped table carries `owner_id` denormalized and indexed**, including `finding`,
`publication` and `worker_credential`, which reach the Owner only transitively. Each policy is
then a direct comparison rather than a subquery join.

## The Better Auth seam

Better Auth owns `user`, `session`, `account` and `verification`. **Reprove adds no User table
and no User-to-Owner membership relation.** Better Auth's `user` row *is* `CONTEXT.md`'s User,
and `account.accountId` is the provider-side GitHub identity, treated as Better Auth and
provider data rather than duplicated into a Reprove entity.

`owner` has **no foreign key to any user**. That is what makes #2's test pass structurally
rather than by care: one person installing on a personal account and on an organization is two
`owner` rows, and nothing in the schema fights that because nothing joins the two concepts at
all. Authorization from User to Repository is live GitHub state, not a Reprove row.

Better Auth's tables sit **outside Owner RLS**. A User can legitimately reach several Owners,
so applying Owner tenancy to authentication tables would model the relationship incorrectly.

Better Auth has **no GitHub App installation flow** - nothing for `installation_id`,
installation callbacks or installation tokens - so `installation` being Reprove's own entity is
forced rather than chosen. With Drizzle it also does not manage its own migrations: the CLI
emits a schema file the app owns, so Better Auth's tables and Reprove's share one migration
history.

## Authorization is answered by GitHub

Reprove does not rebuild GitHub's permission graph. For a dashboard listing:

```
User's GitHub App token
  -> repositories accessible to that User within the Installation
  -> intersect with Reprove's Repository rows
```

For individual access, a live GitHub-authorized read, **failing closed** if GitHub or token
refresh cannot establish access.

**There is no durable permission cache and no permission table.** "What may a stale cache
authorize" then has an answer that cannot rot, and a removed collaborator loses access to
Findings - which quote source - immediately rather than after a TTL.

This keeps a credential belonging to a person in Reprove's database, and the decision to keep
it reverses an earlier position that was based on a false premise. The premise was that GitHub
access tokens "stay valid indefinitely", which is true of **classic OAuth Apps** and not of a
GitHub App: a GitHub App user access token expires in **eight hours**, is backed by a six-month
refresh token, and reaches only the **intersection** of repositories where the App is installed
and the user can access. It also spends the **user's** rate limit rather than the
installation's, which matters because the installation pool is what the Run pipeline spends on
webhooks, Checks, Reviews and ADR 0007's one fetch per affected file.

The installation-token alternative is genuinely available -
`GET /repos/{owner}/{repo}/collaborators/{username}/permission` accepts an installation token,
needs only `Metadata: read`, and reports the calculated permission "after considering all
sources of grants, including: repo, teams, organization, and enterprise", so team-inherited
access is visible. But there is **no bulk equivalent**: the only endpoint answering "which
repositories in this installation can this user see" in one call is user-token-only. Dropping
the user token would therefore turn every listing into one call per repository, on the pool the
pipeline needs. It remains the fallback for anything that must be answered with no user present.

Two requirements follow, and the first is a code requirement rather than a documented intention:

- **Reprove verifies at authentication and refresh time that GitHub issued an expiring access
  token and a refresh token**, and refuses or fails configuration loudly otherwise. Token
  expiration is default-on for new GitHub Apps but is still a toggle; opting out silently
  converts every stored token into a permanent one. A security property that depends on a
  settings page nobody re-reads is not a property.
- **`account.encryptOAuthTokens = true`.** Better Auth stores OAuth tokens in plaintext by
  default; this gives AES-256-GCM. The refresh token is the six-month one.

The exact negative-response semantics of the fallback endpoint - whether a user without access
yields `200` with `permission: "none"` or a `404` - are **not** foundation-locked. GitHub
documents `none` as a permission value and also documents `404` for the endpoint. Test it
empirically before code depends on the distinction.

## Entities

```
Better Auth, untouched:  user  session  account  verification

owner              tenant; id IS the GitHub numeric owner id; login, type(user|organization)
installation       revocable grant; revokedAt; carries no identity across a reinstall
repository         githubRepoId; scope state          (review configuration: see below)
worker             workerId, registration data, liveness, protocolVersion, workerBuildVersion
worker_credential  workerId, secretHash, createdAt, expiresAt, revokedAt
enrollment_code    hash, ownerId, expiresAt, consumedAt
run                spec + resolution + state, one row; absorbs the Result on acceptance
finding            belongs to run; bucket_key, bucketKeyVersion, dispositions
publication        belongs to run; the Review record and its reconciliation
```

**`run` is one table, not three.** ADR 0007's `spec` / `resolution` / `state` split is a
type-level guarantee about mutability; projecting it to three tables buys nothing, because it
is always a 1:1 join, and costs three writes per state change. Immutability is enforced in zod
and the data-access layer, which is where ADR 0007 put the zod-and-Drizzle boundary.

**`finding` is rows; `evidence`, `patch`, `passes` and `refusals` are JSONB.** Findings are
queried *across* Runs by bucket key for reconciliation, so they need an index. The rest are
bounded, always read with their parent, and never queried independently.

**`worker_credential` is rows rather than current-and-previous columns.** ADR 0006 requires a
rotation grace window in which predecessor and successor are both valid, and a single
`hashedSecret` cannot express it. Rows make the overlap an ordinary row lifetime rather than a
fact encoded in a column name, make revocation a row update rather than a null-out, and do not
fix the arity at exactly two. Verification is then one predicate that is correct during
rotation and outside it: same Owner, same Worker, hash matches, not revoked, not expired.
During rotation the predecessor takes `expiresAt = graceEnd`.

**`enrollment_code` is hash-only**, never the plaintext, with atomic single-use consumption.

**`worker_credential`, `enrollment_code` and `publication` are persistence machinery for
concepts that already exist** - Enrollment, and the Review a Run publishes - and do not become
`CONTEXT.md` nouns.

**No `api_key` and no general `audit_log`.** There is no public API, and the Worker credential
is a hashed secret rather than an API key. An audit-log entity would repeat the `Artifact`
mistake: ADR 0006 and ADR 0007 deliberately put `route`, `isolation`, `exposure`,
`provenanceBasis`, `configDigest`, `protocolVersion`, `workerBuildVersion` and the accumulated
Refusals **on the Run**, precisely so that the Run *is* the audit record. A second log with no
named consumer is a thing whose retention would then have to be invented. It earns its schema
when a security or product consumer names it.

### Repository carries no review configuration

`repository` holds operational persistence - `githubRepoId`, `ownerId`, scope state - and **no
review configuration columns**. Configuration is file-derived from the base ref, and
`configDigest` on the Run already pins what each Run resolved.

This is deliberate deference:
[#21](https://github.com/nick-neely/reprove/issues/21) owns file format, base-and-head
precedence, Owner defaults, dashboard overrides and Reprove defaults, and deciding storage here
would pre-empt its precedence question with a schema choice. Adding columns later is additive.

One thing is handed to #21 rather than decided: **`configDigest` is a checksum, not
configuration history.** If six-month auditability requires answering "what exact effective
configuration did this Run use", the Run will need a bounded normalized resolved-config
snapshot alongside the digest. That decision belongs with the config schema.

## Retention is one clock, and it purges fields rather than rows

Almost nothing here is time-bound. `owner`, `installation`, `repository` and `worker` are
lifecycle-bound. Run metadata contains no source and *is* the audit record ADR 0006 and ADR
0007 exist to preserve, so expiring it destroys the thing those decisions built.

What wants a clock is **source-derived content**, and the answer is a purge in place:

```
after the retention window
  -> preserve the Finding row
  -> purge content-bearing fields
  -> set contentPurgedAt
```

**Purged** at 90 days by default: `anchoredText`; the Finding's **title and body**, since either
can quote source or identifiers; the Evidence **excerpt**; and the Evidence **command text**,
because a command can carry URLs, credentials, paths or literal data.

**Preserved**: Severity, Verification, path and line, exit code and duration, `bucket_key`,
`bucketKeyVersion`, dispositions, counts and audit metadata.

There is **no second retention class**, because after the telemetry decision below there is
nothing high-volume to expire. Defining a phantom diagnostic-retention tier for an entity that
does not exist would be speculative design.

**Not configurable in the foundation, but the mechanism ships now.** A retention knob is a
hosted product and compliance decision, and this map placed those out of scope. But
`contentPurgedAt` and the purge job are not deferrable: retrofitting field-level purging onto a
schema with no purge marker means backfilling across all historical Findings. Any self-hosted
override is **deployment configuration**, never Repository configuration, since it is a property
of the operator's database rather than of a repository under review. Hosted and self-hosted take
the same defaults; the difference between them is what a Worker transiently holds, which ADR
0004 and ADR 0006 already settled.

**`bucket_key` survives the purge, and `anchoredText` does not.** Two consequences:

- current-side dedupe keeps working on purged history;
- the prior-side `anchor_changed` test becomes **impossible**, because it compares against the
  original text.

**`bucketKeyVersion` is stored** alongside the key. If reconciliation canonicalization changes
after the source excerpt is purged, the historical key cannot be recomputed, and comparing keys
across versions would silently compare incompatible hashes. Differing versions **fail open**,
consistent with ADR 0007's rule that a wrong `new` costs a duplicate Comment while a wrong
`recurring` hides a real defect.

## Publication, and what happened to each Finding

One row per Run, since `CONTEXT.md` allows at most one *logical* Review:

```
publication   runId, ownerId, state(pending|published|failed), githubReviewId (null until accepted),
              event(COMMENT|REQUEST_CHANGES), appliedThreshold (JSONB snapshot),
              aggregate disposition counts, attempts (bounded, sanitized), submittedAt,
              reconciledAgainstRunId, priorReconciliation[]
```

ADR 0007 handed over `suppressedFindingCount`, which answers "how many" but not "why was *this*
Finding not posted". A single `suppressedBy: threshold | dedupe` was considered and **rejected
for collapsing three different projection semantics**: a Threshold suppresses the Finding from
the Review entirely; dedupe suppresses only the inline Comment while the Finding still exists
and contributes to summary counts; and an out-of-diff Finding has no Comment by definition
rather than by suppression.

So each Finding carries a **final publication disposition**, orthogonal to its reconciliation:

```
publicationDisposition:  inline_comment | review_body | suppressed_threshold | suppressed_dedupe
reconciliation:          new | recurring
```

Aggregate counts are denormalized onto the publication for the Review summary.

**A Threshold change after publication does nothing automatically.** ADR 0002's "changing a
Threshold never costs a Run" means a new Run is not required; it does not mean Reprove rewrites
GitHub after the fact. Re-publishing would duplicate Comments or delete Comments people may
have replied to, and the Review's claims are unchanged because the code is unchanged. The gap
this leaves is stated plainly: if a Threshold is **lowered** and no new push follows,
previously-suppressed Findings never post, and the remedy is to re-request a review, which
creates a new Run at the same SHAs. `appliedThreshold` is what makes the discrepancy legible
afterwards. User-triggered re-publication is a later product feature needing no schema today.

## Reconciliation is a property of the publication

The current-side disposition is a column on `finding`. The **prior side hangs off this Run's
publication**, as bounded JSONB of `{priorFindingId, bucket, priorDisposition}`. Writing
`anchor_changed` onto a closed Run's Finding row would mutate a record the ADRs treat as
history, in order to record a fact that is not about that Run.

`reconciledAgainstRunId` lives on **`publication`, not on `run`**, because reconciliation is a
publication and dedupe operation rather than an execution fact.

**The predecessor is defined explicitly**: the most recent prior Run for this pull request that
**successfully published a logical Review**. Inferring "the most recent Run before this one"
would be ambiguous once `superseded` Runs are in the chain, and silently choosing the wrong
predecessor produces exactly the wrong-`recurring` outcome ADR 0007's cardinality rule exists
to prevent.

**The candidate set contains only prior Findings whose `publicationDisposition` was
`inline_comment`.** ADR 0007 defines reconciliation as Comment dedupe, so a prior Finding
suppressed by a Threshold must not suppress the current one: no Comment was ever posted that
there is anything to dedupe against.

Where the predecessor's `anchoredText` has been purged, **no prior-side disposition is
manufactured**. The entry is simply **absent** from `priorReconciliation[]`. This is internal
telemetry, and "unknown because retained source expired" is better represented by absence than
by misclassifying it as `not_reproduced`.

## Telemetry: no durable event stream

Progress events are transport and liveness data. They cross the protocol because ADR 0006 needs
them for liveness and cancellation delivery, and they can drive a live view, but **they are not
persisted**.

Every question with a named consumer today is already answered by a terminal fact:
`disprovedHypothesisCount` for the Review summary; the accumulated Refusals for the Check's
"what is it waiting for"; `route`, `isolation`, `exposure`, `provenanceBasis` and the version
fields for dispatch auditability; and failure location at Pass granularity, since a
`PassRecord` carries `startedAt`, `endedAt`, `outcome`, `failureReason`, `repairTurnUsed` and
`usage`. The one remaining consumer would be a run-timeline UI, and dashboard scope is out of
this map's scope.

An unbounded relational event stream would need its own retention rule, its own purge job and
its own tenancy policy, built for a consumer that does not exist. That is the `Artifact`
mistake in a new costume. A `run_event` table is additive the day something names it.

**PostHog is settled as the analytics tool, so the boundary is recorded now**: no raw progress
events, source, Finding prose, Evidence, command text, transcripts or repository content enter
product analytics. Later analytics may emit bounded non-content facts - run completed, duration,
Harness, Model, Route, Autonomy, Finding counts, Verification counts, failure or refusal code -
and that is a different thing from storing a Run timeline.

## Deletion

- **Installation removal** marks the Installation revoked and **deletes nothing**. Re-installing
  resumes the same Owner, which is what `CONTEXT.md` already promises.
- **Explicit Owner deletion** removes all Owner-scoped Reprove data, by cascade from `owner`
  through `installation`, `repository`, `worker`, `worker_credential`, `enrollment_code`, `run`,
  `finding` and `publication`, following the actual foreign-key graph rather than requiring
  every row to reference `owner` directly. Defined now because retrofitting cascade behaviour
  onto live foreign keys is a migration that goes wrong quietly.
- **No time-based purge on uninstall.** The 90-day content purge already removes the
  source-derived fields, which are the sensitive part. Deleting the audit record too, in
  response to an inferred signal such as "no Installation for N days", destroys history on
  something that is not a deletion request.

Two limits on the wording, because the broad version is false:

- Deleting an Owner does **not** cascade into Better Auth's `user`, `account` or `session`. They
  are deliberately not Owner-scoped, and the same GitHub identity may still reach another Owner.
- Deletion from Reprove's database cannot retract Reviews and Comments already published on
  GitHub.

The public behaviour is therefore: **uninstalling stops Reprove and preserves history; explicit
Owner deletion removes all Reprove-held data for that Owner.**

## A grant that disappears mid-Run

The Installation can be removed, or a Repository de-scoped, at any point in a Run's life. This
needs **no new Run status and no new `failureReason`**, because each stage already has a
mechanism, and the reason stays orthogonal to the status:

| Run state when the grant disappears | outcome |
| --- | --- |
| `queued` | `cancelled`, with `cancellationReason` |
| `claimed` or `executing` | cancellation rides the lease (ADR 0006) into the Adapter's `AbortSignal`, teardown, then `cancelled` |
| `completed`, not yet published | Run **stays `completed`**; `publication.state = failed` |

```
status: cancelled
cancellationReason: installation_revoked | repository_de_scoped
```

`unscheduled` was considered for the `queued` case and **rejected**: ADR 0007 gives it the
specific meaning "`claimableUntil` expired and the Run was never dispatched", and revocation is
not scheduling exhaustion. Reusing it would make a historical status ambiguous about what
actually happened.

This is **not a Failure**. Reprove stopped the Run deliberately because authorization to
continue disappeared. The `completed` case follows from ADR 0007 separating execution state
from publication state, which is what stops this from moving a Run backwards.

One boundary: this applies when **GitHub has explicitly told Reprove the grant is gone**. An
unexpected GitHub authorization or network error encountered during Workspace materialization
is classified by the actual operational failure and **must not be laundered into a deliberate
cancellation**.

## Connections and migrations

```
admin / migration connection      runtime connection
  owner-or-admin role               restricted non-BYPASSRLS role
  direct Neon endpoint              pooled endpoint
  migrations and bootstrap only     all application traffic
```

The admin credential is never the application's runtime credential.

Migrations are Drizzle-generated SQL committed to Git, applied by an **explicit operator or
deployment command, never automatically at application boot** - auto-migration races concurrent
serverless instances and takes a schema change out of the operator's hands on a path documented
as best-effort. The runtime checks schema compatibility and **refuses to serve if it is behind**,
naming the pending migration, rather than degrading. History is **forward-only**, and
destructive changes roll out as **expand and backfill, then contract and drop**, so a
one-release rollback stays possible.

**Provisioning the restricted runtime role is part of the supported database bootstrap flow,
executed as SQL through the admin connection** - not "create a role in the Neon Console", because
Neon-created roles inherit the privileges that defeat this design. Where the `migrate` and
`bootstrap` commands physically live is packaging, and belongs to
[#20](https://github.com/nick-neely/reprove/issues/20).

## What Reprove stores

Stated as durable retention, because "Reprove never stores a clone" is false for hosted
execution, where a Run necessarily materializes repository contents on Reprove-operated
infrastructure while it runs:

> Reprove durably stores pull-request and Run metadata, Findings, tightly bounded source
> excerpts used to anchor Findings, bounded Evidence excerpts, Usage, and Review publication
> state. Where GitHub authorization on behalf of a User is required, Reprove stores that GitHub
> App access and refresh credential encrypted.
>
> Reprove does not durably retain full repository clones, archives, file trees, full diffs,
> Sandbox transcripts, or raw command output. Self-hosted Harness and Provider credentials never
> reach Reprove Cloud. Worker credentials are stored only as hashes, and short-lived GitHub
> Installation tokens are never persisted.
>
> For hosted Runs, repository contents exist transiently during execution.

This keeps ADR 0006's correction intact - Reprove must not claim the control plane cannot read
repository source - and adds the credential Reprove does hold, rather than routing around it.

## Consequences

- **`CONTEXT.md` gains** the durable-numeric-id property on `Owner` and the
  revocation-destroys-nothing property on `Installation`. `worker_credential`,
  `enrollment_code` and `publication` deliberately do **not** become nouns.
- **PRD open questions 30 (database) and 35 (data retention) are resolved**, and §36's entity
  list is superseded wholesale: `Account`, `GitHubInstallation`, `RepositorySettings`,
  `ReviewJob`, `ReviewRun`, `ReviewFinding` and `ReviewArtifact` are all gone. Edits land on
  [#17](https://github.com/nick-neely/reprove/issues/17).
- **PRD §37's observability list is answered by declining most of it**: those facts live on the
  Run, and no event table exists to hold a timeline.
- **`Storage: Vercel Blob` leaves the settled stack.** ADR 0007 deleted `Artifact`, ADR 0006
  deleted the upload path, and everything here fits in Postgres under ADR 0006's size bound.
  Keeping a technology settled when nothing uses it is the same speculative-design problem that
  kept `Artifact` alive. Choosing it again later is cheap.
- **[#21](https://github.com/nick-neely/reprove/issues/21) inherits** the resolved-config-history
  question, and the fact that `repository` currently has no configuration columns to conflict
  with.
- **[#20](https://github.com/nick-neely/reprove/issues/20) inherits** the placement of the
  `migrate` and `bootstrap` commands.
- **`SECURITY.md` gains** the expiring-token verification requirement, the encrypted-token
  statement, the durable-retention wording above, and the uninstall-versus-delete behaviour.
- Self-hosted deployment documentation must cover the **two-role setup**, because without the
  restricted runtime role RLS silently does nothing; the boot assertion is what turns that from
  a silent misconfiguration into a refusal.
- The negative-response semantics of the collaborator-permission endpoint are **left to
  empirical testing** rather than locked here.
