/**
 * Run creation against the real database, because every claim [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * makes about it is a claim about Postgres.
 *
 * The advisory lock is the obvious one - "two concurrent deliveries for one pull
 * request yield one Run, not two" is not a statement any stub can make - but the
 * two partial unique indexes are the same kind of claim, and so is the fact that
 * superseding the old Run and inserting its replacement commit together. What is
 * substituted is GitHub, and only at the transport: the delivery is recorded by
 * `recordDelivery()`, processed by the real processor, and read back through
 * `withOwner` on the pooled runtime role.
 *
 * It needs the local stack for the reason every test in this package does, and
 * fails with instructions rather than skipping when it is down.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../db/bootstrap.js";
import type { TestDatabase } from "../db/local-stack.test-support.js";
import {
  createTestDatabase,
  driverFailure,
  RUNTIME_PASSWORD,
} from "../db/local-stack.test-support.js";
import { migrate } from "../db/migrate.js";
import type { RuntimeDb } from "../db/runtime.js";
import { createRuntimeDb } from "../db/runtime.js";
import { LIVE_RUN_STATUSES, RUN_STATUSES } from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type { CanonicalPullRequest } from "./canonical.js";
import type { CanonicalOutcome } from "./client.js";
import type { ProcessedDelivery } from "./delivery.js";
import type { IngressEnvelope } from "./envelope.js";
import { recordDelivery } from "./ledger.js";
import { createDeliveryProcessor } from "./processing.js";
import { PHASE_0_RUN_PROFILE } from "./profile.js";

const DATABASE = "reprove_test_run_creation";

const ACME = 1001;
const REPOSITORY = 3001;
const PULL_REQUEST = 7;

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const NEXT_HEAD = "c".repeat(40);

const NOW = new Date("2026-02-01T12:00:00.000Z");
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

let database: TestDatabase;
let runtime: RuntimeDb;
let guid = 0;

const OPEN: CanonicalPullRequest = {
  number: PULL_REQUEST,
  open: true,
  draft: false,
  baseSha: BASE,
  headSha: HEAD,
  baseRepositoryId: REPOSITORY,
  headRepositoryId: REPOSITORY,
  authorId: 5005,
  authorAssociation: "MEMBER",
};

const envelopeFor = (action: string): IngressEnvelope => {
  guid += 1;
  return {
    deliveryGuid: `delivery-${guid}`,
    event: "pull_request",
    action,
    ownerId: ACME,
    ownerLogin: "acme",
    ownerType: "organization",
    installationId: 42,
    repositoryId: REPOSITORY,
    repositoryNameWithOwner: "acme/reprove",
    pullRequestNumber: PULL_REQUEST,
  };
};

/** A canonical fetch that always answers the same way, and counts its callers. */
const answering = (outcome: CanonicalOutcome) => {
  const asked: number[] = [];
  return {
    asked,
    canonicalPullRequest: (request: { pullRequestNumber: number }) => {
      asked.push(request.pullRequestNumber);
      return Promise.resolve(outcome);
    },
  };
};

const canonical = (
  overrides: Partial<CanonicalPullRequest> = {}
): CanonicalOutcome => ({
  kind: "canonical",
  pullRequest: { ...OPEN, ...overrides },
});

/** Records a delivery and processes it, which is the whole path after the 200. */
const deliver = async (
  action: string,
  outcome: CanonicalOutcome
): Promise<ProcessedDelivery> => {
  const envelope = envelopeFor(action);
  const deliveryId = await runtime.withOwner(ACME, (tx) =>
    recordDelivery(tx, envelope)
  );
  const process = createDeliveryProcessor({
    withOwner: runtime.withOwner,
    canonicalPullRequest: answering(outcome).canonicalPullRequest,
    profile: PHASE_0_RUN_PROFILE,
    now: () => NOW,
  });
  return await process({ deliveryId, envelope });
};

/**
 * One promise chained after the last. `Promise.all` is wrong for these cases:
 * each one arranges shared rows the next one deletes, so running them at once
 * measures the interleaving rather than the invariant.
 */
const sequentially = async <Item, Result>(
  items: readonly Item[],
  step: (item: Item) => Promise<Result>
): Promise<Result[]> => {
  const [first, ...rest] = items;
  if (first === undefined) {
    return [];
  }
  const result = await step(first);
  return [result, ...(await sequentially(rest, step))];
};

/** The disposition an attempt reached, named so a case can compare on it. */
const dispositionOf = (processed: ProcessedDelivery): string => {
  const { outcome } = processed;
  if (outcome === null) {
    return "already concluded";
  }
  return outcome.state === "discarded" ? outcome.disposition : outcome.state;
};

const runs = () =>
  runtime.withOwner(ACME, (tx) => tx.select().from(schema.run));

const ledger = () =>
  runtime.withOwner(ACME, (tx) => tx.select().from(schema.ingressDelivery));

/** The cached scope flag on this Owner's copy of the repository row. */
const cachedScope = async (): Promise<boolean | undefined> => {
  const [row] = await runtime.withOwner(ACME, (tx) =>
    tx.select().from(schema.repository)
  );
  return row?.inScope;
};

describe("Run creation", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
  });

  beforeEach(async () => {
    await database.admin("delete from run");
    await database.admin("delete from ingress_delivery");
    await database.admin("delete from repository");
    await database.admin("delete from owner");
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  describe("one signed delivery", () => {
    it("produces exactly one Run, complete at the canonical base and head", async () => {
      const processed = await deliver("opened", canonical());

      const created = await runs();
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        ownerId: ACME,
        repositoryId: REPOSITORY,
        pullRequestNumber: PULL_REQUEST,
        baseSha: BASE,
        headSha: HEAD,
        provenance: "internal",
        trigger: "automatic",
        status: "queued",
      });
      expect(processed.runId).toBe(created[0]?.id);
    });

    it("fills every part of the immutable spec from the injected profile", async () => {
      await deliver("opened", canonical());

      const [created] = await runs();
      expect(created).toMatchObject({
        harness: PHASE_0_RUN_PROFILE.harness,
        model: PHASE_0_RUN_PROFILE.model,
        strategy: PHASE_0_RUN_PROFILE.strategy,
        autonomy: PHASE_0_RUN_PROFILE.autonomy,
        placement: PHASE_0_RUN_PROFILE.placement,
        allowHostedFallback: PHASE_0_RUN_PROFILE.allowHostedFallback,
        resolvedConfig: PHASE_0_RUN_PROFILE.resolvedConfig,
        configDigest: expect.stringMatching(/^sha256:[\da-f]{64}$/u),
      });
      expect(created?.claimableUntil).toStrictEqual(
        new Date(NOW.getTime() + PHASE_0_RUN_PROFILE.claimableForMs)
      );
    });

    it("records the Provenance basis it decided from, computed rather than taken", async () => {
      await deliver(
        "opened",
        canonical({ headRepositoryId: 9009, authorAssociation: "OWNER" })
      );

      const [created] = await runs();
      expect(created?.provenance).toBe("external");
      expect(created?.provenanceBasis).toMatchObject({
        ruleVersion: 1,
        baseRepositoryId: REPOSITORY,
        headRepositoryId: 9009,
        authorAssociation: "OWNER",
        matchedSameRepository: false,
        matchedAssociation: true,
      });
    });

    it("settles the delivery done, in the transaction that created the Run", async () => {
      const processed = await deliver("opened", canonical());

      expect(processed.settled).toBeTruthy();
      await expect(ledger()).resolves.toMatchObject([
        { state: "done", disposition: null, retryClass: null, attemptCount: 1 },
      ]);
    });
  });

  describe("two concurrent deliveries for one pull request", () => {
    it("yield one Run, and leave the loser contended rather than queued behind", async () => {
      // `withResolvers` rather than a hand-rolled deferred: the point of the
      // case is where the two processors meet, not how the rendezvous is built.
      const holding = Promise.withResolvers<null>();
      const arrived = Promise.withResolvers<null>();

      const first = envelopeFor("opened");
      const second = envelopeFor("synchronize");
      const [firstId, secondId] = await Promise.all([
        runtime.withOwner(ACME, (tx) => recordDelivery(tx, first)),
        runtime.withOwner(ACME, (tx) => recordDelivery(tx, second)),
      ]);

      // The first processor holds the advisory lock across its canonical fetch,
      // which is exactly the window ADR 0013 puts the fetch inside.
      const slow = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: async () => {
          arrived.resolve(null);
          await holding.promise;
          return canonical();
        },
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });
      const prompt = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: () => Promise.resolve(canonical()),
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });

      const winner = slow({ deliveryId: firstId, envelope: first });
      await arrived.promise;
      const loser = await prompt({ deliveryId: secondId, envelope: second });
      holding.resolve(null);

      expect(loser.outcome).toStrictEqual({
        state: "received",
        retryClass: "contended",
        nextAttemptAt: null,
      });
      expect(loser.runId).toBeNull();
      const won = await winner;
      expect(won.outcome).toStrictEqual({ state: "done" });
      await expect(runs()).resolves.toHaveLength(1);
    });
  });

  describe("at most one live Run per pull request", () => {
    const live = async (status: string, headSha: string) => {
      await database.admin(
        `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha,
                          provenance, provenance_basis, trigger, harness, model, strategy,
                          autonomy, placement, allow_hosted_fallback, resolved_config,
                          config_digest, claimable_until, status)
         values (${ACME}, ${REPOSITORY}, ${PULL_REQUEST}, '${BASE}', '${headSha}', 'internal',
                 '{}'::jsonb, 'automatic', 'codex', 'gpt-5', 'standard', 'verify', 'hosted',
                 false, '{}'::jsonb, 'sha256:1', now(), '${status}')`
      );
    };

    beforeEach(async () => {
      await database.admin(
        `insert into owner (id, login, type) values (${ACME}, 'acme', 'organization')`
      );
      await database.admin(
        `insert into repository (id, owner_id, name_with_owner)
         values (${REPOSITORY}, ${ACME}, 'acme/reprove')`
      );
    });

    it("is refused structurally at every live status, not only by the lock", async () => {
      const refusals = await sequentially(LIVE_RUN_STATUSES, async (status) => {
        await database.admin("delete from run");
        await live(status, HEAD);
        return await driverFailure(live(status, NEXT_HEAD));
      });

      expect(refusals.map((refusal) => refusal.code)).toStrictEqual(
        LIVE_RUN_STATUSES.map(() => UNIQUE_VIOLATION)
      );
    });

    it("permits a second Run once the first is no longer live", async () => {
      await live("superseded", HEAD);
      await live("queued", NEXT_HEAD);

      await expect(runs()).resolves.toHaveLength(2);
    });

    it("refuses a second automatic Run at the same head, whatever its status", async () => {
      await live("failed", HEAD);

      const refused = await driverFailure(live("queued", HEAD));
      expect(refused.code).toBe(UNIQUE_VIOLATION);
    });

    it("leaves a manual retry at the same head open, which is ADR 0007's retry", async () => {
      await live("failed", HEAD);
      await database.admin(
        `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha,
                          provenance, provenance_basis, trigger, harness, model, strategy,
                          autonomy, placement, allow_hosted_fallback, resolved_config,
                          config_digest, claimable_until, status)
         values (${ACME}, ${REPOSITORY}, ${PULL_REQUEST}, '${BASE}', '${HEAD}', 'internal',
                 '{}'::jsonb, 'manual', 'codex', 'gpt-5', 'standard', 'verify', 'hosted',
                 false, '{}'::jsonb, 'sha256:1', now(), 'queued')`
      );

      await expect(runs()).resolves.toHaveLength(2);
    });
  });

  describe("an automatic trigger at a head that already has a Run", () => {
    const statuses = RUN_STATUSES;

    it("is a no-op in any status, with no carve-outs", async () => {
      const dispositions = await sequentially(statuses, async (status) => {
        await database.admin("delete from run");
        await database.admin("delete from ingress_delivery");
        await database.admin("delete from repository");
        await database.admin("delete from owner");

        await deliver("opened", canonical());
        await database.admin(`update run set status = '${status}'`);

        const second = await deliver("synchronize", canonical());
        await expect(runs()).resolves.toHaveLength(1);
        return dispositionOf(second);
      });

      expect(dispositions).toStrictEqual(statuses.map(() => "duplicate_head"));
    });
  });

  describe("a delivery whose canonical head has moved", () => {
    it("supersedes the live Run and creates its replacement in one transaction", async () => {
      const first = await deliver("opened", canonical());

      const second = await deliver(
        "synchronize",
        canonical({ headSha: NEXT_HEAD })
      );

      const all = await runs();
      expect(all).toHaveLength(2);
      expect(all.find((run) => run.id === first.runId)?.status).toBe(
        "superseded"
      );
      expect(all.find((run) => run.id === second.runId)).toMatchObject({
        headSha: NEXT_HEAD,
        status: "queued",
      });
    });

    it("supersedes a live Run at a stale head even when the new head is a duplicate", async () => {
      // A Run at the canonical head already exists and is terminal, while the
      // live Run is at a head the pull request no longer has. Concluding
      // `duplicate_head` without ending it would strand it as the one live Run
      // for a head that is gone.
      await deliver("opened", canonical({ headSha: NEXT_HEAD }));
      await database.admin(
        `update run set status = 'failed', head_sha = '${HEAD}'`
      );
      const stale = await deliver("synchronize", canonical({ headSha: BASE }));
      expect(stale.outcome).toStrictEqual({ state: "done" });

      const duplicate = await deliver("synchronize", canonical());

      expect(duplicate.outcome).toStrictEqual({
        state: "discarded",
        disposition: "duplicate_head",
      });
      const all = await runs();
      expect(all.filter((run) => run.status === "queued")).toHaveLength(0);
    });
  });

  describe("canonical state the delivery disagrees with", () => {
    it("cancels the live Run when the pull request has closed", async () => {
      const opened = await deliver("opened", canonical());

      const closed = await deliver("closed", canonical({ open: false }));

      expect(closed.outcome).toStrictEqual({
        state: "discarded",
        disposition: "ineligible",
      });
      const all = await runs();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: opened.runId,
        status: "cancelled",
        cancellationReason: "pull_request_closed",
      });
    });

    it("cancels the live Run when the pull request has become a draft", async () => {
      await deliver("opened", canonical());

      await deliver("converted_to_draft", canonical({ draft: true }));

      await expect(runs()).resolves.toMatchObject([
        { status: "cancelled", cancellationReason: "pull_request_drafted" },
      ]);
    });

    it("creates none for a pull request that is already a draft", async () => {
      const processed = await deliver("opened", canonical({ draft: true }));

      expect(processed.outcome).toStrictEqual({
        state: "discarded",
        disposition: "ineligible",
      });
      await expect(runs()).resolves.toHaveLength(0);
    });

    it("lets a stale closed delivery cancel nothing, because the pull request reopened", async () => {
      const opened = await deliver("opened", canonical());

      const stale = await deliver("closed", canonical());

      // `unchanged`, not `inert`: the lock was taken and GitHub was asked, and
      // the answer is what made the delivery a no-op.
      expect(stale.outcome).toStrictEqual({
        state: "discarded",
        disposition: "unchanged",
      });
      await expect(runs()).resolves.toMatchObject([
        { id: opened.runId, status: "queued" },
      ]);
    });
  });

  describe("a delivery that does not act", () => {
    it("is discarded inert without taking the lock or asking GitHub", async () => {
      const wire = answering(canonical());
      const envelope = { ...envelopeFor("edited") };
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const process = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: wire.canonicalPullRequest,
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });

      const processed = await process({ deliveryId, envelope });

      expect(processed.outcome).toStrictEqual({
        state: "discarded",
        disposition: "inert",
      });
      expect(wire.asked).toStrictEqual([]);
      await expect(runs()).resolves.toHaveLength(0);
    });

    it("is discarded inert for an event GitHub delivers unconditionally", async () => {
      const envelope = {
        ...envelopeFor("removed"),
        event: "installation_repositories",
      };
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const process = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: () => Promise.resolve(canonical()),
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });

      const processed = await process({ deliveryId, envelope });
      expect(processed.outcome).toStrictEqual({
        state: "discarded",
        disposition: "inert",
      });
    });
  });

  describe("a grant that is revoked or missing", () => {
    it("lands as grant_gone rather than erroring", async () => {
      const processed = await deliver("opened", {
        kind: "grant_gone",
        reason: "the canonical pull request fetch answered 404",
      });

      expect(processed.outcome).toStrictEqual({
        state: "discarded",
        disposition: "grant_gone",
      });
      await expect(runs()).resolves.toHaveLength(0);
      await expect(ledger()).resolves.toMatchObject([
        { disposition: "grant_gone" },
      ]);
    });

    it("lands as grant_gone when the delivery names no Installation at all", async () => {
      const envelope = { ...envelopeFor("opened"), installationId: null };
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const process = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: () => Promise.resolve(canonical()),
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });

      const processed = await process({ deliveryId, envelope });
      expect(processed.outcome).toStrictEqual({
        state: "discarded",
        disposition: "grant_gone",
      });
    });

    it("stays received for a failure that clears on its own", async () => {
      const processed = await deliver("opened", {
        kind: "transient",
        reason: "ECONNRESET",
      });

      expect(processed.outcome).toStrictEqual({
        state: "received",
        retryClass: "transient",
        nextAttemptAt: null,
      });
      await expect(ledger()).resolves.toMatchObject([
        { state: "received", retryClass: "transient", attemptCount: 1 },
      ]);
    });

    it("stays received for a failure only a person can clear", async () => {
      const processed = await deliver("opened", {
        kind: "operator_attention",
        reason: "Resource not accessible by integration",
      });

      expect(processed.outcome).toMatchObject({
        state: "received",
        retryClass: "operator_attention",
      });
      await expect(runs()).resolves.toHaveLength(0);
    });
  });

  describe("repository scope", () => {
    it("is written from what the canonical fetch established", async () => {
      await deliver("opened", canonical());
      await expect(cachedScope()).resolves.toBeTruthy();

      await deliver("synchronize", {
        kind: "grant_gone",
        reason: "the canonical pull request fetch answered 404",
      });

      await expect(cachedScope()).resolves.toBeFalsy();
    });

    it("is a cache rather than authorization: an out-of-scope repository still gets a Run", async () => {
      await deliver("opened", {
        kind: "grant_gone",
        reason: "the canonical pull request fetch answered 404",
      });
      await expect(cachedScope()).resolves.toBeFalsy();

      // Nothing consults `in_scope` before fetching. Current GitHub authorization
      // is what decides, so a repository whose cached scope says otherwise gets a
      // Run the moment the fetch succeeds again.
      const processed = await deliver("synchronize", canonical());

      expect(processed.outcome).toStrictEqual({ state: "done" });
      await expect(cachedScope()).resolves.toBeTruthy();
    });

    it("is Owner-scoped, so a repository another Owner holds is never rewritten", async () => {
      // A repository id is unique across GitHub and survives a transfer between
      // accounts, so the id a delivery carries may already name a row belonging
      // to another Owner. The scope cache is written inside `withOwner`, so it
      // matches nothing across the boundary instead of overwriting it.
      await database.admin(
        "insert into owner (id, login, type) values (2002, 'globex', 'organization')"
      );
      await database.admin(
        `insert into repository (id, owner_id, name_with_owner, in_scope)
         values (${REPOSITORY}, 2002, 'globex/reprove', true)`
      );

      await deliver("opened", {
        kind: "grant_gone",
        reason: "the canonical pull request fetch answered 404",
      });

      const [held] = await database.admin<{
        in_scope: boolean;
        owner_id: string;
      }>(`select in_scope, owner_id from repository where id = ${REPOSITORY}`);
      expect(held).toMatchObject({ in_scope: true, owner_id: "2002" });
    });
  });

  describe("the ledger, across a redelivery", () => {
    it("does not reopen a delivery whose work is already finished", async () => {
      const envelope = envelopeFor("opened");
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const process = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: () => Promise.resolve(canonical()),
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });

      const first = await process({ deliveryId, envelope });
      const again = await process({ deliveryId, envelope });

      expect(first.settled).toBeTruthy();
      expect(again.settled).toBeFalsy();
      await expect(runs()).resolves.toHaveLength(1);
      await expect(ledger()).resolves.toMatchObject([
        { state: "done", attemptCount: 1 },
      ]);
    });
  });

  /** A Run for a pull request nobody else in this file is looking at. */
  const otherPullRequest = async (): Promise<void> => {
    await runtime.withOwner(ACME, async (tx) => {
      await tx
        .update(schema.run)
        .set({ pullRequestNumber: PULL_REQUEST + 1 })
        .where(
          and(
            eq(schema.run.repositoryId, REPOSITORY),
            eq(schema.run.pullRequestNumber, PULL_REQUEST)
          )
        );
    });
  };

  describe("the lock's granularity", () => {
    it("does not serialize two different pull requests in one repository", async () => {
      await deliver("opened", canonical());
      await otherPullRequest();

      const processed = await deliver("opened", canonical());

      expect(processed.outcome).toStrictEqual({ state: "done" });
      await expect(runs()).resolves.toHaveLength(2);
    });
  });

  describe("a receipt driven a second time", () => {
    it("does not act again once the delivery is terminal, even at a moved head", async () => {
      // The redelivery case ADR 0013 leaves open: `X-GitHub-Delivery` is reused
      // on a manual redelivery and the ledger's index is deliberately not
      // unique, so the same receipt genuinely can be processed twice. Without a
      // ledger read under the lock, the second pass would take the lock,
      // observe the moved head, supersede the live Run and insert a
      // replacement that no ledger row records.
      const envelope = envelopeFor("synchronize");
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const processorAt = (headSha: string) =>
        createDeliveryProcessor({
          withOwner: runtime.withOwner,
          canonicalPullRequest: () => Promise.resolve(canonical({ headSha })),
          profile: PHASE_0_RUN_PROFILE,
          now: () => NOW,
        });

      const first = await processorAt(HEAD)({ deliveryId, envelope });
      const again = await processorAt(NEXT_HEAD)({ deliveryId, envelope });

      expect(first.outcome).toStrictEqual({ state: "done" });
      expect(again.outcome).toBeNull();
      expect(again.settled).toBeFalsy();
      const all = await runs();
      expect(all).toMatchObject([{ id: first.runId, status: "queued" }]);
    });

    it("still acts on a delivery an earlier attempt left received", async () => {
      // The mirror of the case above, and the reason the guard reads the state
      // rather than the attempt count: a `contended` or `transient` attempt
      // leaves the row `received`, which is exactly what #38's re-drive picks
      // up and must be allowed to finish.
      const envelope = envelopeFor("opened");
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const failing = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: () =>
          Promise.resolve({ kind: "transient", reason: "ECONNRESET" } as const),
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });
      const succeeding = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: () => Promise.resolve(canonical()),
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });

      await failing({ deliveryId, envelope });
      const redriven = await succeeding({ deliveryId, envelope });

      expect(redriven.outcome).toStrictEqual({ state: "done" });
      await expect(runs()).resolves.toHaveLength(1);
      await expect(ledger()).resolves.toMatchObject([
        { state: "done", attemptCount: 2 },
      ]);
    });
  });

  describe("a transaction that could not commit", () => {
    /** Processes a delivery whose critical section is guaranteed to throw. */
    const deliverInto = async (broken: () => Promise<never>) => {
      const envelope = envelopeFor("opened");
      const deliveryId = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelope)
      );
      const process = createDeliveryProcessor({
        withOwner: runtime.withOwner,
        canonicalPullRequest: broken,
        profile: PHASE_0_RUN_PROFILE,
        now: () => NOW,
      });
      return await process({ deliveryId, envelope });
    };

    it("records the attempt rather than leaving the delivery unrecoverable", async () => {
      // The settlement shares the failed transaction, so a throw takes it down
      // too. Left as it was, the row is `received` with no retry class and no
      // attempt counted - a delivery ADR 0013's re-drive reads the class of and
      // therefore never picks up.
      const processed = await deliverInto(() =>
        Promise.reject(new Error("the connection went away"))
      );

      expect(processed.outcome).toStrictEqual({
        state: "received",
        retryClass: "operator_attention",
        nextAttemptAt: null,
      });
      expect(processed.settled).toBeTruthy();
      await expect(ledger()).resolves.toMatchObject([
        {
          state: "received",
          retryClass: "operator_attention",
          attemptCount: 1,
        },
      ]);
      await expect(runs()).resolves.toHaveLength(0);
    });

    it("classifies a failure the next attempt can get past as transient", async () => {
      const deadlock = Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("deadlock detected"), {
          code: "40P01",
        }),
      });

      const processed = await deliverInto(() => Promise.reject(deadlock));

      expect(processed.outcome).toMatchObject({
        state: "received",
        retryClass: "transient",
      });
    });
  });

  describe("a repository that changed hands", () => {
    it("cannot have a Run created under the Owner that does not hold it", async () => {
      // Both Run indexes are global and every probe in front of them runs
      // inside `withOwner`, so scoping the indexes to the Owner is what makes
      // what they enforce the same thing the code can see. Today the composite
      // foreign key gets there first, and that is worth measuring rather than
      // assuming: a repository id is globally unique and belongs to one Owner
      // at a time, so a Run for a repository still recorded under Owner A is
      // refused for Owner B before any index is consulted. Reconciling a
      // transfer needs authority over both Owners, which no tenant transaction
      // has.
      const globex = 2002;
      await deliver("opened", canonical());
      await database.admin(
        `insert into owner (id, login, type) values (${globex}, 'globex', 'organization')`
      );

      const refused = await driverFailure(
        database.admin(
          `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha,
                            provenance, provenance_basis, trigger, harness, model, strategy,
                            autonomy, placement, allow_hosted_fallback, resolved_config,
                            config_digest, claimable_until, status)
           values (${globex}, ${REPOSITORY}, ${PULL_REQUEST}, '${BASE}', '${NEXT_HEAD}',
                   'internal', '{}'::jsonb, 'automatic', 'codex', 'gpt-5', 'standard',
                   'verify', 'hosted', false, '{}'::jsonb, 'sha256:1', now(), 'queued')`
        )
      );

      expect(refused.code).toBe(FOREIGN_KEY_VIOLATION);
      await expect(runs()).resolves.toHaveLength(1);
    });
  });
});
