# `@reprove/control-plane`

Control-plane substance: GitHub ingress, scheduling, persistence, Acceptance, Reconciliation, publication, the Drizzle schema and migrations, and the Better Auth schema and config factory.

**The package reads no environment variables.** The app parses deployment-specific configuration and passes it explicitly to `createControlPlane(config)`. No Reprove Cloud credential default exists here. The one exception is the bin below, which is the operator entry point rather than library code.

It does **not** depend on `@reprove/worker-core`, and since [ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) it does not depend on `workflow` either - every workflow and step definition lives in `@reprove/control-plane-workflow`.

## The database

Two connections, never crossed ([ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)):

```text
admin / migration connection      runtime connection
  owner-or-admin role               reprove_runtime, non-BYPASSRLS
  direct endpoint                   pooled endpoint
  bootstrap() and migrate()         all application traffic
```

```text
reprove-control-plane <bootstrap|migrate>
```

The command is namespaced deliberately and does not expect global installation; `bootstrap()` and `migrate()` are exported too, so a consumer is never forced to shell out.

**`bootstrap` runs before `migrate`, and the two are not interchangeable.** Every generated migration carries `CREATE POLICY ... TO "reprove_runtime"`, which fails outright if the role does not exist yet, so `migrate` refuses rather than failing halfway through. `bootstrap` provisions the restricted role and the reach it has before any table exists - `CONNECT`, `USAGE` on `public`, read on the migration ledger, and the revocations that keep it from creating a relation of its own - and creates no table. It also revokes **every role membership** the runtime role holds: a membership is a `SET ROLE` into privileges the boot assertion cannot see, since every privilege it reads is `current_user`'s own, and nothing in this design needs one.

**Grants on Reprove's tables belong to `migrate`, and they name those tables one by one.** Nothing grants `on all tables in schema public` or sets a default privilege there, because a schema is somewhere a neighbour may legitimately put a relation and both forms say "whatever is in this schema". A view is the sharpest case: a view runs as *its owner* unless it carries `security_invoker`, so an admin-owned view over a tenant table reads every Owner's rows, and a schema-wide grant hands it over. The runtime role holds `SELECT, INSERT, UPDATE, DELETE` on exactly the managed tables, `USAGE, SELECT` on the sequences those tables own, and `TRUNCATE`, `REFERENCES` and `TRIGGER` on nothing - `TRUNCATE` most of all, because it ignores row-level security entirely. Re-running `migrate` re-applies all of that even when it applies no migration, which is how a drifted grant gets repaired.

Both read the admin connection string from `REPROVE_DATABASE_ADMIN_URL`, and `bootstrap` reads the runtime role's password from `REPROVE_DATABASE_RUNTIME_PASSWORD`. Neither is a command-line argument, because argv leaks a secret into every process listing on the host.

`createRuntimeDb()` opens the runtime connection, runs rule 6's seven assertions, and either returns a client or throws a `BootRefusalError` naming every check that failed. There is no flag and no bypass. All Owner-scoped access goes through `withOwner(ownerId, tx => ...)`, which sets the tenant context with `set_config('app.owner_id', $1, true)` - parameterized, and transaction-local, because a bare `SET` released to a pooler in transaction mode is inherited by the next client.

Local development and CI run the stack in [`tools/db/`](../../tools/db): `pnpm db:up` brings up Postgres 17 and PgBouncer in transaction mode, and `pnpm db:down` removes them. Docker is the only prerequisite. See [CONTRIBUTING.md](../../CONTRIBUTING.md#database).

### The published surface names no Drizzle or `pg` type

ADR 0010's matrix forbids `apps/control-plane` - the only consumer - from depending on `drizzle-orm` or a Postgres driver, so nothing this package exports names a type from either. That is ADR 0005's forbidden-type boundary applied to the database: an upstream type leaks through an exported signature even when the importer never names the package.

The schema, the classification, `createRuntimeDb()` and its tenant transaction therefore stay inside the package, reachable from `./db/index.js` by the control-plane code that owns them. Composition reaches the app as `createControlPlane(config)`.

### The migration folder is a runtime asset

`drizzle/` is in the package's `files` list and is resolved relative to the module rather than to `process.cwd()`, because the boot assertion joins the hashes Drizzle stored against the files that produced them ([ADR 0017](../../docs/adr/0017-authoring-time-tenancy-boundary.md)). Migration history is **append-only**: `PgDialect.migrate` writes a hash it never reads, so an edited applied migration is silently ignored and every existing database keeps the old DDL.

`0000_initial_schema` and `0002_better_auth_account_model` are drizzle-kit generated from `src/db/schema.ts`. `0001_force_row_level_security` is a `generate --custom` migration carrying the one statement Drizzle cannot express, in a canonical grammar:

```sql
-- reprove:force-row-level-security
ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;
```

**That grammar is generator-owned.** `pnpm --filter @reprove/control-plane db:force` derives the delta from the classification - `FORCE` for a newly tenant table, `NO FORCE` for a newly non-tenant one, nothing where the two already agree - and appends it as a new migration. It reads the effective state of the whole journal rather than its own last output, so running it twice produces one migration; it never rewrites one it already emitted, which it could not do safely. The script builds the package first on purpose: a generator run against a stale `dist` would append a migration derived from a classification nobody has any more, into a history that is append-only.

**Hand-authored migrations may not touch the tenant boundary at all** - no `CREATE TABLE`, no `ENABLE`/`DISABLE ROW LEVEL SECURITY`, no `FORCE`/`NO FORCE`, no `CREATE`/`ALTER`/`DROP POLICY`. That generalises "may not introduce a table" to close `DROP POLICY` and `DISABLE ROW LEVEL SECURITY`, which are the same hole in a different doorway.

Which rules a migration is held to follows from **who wrote it**, and that is measured rather than declared, because drizzle-kit marks nothing: `generate` writes a snapshot reflecting the new schema and `generate --custom` copies the previous one verbatim apart from its identity. A migration whose snapshot did not advance is therefore custom, and the marker separates the generator's from a human's.

```text
snapshot advanced             drizzle-kit generated   the schema module's output
snapshot unchanged, marked    the FORCE generator     conforms exactly, or fails
snapshot unchanged, unmarked  hand-authored           may not touch the boundary
```

The effective state is then a walk of the journal in order: `0001 FORCE` followed by `0002 NO FORCE` leaves the table unforced and fails, because effective final state is the property rather than textual occurrence. The walk covers all three of the boundary's facts - the FORCE state, the RLS enablement, and the policy set each table is left with - and it reads **every** migration whoever wrote it, which is what makes attribution safe. Attribution says a drizzle-generated file is *allowed* to carry `CREATE POLICY` and `ENABLE ROW LEVEL SECURITY`; it cannot say whether the statements in it are the ones the schema module asked for, so a `DROP POLICY` or a `DISABLE ROW LEVEL SECURITY` edited into one fails on the policy set it leaves behind rather than on the file it is in. A boundary statement the walk cannot parse is a failure, not a skip.

`0002` adds `account.issuer` as `NOT NULL` with no default and no backfill, which is drizzle-kit's own output and is left as generated. It is safe because it cannot meet a row: nothing wrote to `account` before `createAuth()` existed, so every database at `0001` has it empty. It is also the behaviour to want if that were ever untrue - a default would invent an issuer for accounts nobody can attribute, and mis-key them under the `(issuer, account_id)` unique index beside it, where the bare `NOT NULL` stops the migration and says so.

`0004` puts `owner_id` at the front of both Run indexes, so an index that is global stops being
scoped differently from the queries that check it. `0003` completes ADR 0013's Run spec and is drizzle-kit's own output too. It adds `resolved_config` and `allow_hosted_fallback` as `NOT NULL` with no default, tightens `claimable_until` to `NOT NULL`, and adds the conditional unique index behind the automatic-trigger no-op. The same argument makes all four safe: nothing created a Run before #49, so every database at `0002` has `run` empty. The two new columns are ADR 0013's own words - "`Phase0RunProfile`'s config must persist" and "`claimableUntil` lives in immutable `spec`, so it is written at creation" - and a nullable deadline would let a `queued` Run exist that nothing ever moves off `queued`.

`0005_run_lifecycle` adds `run.workflow_run_id` and is drizzle-kit's own output as well - one nullable `text` column, so it meets an existing row without needing anything of it. **It classifies nothing.** A column changes no table's tenancy and `run` was already a tenant table, so the classification the FORCE generator derives its delta from is the one it was already at, and it emits nothing where the two agree: **no FORCE delta follows `0005`**, and the absence is the generator's own answer rather than a step someone skipped.

`0006_run_execution_ownership` adds ADR 0015's execution-ownership block to `run` - `claimed_at`, `execution_token`, `execution_expires_at`, `worker_id`, `worker_protocol_version`, `worker_build_version` - plus the index a poll reads through and a unique index on `worker_credential (owner_id, secret_hash)`. Drizzle-kit's own output again, six nullable columns and two indexes, so it meets existing rows without needing anything of them, and it classifies nothing for the same reason `0005` did not. **`worker_id` carries no foreign key**, and that is the composite rule of `src/db/schema.ts` rather than an exception to it: a Run records its Worker as audit, so deleting a Worker must not cascade into the Runs it executed, and the correct constraint - a composite `(owner_id, worker_id)` reference with `ON DELETE SET NULL (worker_id)` - needs a PostgreSQL 15 column list that drizzle-kit 0.31 cannot emit. Without the list the clause would null `owner_id` too, which is `NOT NULL`, so a Worker deletion would fail rather than release. Same posture as `workflow_run_id` beside it.

All of it is ordinary Vitest - `declared.test.ts`, `force.test.ts`, `force-generate.test.ts` - beside `tools/verify-migrations.mjs`, which is the Git-aware half that proves history was only appended to. None of it sees a database: what actually deployed is `createRuntimeDb()`'s seven checks, and that division is ADR 0017's, not an omission.

## GitHub ingress

`POST /api/github/webhook` is composed in [`src/github/`](src/github) and reaches the app as
`createControlPlane(config)`. [ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
fixes the order and makes it the whole decision:

```text
verify HMAC-SHA256 over the raw bytes
  -> normalize a bounded ingress envelope
  -> commit it with its processing state
  -> return 200
  -> kick asynchronous processing
```

**Durability comes before the acknowledgement**, because GitHub does not automatically redeliver:
redelivery is manual, from the App's delivery UI or the deliveries API, and only within three days.
A `200` returned before anything is persisted is therefore the one genuinely unrecoverable outcome
in the system, and **a failure to commit is a non-2xx on purpose** - it buys the only recovery
GitHub offers. Once the envelope is committed the opposite holds: a failed asynchronous kick still
returns `200`, because Reprove now holds the intent and the ledger is what recovers it.

The commit is a **port** rather than a database call, and that is what makes the ordering testable
rather than merely intended. A handler that answered first and persisted afterwards passes every
assertion about status codes; `webhook.test.ts` watches where the commit lands relative to the
answer instead. `createControlPlane()` binds the port to a `withOwner` transaction, and
`control-plane.test.ts` measures the whole path against the real database - including that a
rejected delivery leaves the table empty, which a stub commit cannot say.

Each rejection carries a status of its own, because the recovery story differs for each:

| | | |
| --- | --- | --- |
| `200` | acknowledged | the envelope is durable |
| `401` | unsigned | no valid signature over these exact bytes |
| `413` | oversized | over the cap, refused **before** being hashed |
| `422` | unusable | signed, and still not something an envelope can be built from |
| `503` | not committed | nothing was stored, so nothing is acknowledged |

Three things are Reprove's own code rather than a dependency's, and each is one line of ADR 0013's
closing implementation notes. The signature is verified against the **exact received bytes**, never
a re-serialized parse - `JSON.parse` followed by `JSON.stringify` moves key order, whitespace,
unicode escapes and the digits of a number, so a handler hashing its own re-serialization would
accept bodies GitHub never signed. The comparison is `timingSafeEqual`. And the body is read under
a cap as a stream rather than buffered and measured afterwards, because "before hashing it" is a
claim about the bytes rather than about the status.

**The envelope is bounded and normalized, never the raw body.** It carries durable locator and
trigger facts only - Owner, Installation and Repository ids, the repository locator, pull request
number, event, action, delivery GUID - because the pull request's actual state is fetched
canonically later and persisting the raw body would durably duplicate narrative and other
repository-derived content into a retention surface [ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)
would then have to govern.

**The delivery GUID is indexed and deliberately not unique.** GitHub reuses `X-GitHub-Delivery` on a
manual redelivery, so a unique constraint would swallow the only recovery GitHub offers. The rule is
stateful instead - same GUID plus a terminal state is a duplicate, same GUID plus a nonterminal one
resumes, and the critical section reads that state under the lock before it acts. The ledger's
states, the five terminal dispositions (`inert`, `ineligible`, `duplicate_head`, `unchanged`,
`grant_gone`) and the three retry classes (`transient`, `operator_attention`,
`contended`) are named in [`src/db/schema-values.ts`](src/db/schema-values.ts) and settled through
`settleDelivery()`, which counts the attempt in SQL so two processors cannot both write the count
they each read. It settles a `received` row and only a `received` row, and returns whether it did:
`done` and `discarded` are terminal, so the contended attempt that finishes after the one that won
the lock cannot reopen a concluded delivery and hand a re-drive work that must never be redone.

### What the kick reaches: one Run per pull request

The kick is **fire-and-forget and synchronous**, so the acknowledgement is never held behind the
advisory lock and the canonical fetch. `processDelivery` is also exposed on `createControlPlane()`'s
return value, because ADR 0013 makes an automatic re-drive of `contended` and `transient`
dispositions a Phase 0 exit condition and handed the *mechanism* forward - so the durable scheduler
needs a way in that is not a webhook request.
[ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md) settles what that mechanism is: **the
Workflow step retry**, in `@reprove/control-plane-workflow`. The processing step of its
`ingressDelivery` workflow throws `RetryableError` whenever the settlement came back nonterminal -
after 2s for `contended`, whose holder releases the lock within one transaction at most, and after
30s for `transient`, which is GitHub answering `5xx`, `429` or a rate limit and clears on its own
but not in a second - for at most five retries after the first attempt, and throws a fatal error for
`operator_attention`, because that reaches the same answer on every attempt. All three numbers are
Phase 0 fixtures chosen to be observable rather than to be right, and nothing measures them yet.
**There is no sweeper here**, deliberately: a second recovery system competing with the durable one
is worse than none.

**What the delivery is kicked *to* is configuration**, and that is what keeps this package free of
`workflow`. `ControlPlaneConfig.kick` is handed the committed ledger row and its envelope after the
acknowledgement and without being awaited; the hosted composition passes a kick that calls
`startDelivery` from `@reprove/control-plane-workflow`, which hands the delivery to a durable run
and so puts the step retry above behind it. Left unset the delivery is processed **in this
process**, once, with the ledger row as the only recovery - which is ADR 0013's minimum and what a
composition holding no durable runtime, such as a test, gets. It is not what a deployment should
run.

`intentOf()` reads ADR 0013's trigger table. `opened`, `synchronize`, `reopened` and
`ready_for_review` can produce a Run; `closed` and `converted_to_draft` can only end one;
everything else - `edited` most of all, because ADR 0012 makes the title and description
Author-controlled narrative and a re-triggering edit would be a free re-roll of the review - is
`inert`. The per-action conditions in that table are deliberately not repeated in the switch,
because each of them is a statement about canonical state rather than about the action.

**`inert` means concluded from the delivery alone**: no lock taken and no request issued. It covers
an event or action that is not a trigger, and an acting delivery naming no repository or pull
request to act on, which no later attempt can supply. **`unchanged` is the opposite and is a
separate disposition for that reason**: the lock was taken, GitHub was asked, and the answer made
the delivery a no-op - a stale `closed` for a pull request that has since reopened. Calling that
`inert` would claim no request was made, and calling it `ineligible` would claim canonical state
refused the pull request when it did the opposite.

Everything after that happens inside one `withOwner` transaction:

```text
pg_try_advisory_xact_lock(hash of repository id and pull request number)
  -> is this ledger row still `received`?  no -> stop, having written nothing
  -> GET /repos/{owner}/{repo}/pulls/{number}, under installation authority
  -> supersede a live Run at a head the pull request no longer has
  -> any Run at the canonical head, in any status  -> duplicate_head
  -> otherwise insert the Run, complete
  -> settle the ledger row
```

**The ledger read is under the lock and before the fetch**, and it is what separates a re-drive from
a second Run. `settleDelivery()` already refuses to reopen a terminal row, but it runs *after* the
decision, so by the time it declined the work was done: a `done` delivery driven again - by the
Workflow step retry, or by a manual GitHub redelivery, which reuses `X-GitHub-Delivery` and which the
ledger's deliberately non-unique index accepts a second row for - would take the lock, observe a
head that had since moved, supersede the live Run and insert a replacement no ledger row records.

**The fetch is inside the lock, not before it.** Resolving canonical state at the top of the
asynchronous job leaves an interleaving where "one live Run" holds at every step and the *older*
head wins: A reads H2, a push makes the head H3, B reads H3 and creates `Run(H3)`, then A commits,
supersedes it and creates `Run(H2)`. SHAs carry no ordering, so nothing in the data marks A as
stale. Inside the lock the second processor re-reads and sees H3. The rejected alternative was
stamping each Run with a resolution instant, which depends on clock agreement across serverless
instances. Contention takes the **try** variant and leaves the delivery `received` with
`retryClass = contended`, because a serverless invocation must never queue behind a lock whose
holder it cannot observe; a hung fetch is bounded by the client's own timeout, backstopped by a
transaction-local `idle_in_transaction_session_timeout` set higher.

**The settlement shares that transaction with the decision.** Settling afterwards would leave a
window in which a Run exists and the delivery that created it still reads `received`, and a
re-drive arriving in that window would take the lock, find its own Run at the canonical head, and
conclude `duplicate_head` for a delivery that is actually `done`. The cost of sharing it is that a
transaction which cannot commit takes the settlement down with it, leaving a row with no attempt
counted and no retry class - which is a delivery ADR 0013's re-drive reads the class of and
therefore never picks up. So a failed transaction is settled in a fresh one, classified by
SQLSTATE: a concurrent writer, a lost connection, a deadlock or the
`idle_in_transaction_session_timeout` backstop are `transient`, and everything else is
`operator_attention`, because a constraint the code did not expect reaches the same failure on every
attempt.

Two indexes make the invariants structural as well. `run_one_live_per_pull_request` is ADR 0013's
own partial unique index over `queued`, `claimed` and `executing`.
`run_one_automatic_per_head`, on `(owner_id, repository_id, pull_request_number, head_sha)`
`WHERE trigger = 'automatic'`, is the structural half of the any-status no-op; the predicate is what
reconciles it with ADR 0007's "a new push **or a retry** produces a new Run", because the retry ADR
0013 leaves open is an explicit manual act and carries `trigger = 'manual'`.

**Both are keyed on `owner_id` first**, so what they enforce is the same thing the code can see. An
index is global and sees no policy, while every probe in front of it runs inside `withOwner`. A
repository id survives a transfer between accounts, so an index scoped to the repository alone would
let the new Owner's insert collide with a row it cannot select, supersede or explain. Today the
composite foreign key from `run` to `repository (owner_id, id)` reaches that case first and refuses
it - `run-creation.test.ts` measures that rather than assuming it - so the Owner column is defence
in depth against a boundary the two halves would otherwise disagree about, not a live collision
being fixed. The application-level
rule stays primary and has **no status allowlist**: a `failed` Run at a head is not automatically
retried, and a pull request reviewed at H3, then closed and reopened at the same H3, gets no second
Run. Both consequences are ADR 0013's and are documented rather than hidden.

### The GitHub client is Reprove's own, and Octokit is the rejected alternative

`src/github/app-auth.ts` mints the RS256 App JWT with `node:crypto`; `src/github/client.ts`
exchanges it for an installation token and issues `GET /repos/{owner}/{repo}/pulls/{number}` through
an **injected `fetch`**. That is ADR 0016's seam: GitHub is substituted "only at the transport", so
the JWT, the exchange, the request shape and the response parse all execute for real.

`github.apiUrl` is the REST root both of those requests are built against, and it is optional: unset
means `https://api.github.com`, which the package spells once and no consumer repeats. A GitHub
Enterprise Server deployment names its own root, and so does a build gate -
[`tools/verify-workflow-build.mjs`](../../tools/verify-workflow-build.mjs) stands a canned GitHub up
on loopback and points the built application at it, which is the transport substitution above
reaching all the way through a real `next start` rather than only through a test. The root must be
`https:`, or `http:` on loopback, and `createGitHubClient()` throws on anything else at composition:
both requests carry a credential in an `Authorization` header, so a cleartext root off the machine
is a token on the wire, and a deployment that named one should fail to boot rather than leak it.

Octokit is rejected for what it does rather than for its size. Its app plugin brings a token cache,
a retry plugin and a throttling plugin, and each contradicts a decision already made: ADR 0013
classifies retryability **by typed cause, never by HTTP status**, and the fetch runs inside a
transaction holding both an advisory lock and a pooled connection, where sleeping off a rate limit
is the wrong behaviour. The classification is the reason it matters -
`403 Resource not accessible by integration` is a missing permission and permanent, while a `403`
carrying `retry-after` or an exhausted quota clears on its own, so "all 401/403 retry with backoff"
retries the first forever and reports nothing.

Canonical state is **parsed** into a domain record rather than read field by field, because a Run's
`baseSha` and `headSha` are immutable once written. `baseSha` is `base.sha`, the base branch tip,
and deliberately not the merge base: computing that needs the compare endpoint, which drags
`Contents: read` into the grant, while ADR 0004 already keeps `.git` in the Workspace so it is
derived where the object graph is. The caveat is stated rather than hidden - `base.sha` moves with
the base branch, so the recorded value is what the tip was when the delivery was processed. A push
to the base branch fires no `pull_request` event, so a Run's base never moves after creation.

Provenance is computed from that response rather than taken from the payload, over **numeric
repository ids** so a rename cannot flip a classification, and its basis persists the inputs rather
than prose written against today's rule - which is why the basis carries a rule version. The live
collaborator-permission endpoint would additionally distinguish a read-only collaborator from one
who can push; it is not used, and ADR 0013 records that as an accepted consequence rather than a
gap, because `CONTEXT.md` says collaborator and Provenance classifies risk rather than conferring
safety.

### The Run is complete at creation, from an injected profile

`PHASE_0_RUN_PROFILE` carries the half of ADR 0007's immutable spec that no pull request can
influence - harness, model, strategy, autonomy, placement, hosted-fallback, a real bounded
normalized `resolvedConfig` parsed through `@reprove/protocol`'s own schema, and the two Phase 0
windows: `claimableForMs`, ADR 0014's five-minute unclaimed window written into the spec, and
`livenessForMs`, ADR 0015's ten-minute execution window read at claim. The two differ on purpose, so
that a deadline-confusion bug produces an observably different timestamp; both are refused at
composition if they are not positive, because a non-positive liveness window would make every claim
born already expired. `createControlPlane()` **requires** it and has no default: a value the
package chose silently is exactly the "prototype wiring becoming product selection policy" the ADR
built the profile to prevent. The digest sorts keys at every depth, so two configurations differing
only in the order zod's defaults filled them in have the same digest - otherwise `configDigest`
would identify a serialization rather than a config.

### Repository scope is a cache, and its lifecycle revalidation is not here yet

`in_scope` is written from whatever the canonical fetch established and read by nothing. That is
ADR 0013's rule intact - "**Repository scope state is an operational cache. Current GitHub
authorization is authoritative whenever scope would permit or terminate execution**" - so a
repository whose cached scope says otherwise still gets a Run the moment the fetch succeeds.

What is **not** built yet is the other half: ADR 0013 also asks a lifecycle removal to take the same
per-pull-request critical section for each affected live Run and revalidate it against current
GitHub state, so that revocation is prompt rather than waiting for the next pull request event.
Until that lands, `installation` and `installation_repositories` deliveries are recorded and
disposed `inert`, and revocation is observed by the next canonical fetch failing. ADR 0013 is
explicit that this is a **liveness** property and that correctness comes from the fetch failing, so
the gap delays a revocation rather than honouring a grant that is gone.

A verified payload establishes **identity** and not scope: `recordDelivery()` upserts Owner,
Installation and Repository rows in front of the ledger insert, because `ingress_delivery`
references `owner` and a first-ever delivery would otherwise be a foreign-key violation. No path may
require that `installation.created` arrived first - GitHub never auto-redelivers, so one dropped
lifecycle delivery would orphan an Owner permanently. Whether a repository is *in scope* stays with
the canonical fetch under installation authority, below.

Identity is written so that it can never be what loses a delivery. A repository id is unique across
GitHub and survives a **transfer between accounts**, so the id a delivery carries may already name a
row belonging to another Owner; conflicting into an update there is a row-level security failure
raised from inside the statement, which would fail the transaction and answer non-2xx for a delivery
GitHub will never resend. So the Repository row is an Owner-scoped update and only then an insert
that conflicts into `do nothing`: the foreign row is left as it is, the envelope still commits, and
reconciling the transfer waits for authority over both Owners that no tenant transaction has. For
the same reason an Installation the delivery did not name is left alone rather than cleared - a
delivery that named none is not evidence that there is none.

### The App requests two read permissions and publishes no Check

`githubAppManifest()` is the registration, and the grant in it is the complete one:

```text
Metadata: read          mandatory for every App
Pull requests: read     gates delivery of the pull_request event
```

`Contents: read`, `Pull requests: write` and `Checks: write` are **not** pre-declared. Adding a
permission later requires every existing installation to approve it, which is a real cost and one
Phase 0 does not pay, because it has no third-party installations; pre-declaring write authority
buys nothing today and costs an install consent screen that overstates what the App can do.

**No Check is published.** `CONTEXT.md` requires every Refusal to be visible on a Check, which looks
like it forces `Checks: write` into the grant. It does not: no Refusal is reachable in Phase 0, so
the Check lands with the first phase that can produce one and must land at the same time as it. A
rejected delivery is not a Refusal - nothing was refused and nothing executed.

The App subscribes to exactly `pull_request`. `installation`, `installation_repositories` and
`github_app_authorization` arrive at every App unconditionally and cannot be unsubscribed from, so
their absence from the manifest says nothing about whether they are recorded: the handler
normalizes whatever event it is sent rather than assuming an unsubscribed one never arrives, and
`intentOf()` dispatches on the event name the ledger row carries.

## The Run's lifecycle is a port, and the Run row arbitrates it

`createControlPlane()` returns a `lifecycle` beside the webhook, and it is the whole reach the
durable lifecycle in `@reprove/control-plane-workflow` has into a Run - three operations and no
fourth, each composed over a `withOwner` transaction so the Owner is an argument rather than
ambient state:

```text
record(owner, run, workflowRunId)   writes the id where none is written yet
schedule(owner, run)                status, claimableUntil and the recorded lifecycle
expireUnclaimed(owner, run, id)     queued -> unscheduled, and no other transition
```

**Every write is conditional on the writer being the lifecycle the Run records**, which is
[ADR 0014](../../docs/adr/0014-workflow-orchestration-seam.md)'s arbitration between an orphan and
the recorded lifecycle. `start()` takes neither an idempotency key nor a caller-supplied run id, so
the window between starting a lifecycle and recording it cannot be closed and a crash inside it
orphans a durable run nothing can find. The Run row decides instead: `record` matches on
`workflow_run_id IS NULL`, so the first writer wins and the write happens once and only once - a
predicate letting the recorded lifecycle re-assert its own id is the same predicate that lets a
different one through after a crash and a retry. The loser cancels its own run, and an orphan that
wakes anyway finds every predicate naming someone else and ends having changed nothing. `schedule`
is the state a lifecycle re-reads on each wake rather than trusting the timestamp it slept toward
([ADR 0015](../../docs/adr/0015-execution-ownership-and-worker-liveness.md)).

`expireUnclaimed` writes **exactly one transition**, `queued` to `unscheduled`, over a Run that was
never claimed. The status predicate is what keeps that honest: ADR 0007 defines `unscheduled` as
"never dispatched" and `CONTEXT.md` reserves Failure for a Run that began executing, so writing
either over a claimed or executing Run would state something false about it. **An executing Run
whose deadline passes is deliberately left alone** - `claimableUntil` bounds the unclaimed window
and nothing else, and the liveness of a Run that is actually executing is ADR 0015's subject rather
than this deadline's.

`ProcessedDelivery.endedRuns` is the other half of the same seam. It carries the id and the terminal
status - `superseded` or `cancelled` - of every live Run the delivery ended, in the transaction that
ended it, and the status is already written by the time a caller reads it. A caller needs the list
because the lifecycle scheduling an ended Run is asleep until its deadline and would otherwise wake
only then: ADR 0014 has that lifecycle "resumed through its cancel hook so it terminates
reportably", and this is what the resumer reads. Reporting the Runs rather than performing the
notification is what lets the orchestration layer do the waking while this package still depends on
no `workflow`.

## The Worker claim

`POST /api/worker/runs/claim` is composed in [`src/worker/`](src/worker) and reaches the app as
`createControlPlane(config).handleWorkerClaim`. It is the whole of how work reaches a **self-hosted**
Worker: [ADR 0006](../../docs/adr/0006-worker-protocol.md) makes the Worker always the HTTP client
and the control plane always the server, so a daemon on a laptop needs no inbound port, no NAT
traversal and no certificate, and Reprove never learns its address.

```text
read the body under a hard cap      -> 413
authenticate            (txn 1)     -> 401
parse it as a claim request         -> 422
check the protocol version          -> 426
claim                   (txn 2)     -> 200 | 204 | 404 | 409
```

**Authentication runs before the body is read for meaning**, which is the webhook's order applied to
a credential rather than a signature: a request Reprove cannot attribute is not a claim. It costs one
transaction against a garbage body and buys that the request schema is not a surface a stranger can
probe.

### Two transactions, and the first one does exactly one thing

Every Reprove-minted credential carries a non-secret Owner locator, because
[ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md) found the Worker paths were the
only pre-tenant entry points with no locator available:

```text
rpw1.<ownerId>.<secret>

begin transaction
  -> set_config('app.owner_id', ownerLocator, true)
  -> verify the credential                          <- one select, and nothing else
commit
  -> only then, a second transaction claims
```

A forged locator is safe by construction: it only changes which tenant's credential lookup returns
nothing. **That argument holds only because the pre-authentication transaction does exactly one
thing**, which the ADR calls load-bearing and part of the decision. So `verifyWorkerCredential` takes
a `PreAuthTransaction` - a tenant transaction narrowed to `select` - and has no `update`, `insert` or
`execute` to reach for; a later edit that tried to refresh Worker liveness there would not
type-check. `authenticate.test.ts` measures the same claim from outside, with a double that records
every member the transaction was asked for and throws for any but one.

Locator parsing happens **before** either transaction opens, and that is not tidiness: `withOwner`
throws a `TypeError` on an Owner id it cannot bind, so a locator that is not plain digits has to be a
refusal here rather than an unhandled throw from inside the database layer.

The credential is stored as `sha256:<hex>` over the secret alone - not a password KDF. The secret is
32 CSPRNG bytes rather than something a person chose, so no work factor buys anything against a
2^256 candidate space, while it would spend a deliberate delay on the hot path of every idle poll.
Credentials are **rows**, so ADR 0006's rotation grace window is an ordinary row lifetime: the
predecessor takes `expiresAt = graceEnd`, both rows satisfy one predicate until it passes, and
revocation is a row update rather than a null-out.

`401` never distinguishes an unknown Owner, an unknown secret, a revoked credential and an expired
one. All four are one answer, so the endpoint cannot be used to enumerate which Owners exist or which
credentials once did.

### The claim is one conditional UPDATE, and the re-probe only names it

```text
update run
  set status = 'claimed', claimed_at, execution_token, execution_expires_at,
      worker_id, worker_protocol_version, worker_build_version
where <the Run, or the oldest claimable one>
  and status = 'queued'
  and claimable_until > now
  and the Repository records an Installation
```

The eligibility window and the write are the same statement, which is what makes "a Run cannot be
actively held twice" a property of Postgres rather than of a check somebody remembered to run first.
Two concurrent claims of one Run serialize on the row lock: one matches and commits, the other
re-evaluates its `WHERE` against the committed row and matches zero. A poll takes the oldest
claimable `self_hosted` Run through a `for update skip locked` subquery, so a second Worker arriving
mid-claim steps past that row rather than blocking on it.

Zero rows is therefore ambiguous by construction, and the re-probe that follows **writes nothing and
decides nothing** - it exists only to name what happened. Its order is load-bearing in exactly the way
[ADR 0016](../../docs/adr/0016-phase-0-acceptance-scenario.md) found Acceptance's to be: both orders
return a refusal and only the name differs.

```text
not visible                        -> unknown_run          404
claimed | executing                -> already_claimed      409
terminal                           -> not_claimable        409
queued, and the window has closed  -> claim_window_closed  409
queued, in window, no Installation -> installation_unavailable
```

`unknown_run` covers another Owner's Run **deliberately**. The probe runs inside `withOwner`, so such
a Run is invisible rather than ineligible, and ADR 0016 makes that indistinguishability the decision:
the response stops confirming that a Run exists under an Owner the caller cannot see.

The Installation requirement sits in the predicate rather than after the write, because a Repository
with no live grant cannot have a Workspace materialized for it - claiming first and discovering that
second would burn the Run's one claim on an execution that could not start. And nothing here checks
Exposure, Isolation or Provenance: ADR 0006 makes that a two-phase decision whose second phase is the
claiming Worker's own fresh probe, and pre-empting it would put the authoritative view on the wrong
side of the seam.

### Execution ownership is written at claim, for both placements

[ADR 0015](../../docs/adr/0015-execution-ownership-and-worker-liveness.md) renamed what the prototype
called a lease, because a hosted Worker holds none and was carrying one anyway:

```text
executionToken       identifies the execution authorized to submit. Both placements.
executionExpiresAt   the control-plane liveness boundary for it.     Both placements.
Lease                a self-hosted Worker's renewable hold, allowed to advance the boundary.
```

`executionExpiresAt = claimedAt + livenessFor`, from the injected `Phase0RunProfile` and not from Run
creation, not from `claimableUntil`, and not from whenever execution happens to begin. The duration
lives on the profile because ADR 0016 put it there by name: unplaced it would land inline in the
claim path, which is the hazard ADR 0013 created that profile to prevent.

So `createControlPlane()` returns a placement-neutral `claimRun(request)` beside the endpoint. It is
the **same** conditional UPDATE, with `worker_id`, `worker_protocol_version` and `worker_build_version`
left null, and it is what stops the hosted placement growing an execution-ownership story of its own.
A hosted Worker names its Run and never polls, because ADR 0006 keeps it out of the scheduling half of
the protocol entirely.

There is **no enrollment endpoint**, and that is ADR 0016's assertion rather than an omission: Phase 0
has no Enrollment. `mintWorkerCredential` exists for the fixtures and for the dashboard flow that will
own it, and what #54 fixes is the credential format and the verification predicate.

## Authentication

`createAuth(config)` in [`src/auth/`](src/auth) composes Better Auth over the four tables Reprove **adopted** rather than four it manages ([ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md)). `user`, `session`, `account` and `verification` are declared in `src/db/schema.ts` beside everything else, so they share the one migration history and Better Auth runs no migration tool of its own. The Drizzle adapter is handed those table objects directly, which is what makes the sharing real rather than coincidental: it resolves every field against the object it was given.

The consequence is that Better Auth's model is a dependency of the schema, and a divergence is silent until a sign-in. `src/auth/schema.test.ts` therefore reads the expectation out of Better Auth - `auth.$context.tables`, the same model the adapter resolves against - and compares it field for field, so a version bump that adds a column fails on the pull request that bumps it rather than in production.

**These four sit outside Owner RLS and carry no Owner policy.** A User can legitimately reach several Owners, so applying Owner tenancy to authentication tables would model the relationship incorrectly. They are **classified non-tenant**, not exempted: the classification has two sets and no third, and a table in neither refuses boot. `owner` has no foreign key to any user in either direction and Reprove adds no membership relation, so one person installing on a personal account and on an organization is simply two `owner` rows with nothing joining them - `src/db/owner-independence.test.ts` measures both halves of that.

Two decisions are configuration that has to stay configured, so both are tested:

- **`account.encryptOAuthTokens` is on.** Better Auth stores OAuth tokens in plaintext by default; enabling it gives AES-256-GCM keyed from the `secret` passed in. The refresh token it protects is the six-month one.
- **A GitHub grant is asserted before it is stored.** ADR 0008 keeps a person's GitHub credential in the database on the strength of a token that expires in eight hours and a refresh token that renews it, and both come from the App's "Expire user authorization tokens" setting. Opting out changes nothing observable: the sign-in succeeds and the stored token is permanent. `assertGitHubTokenGrant()` is a pure function over the grant, wrapped around the provider's `getUserInfo` and `refreshAccessToken` - the two points a raw response from GitHub is still the response. The database hooks on `account` are the wrong seam for it, because Better Auth filters `undefined` out of the update it writes on a repeat sign-in, so the absent expiry that *is* the condition never reaches one.

Like the database surface, none of this is exported from the package root: ADR 0010 forbids `apps/control-plane` from depending on `better-auth`, so a published signature returning the instance would hand the only consumer a type it may not import.

## Support tier

**Published by necessity** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)). The supported self-hosting surface is `apps/control-plane` **as a deployable application, not as a package**. Public source, gated by every CI check, carrying **no stability promise**.

`workerProtocolSchemas` is the control-plane reference to the authoritative
schemas from `@reprove/protocol/v1`; the package does not define a second wire
shape.
