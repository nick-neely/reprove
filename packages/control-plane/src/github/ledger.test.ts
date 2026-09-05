/**
 * The ingress ledger against the real database, because every claim [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * makes about it is a claim about Postgres.
 *
 * Three of them cannot be measured anywhere else. A manual redelivery reuses
 * `X-GitHub-Delivery`, so whether the second one is recorded or swallowed is a
 * property of the index rather than of the insert. A first-ever delivery from an
 * Owner Reprove has never seen has to commit, which is a property of the
 * identity upsert in front of it and of the composite foreign keys around it.
 * And the six dispositions and retry classes are reachable only if a real row
 * accepts them.
 *
 * It needs the local stack for the reason every test in this package does, and
 * fails with instructions rather than skipping when it is down.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootstrap } from "../db/bootstrap.js";
import type { TestDatabase } from "../db/local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "../db/local-stack.test-support.js";
import { migrate } from "../db/migrate.js";
import type { RuntimeDb } from "../db/runtime.js";
import { createRuntimeDb } from "../db/runtime.js";
import {
  INGRESS_DISPOSITIONS,
  INGRESS_RETRY_CLASSES,
} from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type { IngressEnvelope } from "./envelope.js";
import { recordDelivery, settleDelivery } from "./ledger.js";

const DATABASE = "reprove_test_ingress_ledger";

const ACME = 1001;
const GLOBEX = 2002;

let database: TestDatabase;
let runtime: RuntimeDb;

const envelopeFor = (
  overrides: Partial<IngressEnvelope> = {}
): IngressEnvelope => ({
  deliveryGuid: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  event: "pull_request",
  action: "opened",
  ownerId: ACME,
  ownerLogin: "acme",
  ownerType: "organization",
  installationId: 42,
  repositoryId: 3001,
  repositoryNameWithOwner: "acme/reprove",
  pullRequestNumber: 7,
  ...overrides,
});

/** Commits an envelope the way the handler does, and reads the row back. */
const commit = async (envelope: IngressEnvelope) => {
  const id = await runtime.withOwner(envelope.ownerId, (tx) =>
    recordDelivery(tx, envelope)
  );
  const [row] = await runtime.withOwner(envelope.ownerId, (tx) =>
    tx
      .select()
      .from(schema.ingressDelivery)
      .where(eq(schema.ingressDelivery.id, id))
  );
  return { id, row };
};

describe("the ingress ledger against real Postgres", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  describe("committing an ingress envelope", () => {
    it("records every fact ADR 0013 names, and the bookkeeping beside them", async () => {
      const { row } = await commit(envelopeFor());

      expect(row).toMatchObject({
        deliveryGuid: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        event: "pull_request",
        action: "opened",
        ownerId: ACME,
        installationId: 42,
        repositoryId: 3001,
        repositoryNameWithOwner: "acme/reprove",
        pullRequestNumber: 7,
        state: "received",
        disposition: null,
        retryClass: null,
        attemptCount: 0,
      });
      expect(row?.receivedAt).toBeInstanceOf(Date);
      expect(row?.lastAttemptAt).toBeNull();
      expect(row?.nextAttemptAt).toBeNull();
    });

    it("commits a first-ever delivery from an Owner Reprove has never seen", async () => {
      // The identity upsert is not a convenience. `ingress_delivery` references
      // `owner`, and every reference between two Owner-scoped tables is
      // composite, so without it the very first delivery of a new installation
      // is a foreign-key violation - which under ADR 0013 means a non-2xx and a
      // delivery only a human can recover.
      const { row } = await commit(
        envelopeFor({
          ownerId: GLOBEX,
          ownerLogin: "globex",
          ownerType: "user",
          installationId: 84,
          repositoryId: 4001,
          repositoryNameWithOwner: "globex/widgets",
          deliveryGuid: "first-ever",
        })
      );

      expect(row?.ownerId).toBe(GLOBEX);
      const [owner] = await runtime.withOwner(GLOBEX, (tx) =>
        tx.select().from(schema.owner)
      );
      expect(owner).toMatchObject({
        id: GLOBEX,
        login: "globex",
        type: "user",
      });
      const [repository] = await runtime.withOwner(GLOBEX, (tx) =>
        tx.select().from(schema.repository)
      );
      expect(repository).toMatchObject({
        id: 4001,
        installationId: 84,
        nameWithOwner: "globex/widgets",
      });
    });

    it("carries a renamed repository's current locator onto the identity row", async () => {
      // The ledger keeps the locator as the delivery carried it; the identity
      // row is where the current name belongs, because the id beside it is what
      // survives a rename and the name is what a person reads.
      await commit(
        envelopeFor({
          ownerId: GLOBEX,
          ownerLogin: "globex",
          ownerType: "user",
          installationId: 84,
          repositoryId: 4001,
          repositoryNameWithOwner: "globex/renamed",
          deliveryGuid: "after-a-rename",
        })
      );

      const [repository] = await runtime.withOwner(GLOBEX, (tx) =>
        tx.select().from(schema.repository)
      );
      expect(repository?.nameWithOwner).toBe("globex/renamed");
    });

    it("commits a lifecycle delivery that names no repository", async () => {
      const { row } = await commit(
        envelopeFor({
          deliveryGuid: "an-installation-removal",
          event: "installation",
          action: "deleted",
          repositoryId: null,
          repositoryNameWithOwner: null,
          pullRequestNumber: null,
        })
      );

      expect(row).toMatchObject({
        event: "installation",
        action: "deleted",
        repositoryId: null,
        repositoryNameWithOwner: null,
        pullRequestNumber: null,
      });
    });

    it("records a manual redelivery rather than swallowing it", async () => {
      // GitHub reuses the GUID on a manual redelivery, and that is the only
      // recovery it offers for a delivery it will never retry by itself. A
      // unique constraint here would defeat it.
      const guid = "a-redelivered-guid";
      const first = await commit(envelopeFor({ deliveryGuid: guid }));
      const second = await commit(envelopeFor({ deliveryGuid: guid }));

      expect(second.id).not.toBe(first.id);
      const both = await runtime.withOwner(ACME, (tx) =>
        tx
          .select()
          .from(schema.ingressDelivery)
          .where(eq(schema.ingressDelivery.deliveryGuid, guid))
      );
      expect(both).toHaveLength(2);
    });

    it("indexes the delivery guid without making it unique", async () => {
      // The index is what makes the stateful GUID rule in ADR 0013 - same GUID
      // plus terminal state is a duplicate, same GUID plus nonterminal state
      // resumes - a lookup rather than a scan. Its non-uniqueness is what makes
      // the rule stateful at all.
      const [index] = await database.admin<{
        name: string;
        isUnique: boolean;
      }>(
        `select i.relname as "name", ix.indisunique as "isUnique"
         from pg_index ix
         join pg_class i on i.oid = ix.indexrelid
         join pg_class t on t.oid = ix.indrelid
        where t.relname = 'ingress_delivery'
          and i.relname = 'ingress_delivery_guid_idx'`
      );

      expect(index).toBeDefined();
      expect(index?.isUnique).toBeFalsy();
    });

    it("shows one Owner nothing of another's deliveries", async () => {
      const forGlobex = await runtime.withOwner(GLOBEX, (tx) =>
        tx.select().from(schema.ingressDelivery)
      );

      expect(forGlobex.every((row) => row.ownerId === GLOBEX)).toBeTruthy();
    });
  });

  describe("settling a delivery", () => {
    const settle = async (
      guid: string,
      outcome: Parameters<typeof settleDelivery>[2]
    ) => {
      const id = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelopeFor({ deliveryGuid: guid }))
      );
      await runtime.withOwner(ACME, (tx) => settleDelivery(tx, id, outcome));
      const [row] = await runtime.withOwner(ACME, (tx) =>
        tx
          .select()
          .from(schema.ingressDelivery)
          .where(eq(schema.ingressDelivery.id, id))
      );
      return row;
    };

    it("records a Run created as done, carrying neither a disposition nor a retry class", async () => {
      const row = await settle("settled-done", { state: "done" });

      expect(row).toMatchObject({
        state: "done",
        disposition: null,
        retryClass: null,
        attemptCount: 1,
      });
      expect(row?.lastAttemptAt).toBeInstanceOf(Date);
      expect(row?.nextAttemptAt).toBeNull();
    });

    it.each(INGRESS_DISPOSITIONS)(
      "records the terminal disposition %s",
      async (disposition) => {
        const row = await settle(`discarded-${disposition}`, {
          state: "discarded",
          disposition,
        });

        expect(row).toMatchObject({
          state: "discarded",
          disposition,
          retryClass: null,
          attemptCount: 1,
        });
        // A terminal delivery has no next attempt, and leaving one behind would
        // hand a re-drive sweeper work that must never be redone.
        expect(row?.nextAttemptAt).toBeNull();
      }
    );

    it.each(INGRESS_RETRY_CLASSES)(
      "leaves a delivery received under the retry class %s",
      async (retryClass) => {
        const nextAttemptAt = new Date(Date.now() + 30_000);
        const row = await settle(`retrying-${retryClass}`, {
          state: "received",
          retryClass,
          nextAttemptAt,
        });

        expect(row).toMatchObject({
          state: "received",
          disposition: null,
          retryClass,
          attemptCount: 1,
        });
        expect(row?.nextAttemptAt?.getTime()).toBe(nextAttemptAt.getTime());
      }
    );

    it("counts attempts across successive failures of the same delivery", async () => {
      const id = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(tx, envelopeFor({ deliveryGuid: "attempted-twice" }))
      );
      // Sequential on purpose: attempt bookkeeping is what a re-drive reads to
      // decide whether to back off, so it has to count re-drives rather than
      // concurrent writers.
      const attempt = (retryClass: "transient") => async () =>
        await runtime.withOwner(ACME, (tx) =>
          settleDelivery(tx, id, {
            state: "received",
            retryClass,
            nextAttemptAt: new Date(Date.now() + 1000),
          })
        );
      await attempt("transient")();
      await attempt("transient")();
      await attempt("transient")();

      const [row] = await runtime.withOwner(ACME, (tx) =>
        tx
          .select()
          .from(schema.ingressDelivery)
          .where(eq(schema.ingressDelivery.id, id))
      );
      expect(row?.attemptCount).toBe(3);
    });

    it("settles nothing belonging to another Owner", async () => {
      const id = await runtime.withOwner(ACME, (tx) =>
        recordDelivery(
          tx,
          envelopeFor({ deliveryGuid: "not-globex-to-settle" })
        )
      );

      await runtime.withOwner(GLOBEX, (tx) =>
        settleDelivery(tx, id, {
          state: "discarded",
          disposition: "ineligible",
        })
      );

      const [row] = await runtime.withOwner(ACME, (tx) =>
        tx
          .select()
          .from(schema.ingressDelivery)
          .where(eq(schema.ingressDelivery.id, id))
      );
      expect(row?.state).toBe("received");
    });
  });
});
