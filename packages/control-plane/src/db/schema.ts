/**
 * The persisted entity set of [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md), plus
 * ADR 0013's ingress ledger and the four tables Reprove adopts from Better
 * Auth.
 *
 * This module is the **managed universe** ADR 0017 defines: every `pgTable` it
 * exports is a table Reprove's migrations manage, and `classification.ts`
 * enumerates them independently of how they are classified. A table added here
 * and left out of both classification sets refuses boot.
 */
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { RUNTIME_ROLE } from "./roles.js";

/**
 * Declared `existing()` so drizzle-kit names the role in the policies it emits
 * without taking over its privilege flags, which `bootstrap()` spells out.
 */
export const runtimeRole = pgRole(RUNTIME_ROLE).existing();

/**
 * The one tenant predicate, and the reason it is not the bare cast.
 *
 * `RESET ALL`, and PgBouncer's `DISCARD ALL` where it is enabled, do not remove
 * a custom GUC - they set it to the **empty string**. `''::bigint` then raises
 * `invalid input syntax for type bigint: ""` from inside the policy, so the
 * table stops being deniable and becomes unqueryable. The bare cast is correct
 * on every direct connection and fails only behind a pooler after a reset,
 * which is the worst possible distribution for a defect (ADR 0008).
 *
 * `current_setting(..., true)` returns NULL when the GUC was never set, so a
 * missing tenant context reads as zero rows rather than as an error - the same
 * shape as the wrong tenant.
 *
 * The empty string is not only a pooler's doing, which is measured rather than
 * inferred: a transaction-local `set_config('app.owner_id', ..., true)` also
 * leaves `''` behind on the session once its transaction ends, on the direct
 * endpoint as much as the pooled one. So `withOwner` itself creates the value
 * that would break the bare cast, and the guard is load-bearing on every
 * connection this package hands out rather than only after a reset.
 */
export const ownerContext = sql`nullif(current_setting('app.owner_id', true), '')::bigint`;

/**
 * The canonical tenant policy, applied identically to every Owner-scoped table.
 * There is exactly one of these and no second spelling, because ADR 0017 makes
 * the boot assertion set equality against what this helper renders: a
 * hand-rolled policy carrying the bare cast fails, and a second permissive
 * policy beside a correct one fails too.
 *
 * The column is typed `SQLWrapper` because inside the extra-config callback a
 * column is an `ExtraConfigColumn` rather than the builder it was declared with.
 */
export const tenantPolicy = (name: string, column: SQLWrapper) =>
  pgPolicy(name, {
    for: "all",
    to: runtimeRole,
    using: sql`${column} = ${ownerContext}`,
    withCheck: sql`${column} = ${ownerContext}`,
  });

// --- Owner-scoped tables -----------------------------------------------------
//
// Every one carries `owner_id` denormalized and indexed, including the ones
// that reach the Owner only transitively, so each policy is a comparison rather
// than a subquery join. `owner` is the exception that proves it: its own
// primary key *is* the Owner id.
//
// That denormalization is also why every reference between two of these tables
// is **composite**. ADR 0008 stores each child's `owner_id` rather than deriving
// it, so a child carrying Owner A's `owner_id` and pointing at Owner B's parent
// is a row the schema would otherwise accept: the tenant policy compares
// `owner_id` and is satisfied, and the foreign key compares the parent id and is
// satisfied too. Nothing joins the two facts.
//
// A policy cannot close it either, because a foreign key is not checked as the
// writer. Postgres runs the referential-integrity trigger as the *referenced*
// table's owner and with row security off, which is what lets a child reference
// a parent it could never select - so the check sees B's row and passes. The
// consequence runs the other way too: deleting B's parent cascades into A's
// child, across a boundary neither Owner can observe.
//
// So every parent carries `unique (owner_id, id)`, and every child references
// that pair instead of the id alone. The tenant binding becomes structural, and
// a cross-tenant write is a foreign-key violation rather than a row nobody
// notices. Nullable child columns keep Postgres's default `MATCH SIMPLE`, under
// which a row naming no parent at all still satisfies the constraint.

/**
 * The tenant. `id` is GitHub's durable numeric Owner id and there is no internal
 * uuid beside it: a Reprove-minted key would reintroduce the circularity on the
 * webhook path, where the payload carries GitHub's id and mapping it would
 * itself be an unscoped lookup.
 */
export const owner = pgTable(
  "owner",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    login: text("login").notNull(),
    /** user | organization */
    type: text("type").notNull(),
  },
  (t) => [tenantPolicy("owner_tenant", t.id)]
);

/** A live grant of the Reprove GitHub App. Revocation destroys nothing. */
export const installation = pgTable(
  "installation",
  {
    id: bigint("id", { mode: "number" }).primaryKey(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    tenantPolicy("installation_tenant", t.ownerId),
    index("installation_owner_idx").on(t.ownerId),
    unique("installation_owner_scoped_id").on(t.ownerId, t.id),
  ]
);

/**
 * Operational persistence only. Review configuration is file-derived from the
 * base ref, so no configuration column lives here (ADR 0008, deferring to #21).
 */
export const repository = pgTable(
  "repository",
  {
    /** githubRepoId */
    id: bigint("id", { mode: "number" }).primaryKey(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }),
    nameWithOwner: text("name_with_owner").notNull(),
    inScope: boolean("in_scope").notNull().default(true),
  },
  (t) => [
    tenantPolicy("repository_tenant", t.ownerId),
    index("repository_owner_idx").on(t.ownerId),
    unique("repository_owner_scoped_id").on(t.ownerId, t.id),
    // Nullable, and `MATCH SIMPLE` is what makes that work: a Repository whose
    // grant has not been recorded names no Installation and is accepted.
    foreignKey({
      name: "repository_installation_owner_scoped_fk",
      columns: [t.ownerId, t.installationId],
      foreignColumns: [installation.ownerId, installation.id],
    }).onDelete("cascade"),
  ]
);

/** A self-hosted Worker's durable identity, established once by Enrollment. */
export const worker = pgTable(
  "worker",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    protocolVersion: integer("protocol_version").notNull(),
    workerBuildVersion: text("worker_build_version").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    tenantPolicy("worker_tenant", t.ownerId),
    index("worker_owner_idx").on(t.ownerId),
    unique("worker_owner_scoped_id").on(t.ownerId, t.id),
  ]
);

/**
 * Rows, not current-and-previous columns, so ADR 0006's rotation grace window is
 * an ordinary row lifetime rather than a fact encoded in a column name. During
 * rotation the predecessor takes `expiresAt = graceEnd`.
 */
export const workerCredential = pgTable(
  "worker_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    tenantPolicy("worker_credential_tenant", t.ownerId),
    index("worker_credential_owner_idx").on(t.ownerId),
    foreignKey({
      name: "worker_credential_worker_owner_scoped_fk",
      columns: [t.ownerId, t.workerId],
      foreignColumns: [worker.ownerId, worker.id],
    }).onDelete("cascade"),
  ]
);

/** Hash-only, never the plaintext, with atomic single-use consumption. */
export const enrollmentCode = pgTable(
  "enrollment_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    tenantPolicy("enrollment_code_tenant", t.ownerId),
    index("enrollment_code_owner_idx").on(t.ownerId),
  ]
);

/**
 * ADR 0013's durable ingress ledger: a bounded normalized envelope and its
 * processing state. The raw webhook body is deliberately not persisted, the
 * table gets no `CONTEXT.md` noun, and nothing here ever enters a Run's spec.
 *
 * It arrived after ADR 0008's entity list, which is exactly why the coverage
 * assertion enumerates the schema module rather than trusting one ADR's list.
 */
export const ingressDelivery = pgTable(
  "ingress_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    deliveryGuid: text("delivery_guid").notNull(),
    event: text("event").notNull(),
    action: text("action"),
    installationId: bigint("installation_id", { mode: "number" }),
    repositoryId: bigint("repository_id", { mode: "number" }),
    /**
     * ADR 0013's repository locator: the `owner/name` full name **as the
     * delivery carried it**, not as it reads now. A repository can be renamed
     * or transferred between the delivery and anything that reads the ledger,
     * and the id beside it is what survives that; the locator is what makes the
     * envelope legible to a person reconstructing what arrived.
     *
     * Nullable, like the id beside it, and for the same reason: ADR 0013's
     * envelope is a `pull_request` envelope *or* a lifecycle one, and a
     * lifecycle delivery - `installation.deleted`, or an
     * `installation_repositories.removed` naming several - carries only the
     * bounded ids the removal needs and has no one repository to locate.
     */
    repositoryNameWithOwner: text("repository_name_with_owner"),
    pullRequestNumber: integer("pull_request_number"),
    /** received | done | discarded */
    state: text("state").notNull().default("received"),
    /** ineligible | duplicate_head | grant_gone, on `discarded` */
    disposition: text("disposition"),
    /** transient | operator_attention | contended, on nonterminal `received` */
    retryClass: text("retry_class"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    tenantPolicy("ingress_delivery_tenant", t.ownerId),
    index("ingress_delivery_owner_idx").on(t.ownerId),
    // Deliberately not unique: GitHub reuses `X-GitHub-Delivery` on a manual
    // redelivery, and a unique constraint would swallow the only recovery
    // GitHub offers.
    index("ingress_delivery_guid_idx").on(t.deliveryGuid),
  ]
);

/**
 * One table, not three. ADR 0007's spec / resolution / state split is a
 * type-level guarantee about mutability, enforced in zod and the data-access
 * layer; projecting it to three tables would always be a 1:1 join and would cost
 * three writes per state change.
 */
export const run = pgTable(
  "run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    repositoryId: bigint("repository_id", { mode: "number" }).notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),

    // spec - immutable, complete at creation
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    /** internal | external */
    provenance: text("provenance").notNull(),
    provenanceBasis: jsonb("provenance_basis").notNull(),
    /** automatic | manual */
    trigger: text("trigger").notNull(),
    harness: text("harness").notNull(),
    model: text("model").notNull(),
    strategy: text("strategy").notNull(),
    autonomy: text("autonomy").notNull(),
    placement: text("placement").notNull(),
    configDigest: text("config_digest").notNull(),

    // state
    status: text("status").notNull().default("queued"),
    cancellationReason: text("cancellation_reason"),
    claimableUntil: timestamp("claimable_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // bounded, always read with the parent, never queried independently
    passes: jsonb("passes"),
    refusals: jsonb("refusals"),
  },
  (t) => [
    tenantPolicy("run_tenant", t.ownerId),
    index("run_owner_idx").on(t.ownerId),
    // ADR 0013's duplicate-live-Run invariant. Defense in depth, not the
    // ordering primitive: ordering comes from `pg_try_advisory_xact_lock(
    // repositoryId, pullRequestNumber)` on the ingress path, which #48 and #49
    // build. Nothing in this package takes that lock yet. Deliberately not
    // unique on `head_sha`, because ADR 0007 allows a retry to produce a new
    // Run at the same head.
    uniqueIndex("run_one_live_per_pull_request")
      .on(t.repositoryId, t.pullRequestNumber)
      .where(sql`${t.status} in ('queued', 'claimed', 'executing')`),
    unique("run_owner_scoped_id").on(t.ownerId, t.id),
    foreignKey({
      name: "run_repository_owner_scoped_fk",
      columns: [t.ownerId, t.repositoryId],
      foreignColumns: [repository.ownerId, repository.id],
    }).onDelete("cascade"),
  ]
);

/**
 * Rows, because Findings are queried across Runs by bucket key for
 * Reconciliation. `evidence` and `patch` are JSONB: bounded, always read with
 * their parent, never queried independently.
 */
export const finding = pgTable(
  "finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    path: text("path").notNull(),
    line: integer("line"),
    severity: text("severity").notNull(),
    verification: text("verification").notNull(),

    // Purged in place after the retention window; the row survives.
    title: text("title"),
    body: text("body"),
    anchoredText: text("anchored_text"),
    evidence: jsonb("evidence"),
    patch: jsonb("patch"),
    contentPurgedAt: timestamp("content_purged_at", { withTimezone: true }),

    // Preserved through the purge.
    bucketKey: text("bucket_key").notNull(),
    bucketKeyVersion: integer("bucket_key_version").notNull(),
    /** inline_comment | review_body | suppressed_threshold | suppressed_dedupe */
    publicationDisposition: text("publication_disposition"),
    /** new | recurring */
    reconciliation: text("reconciliation"),
  },
  (t) => [
    tenantPolicy("finding_tenant", t.ownerId),
    index("finding_owner_idx").on(t.ownerId),
    index("finding_bucket_idx").on(t.ownerId, t.bucketKey),
    foreignKey({
      name: "finding_run_owner_scoped_fk",
      columns: [t.ownerId, t.runId],
      foreignColumns: [run.ownerId, run.id],
    }).onDelete("cascade"),
  ]
);

/** One row per Run, since at most one logical Review is published. */
export const publication = pgTable(
  "publication",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: bigint("owner_id", { mode: "number" })
      .notNull()
      .references(() => owner.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    /** pending | published | failed */
    state: text("state").notNull(),
    githubReviewId: bigint("github_review_id", { mode: "number" }),
    /** COMMENT | REQUEST_CHANGES */
    event: text("event"),
    appliedThreshold: jsonb("applied_threshold"),
    reconciledAgainstRunId: uuid("reconciled_against_run_id"),
    priorReconciliation: jsonb("prior_reconciliation"),
    attempts: jsonb("attempts"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (t) => [
    tenantPolicy("publication_tenant", t.ownerId),
    index("publication_owner_idx").on(t.ownerId),
    foreignKey({
      name: "publication_run_owner_scoped_fk",
      columns: [t.ownerId, t.runId],
      foreignColumns: [run.ownerId, run.id],
    }).onDelete("cascade"),
  ]
);

// --- Better Auth, deliberately outside Owner RLS -----------------------------
//
// A User can legitimately reach several Owners, so applying Owner tenancy to
// the authentication tables would model the relationship incorrectly.
//
// Better Auth does not manage its own migrations under Drizzle: the CLI emits a
// schema file the application owns, so these four share one migration history
// with everything above. Reprove owns the file; it does not own the definition.
//
// `owner` has no foreign key to any user, in either direction. That is what
// makes "one person, a personal account and an organization, two tenants"
// structural rather than careful.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull(),
  /** The provider-side GitHub identity, kept as Better Auth data. */
  accountId: text("account_id").notNull(),
  // Ciphertext under `account.encryptOAuthTokens = true`; Better Auth stores
  // these in plaintext by default.
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  // ADR 0008 requires Reprove to verify that GitHub issued an *expiring* access
  // token and a refresh token, and to fail loudly otherwise. A null here is the
  // shape of that failure, so both are columns rather than assumptions.
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
