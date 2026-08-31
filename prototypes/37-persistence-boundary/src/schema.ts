// THROWAWAY. The ADR 0008 entity set at sketch fidelity: enough columns to carry
// the load-bearing rules, nothing more. Column choices are not what this
// prototype is arguing about; the table SET is, because "every Reprove table is
// covered by forced RLS" is only a real property when something could fail to be
// covered.

import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { RUNTIME_ROLE } from './env.js';

// ADR 0008 says "Drizzle's RLS API moved from `.enableRLS()` to `pgTable.withRLS()`
// across majors, so it takes the same exact-pin treatment". Verified against the
// registry rather than the docs site, because the two disagree:
//
//   drizzle-orm@latest = 0.45.2  ->  `.enableRLS()`; `pgTable.withRLS` is undefined
//   drizzle-orm@rc     = 1.0.0-rc.4  ->  `pgTable.withRLS`
//
// The published documentation describes the rc API, so following the docs on the
// newest STABLE release produces a TypeError. This prototype therefore uses the
// 0.45.2 form: attaching a pgPolicy enables RLS on the table implicitly, and
// `.enableRLS()` is only needed for a policy-less table. Better Auth 1.7.2
// independently forces drizzle-orm >= 0.45.2, so the floor is not ours to pick.

// Provisioned by bootstrap.ts as SQL over the admin connection, per ADR 0008:
// "not 'create a role in the Neon Console', because Neon-created roles inherit
// the privileges that defeat this design." Marked existing() so drizzle-kit
// names it in policies without taking over its privilege flags.
export const runtimeRole = pgRole(RUNTIME_ROLE).existing();

// ADR 0008 rule 2: transaction-local state only. `current_setting(..., true)`
// returns NULL when unset, so the comparison is NULL and the policy denies by
// default rather than erroring - a missing tenant context reads as zero rows,
// which is the same shape as a wrong tenant.
//
// The nullif() is NOT decoration, and this prototype found out the hard way.
// `RESET ALL` and PgBouncer's `DISCARD ALL` do not remove a custom GUC; they set
// it to the EMPTY STRING. Without nullif, `''::bigint` raises
//
//     invalid input syntax for type bigint: ""
//
// from inside the policy, so a tenant table stops being deniable and starts
// being unqueryable. The bare cast is correct on an unpooled connection and
// fails only behind a pooler, which is the worst possible place to learn it.
const ownerContext = sql`nullif(current_setting('app.owner_id', true), '')::bigint`;

/** The one tenant predicate, applied identically everywhere. Typed as SQLWrapper
 *  because inside the extra-config callback a column is an ExtraConfigColumn,
 *  not the builder it was declared with. */
function tenantPolicy(name: string, column: SQLWrapper) {
  return pgPolicy(name, {
    for: 'all',
    to: runtimeRole,
    using: sql`${column} = ${ownerContext}`,
    withCheck: sql`${column} = ${ownerContext}`,
  });
}

// ---------------------------------------------------------------------------
// Owner-scoped Reprove tables. Every one carries owner_id denormalized and
// indexed, including the three that reach the Owner only transitively.
// ---------------------------------------------------------------------------

/** The tenant. `id` IS GitHub's durable numeric Owner id - no internal uuid. */
export const owner = pgTable(
  'owner',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    login: text('login').notNull(),
    type: text('type').notNull(), // user | organization
  },
  (t) => [tenantPolicy('owner_tenant', t.id)],
);

export const installation = pgTable(
  'installation',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [tenantPolicy('installation_tenant', t.ownerId), index('installation_owner_idx').on(t.ownerId)],
);

export const repository = pgTable(
  'repository',
  {
    id: bigint('id', { mode: 'number' }).primaryKey(), // githubRepoId
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    installationId: bigint('installation_id', { mode: 'number' }).references(() => installation.id, {
      onDelete: 'cascade',
    }),
    nameWithOwner: text('name_with_owner').notNull(),
    // ADR 0013: "Repository scope state is an operational cache."
    inScope: boolean('in_scope').notNull().default(true),
  },
  (t) => [tenantPolicy('repository_tenant', t.ownerId), index('repository_owner_idx').on(t.ownerId)],
);

export const worker = pgTable(
  'worker',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    protocolVersion: integer('protocol_version').notNull(),
    workerBuildVersion: text('worker_build_version').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  },
  (t) => [tenantPolicy('worker_tenant', t.ownerId), index('worker_owner_idx').on(t.ownerId)],
);

/** Rows, not current-and-previous columns, so ADR 0006's rotation grace window
 *  is an ordinary row lifetime. Reaches the Owner only through `worker`, and
 *  still carries owner_id so its policy is a comparison rather than a join. */
export const workerCredential = pgTable(
  'worker_credential',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => worker.id, { onDelete: 'cascade' }),
    secretHash: text('secret_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [tenantPolicy('worker_credential_tenant', t.ownerId), index('worker_credential_owner_idx').on(t.ownerId)],
);

/** Hash-only, never the plaintext. */
export const enrollmentCode = pgTable(
  'enrollment_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [tenantPolicy('enrollment_code_tenant', t.ownerId), index('enrollment_code_owner_idx').on(t.ownerId)],
);

/** ADR 0013's durable ingress envelope. Not in ADR 0008's list, because ADR 0013
 *  came later - which is exactly why the coverage assertion has to catch tables
 *  by enumeration rather than trusting one ADR's entity list. */
export const ingressDelivery = pgTable(
  'ingress_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    deliveryGuid: text('delivery_guid').notNull(),
    event: text('event').notNull(),
    action: text('action'),
    installationId: bigint('installation_id', { mode: 'number' }),
    repositoryId: bigint('repository_id', { mode: 'number' }),
    pullRequestNumber: integer('pull_request_number'),
    // received | done | discarded
    state: text('state').notNull().default('received'),
    // ineligible | duplicate_head | grant_gone, on `discarded`
    disposition: text('disposition'),
    // transient | operator_attention | contended, on nonterminal `received`
    retryClass: text('retry_class'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantPolicy('ingress_delivery_tenant', t.ownerId),
    index('ingress_delivery_owner_idx').on(t.ownerId),
    // Deliberately NOT unique: X-GitHub-Delivery is reused on manual redelivery,
    // and a unique constraint would swallow the only recovery GitHub offers.
    index('ingress_delivery_guid_idx').on(t.deliveryGuid),
  ],
);

/** One table, not three. ADR 0007's spec/resolution/state split is a type-level
 *  guarantee, enforced in zod and the data-access layer, not in the schema. */
export const run = pgTable(
  'run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    repositoryId: bigint('repository_id', { mode: 'number' })
      .notNull()
      .references(() => repository.id, { onDelete: 'cascade' }),
    pullRequestNumber: integer('pull_request_number').notNull(),

    // spec - immutable, complete at creation
    baseSha: text('base_sha').notNull(),
    headSha: text('head_sha').notNull(),
    provenance: text('provenance').notNull(), // internal | external
    provenanceBasis: jsonb('provenance_basis').notNull(),
    trigger: text('trigger').notNull(), // automatic | manual
    harness: text('harness').notNull(),
    model: text('model').notNull(),
    strategy: text('strategy').notNull(),
    autonomy: text('autonomy').notNull(),
    placement: text('placement').notNull(),
    configDigest: text('config_digest').notNull(),

    // state
    status: text('status').notNull().default('queued'),
    cancellationReason: text('cancellation_reason'),
    claimableUntil: timestamp('claimable_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // bounded, always read with the parent, never queried independently
    passes: jsonb('passes'),
    refusals: jsonb('refusals'),
  },
  (t) => [
    tenantPolicy('run_tenant', t.ownerId),
    index('run_owner_idx').on(t.ownerId),
    // ADR 0013's defense in depth. NOT the ordering primitive - the advisory
    // lock is. Deliberately not unique on head_sha, because ADR 0007 allows a
    // retry to produce a new Run at the same head.
    uniqueIndex('run_one_live_per_pull_request')
      .on(t.repositoryId, t.pullRequestNumber)
      .where(sql`${t.status} in ('queued', 'claimed', 'executing')`),
  ],
);

export const finding = pgTable(
  'finding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    line: integer('line'),
    severity: text('severity').notNull(),
    verification: text('verification').notNull(),

    // purged at 90 days; the row survives
    title: text('title'),
    body: text('body'),
    anchoredText: text('anchored_text'),
    evidence: jsonb('evidence'),
    patch: jsonb('patch'),
    contentPurgedAt: timestamp('content_purged_at', { withTimezone: true }),

    // preserved through the purge
    bucketKey: text('bucket_key').notNull(),
    bucketKeyVersion: integer('bucket_key_version').notNull(),
    publicationDisposition: text('publication_disposition'),
    reconciliation: text('reconciliation'),
  },
  (t) => [
    tenantPolicy('finding_tenant', t.ownerId),
    index('finding_owner_idx').on(t.ownerId),
    index('finding_bucket_idx').on(t.ownerId, t.bucketKey),
  ],
);

export const publication = pgTable(
  'publication',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: bigint('owner_id', { mode: 'number' })
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    state: text('state').notNull(), // pending | published | failed
    githubReviewId: bigint('github_review_id', { mode: 'number' }),
    event: text('event'), // COMMENT | REQUEST_CHANGES
    appliedThreshold: jsonb('applied_threshold'),
    reconciledAgainstRunId: uuid('reconciled_against_run_id'),
    priorReconciliation: jsonb('prior_reconciliation'),
    attempts: jsonb('attempts'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
  },
  (t) => [tenantPolicy('publication_tenant', t.ownerId), index('publication_owner_idx').on(t.ownerId)],
);

// ---------------------------------------------------------------------------
// Better Auth, deliberately OUTSIDE Owner RLS.
//
// A User can legitimately reach several Owners, so applying Owner tenancy here
// would model the relationship incorrectly. Shape follows Better Auth's own
// core schema; Reprove owns the migration file but not the definition.
//
// `owner` has no foreign key to any user, in either direction. That is what
// makes "one person, personal account plus organization, two tenants" structural
// rather than careful.
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  // the provider-side GitHub identity, treated as Better Auth data rather than
  // duplicated into a Reprove entity
  accountId: text('account_id').notNull(),
  // ciphertext under account.encryptOAuthTokens = true; Better Auth stores these
  // in plaintext by default
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  // ADR 0008 requires Reprove to verify GitHub issued an EXPIRING access token
  // and a refresh token, and fail loudly otherwise. A null here is the shape of
  // that failure, so it is a column rather than an assumption.
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// The classification the boot assertion reads.
//
// This is an allowlist, and ADR 0008 rejected an allowlist of RLS-exempt tables
// on the grounds that "an allowlist is precisely the thing that grows quietly."
// The difference that makes this one safe is the third set: every table in the
// database must appear in exactly one of the two lists below, so an unclassified
// table REFUSES BOOT instead of being silently exempt. The list cannot grow
// without someone writing the table's name here, in a diff, next to this note.
// ---------------------------------------------------------------------------

export const TENANT_TABLES = [
  'owner',
  'installation',
  'repository',
  'worker',
  'worker_credential',
  'enrollment_code',
  'ingress_delivery',
  'run',
  'finding',
  'publication',
] as const;

export const NON_TENANT_TABLES = ['user', 'session', 'account', 'verification'] as const;
