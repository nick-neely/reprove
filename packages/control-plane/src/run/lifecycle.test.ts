/**
 * The three writes a lifecycle is allowed, measured against the real database
 * because every one of them is a claim about a conditional statement.
 *
 * [ADR 0014](../../../../docs/adr/0014-workflow-orchestration-seam.md) makes the
 * `run` row the arbiter between two lifecycles for one Run: the first writer of
 * the lifecycle id wins, and every later write is conditional on that column
 * naming the writer. Those are properties of the `WHERE` clause, and a stub
 * cannot state them.
 *
 * It needs the local stack for the reason every database test in this package
 * does, and fails with instructions rather than skipping when it is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootstrap } from "../db/bootstrap.js";
import type { TestDatabase } from "../db/local-stack.test-support.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "../db/local-stack.test-support.js";
import { migrate } from "../db/migrate.js";
import type { RuntimeDb } from "../db/runtime.js";
import { createRuntimeDb } from "../db/runtime.js";
import { RUN_STATUSES } from "../db/schema-values.js";
import { expireUnclaimed, readSchedule, recordLifecycle } from "./lifecycle.js";

const DATABASE = "reprove_test_run_lifecycle";

const ACME = 1001;
const STRANGER = 2002;
const REPOSITORY = 3001;

const CLAIMABLE_UNTIL = new Date("2026-02-01T12:05:00.000Z");

let database: TestDatabase;
let runtime: RuntimeDb;

/**
 * A Run in the given status, as the admin role writes it. Each pull request
 * number is one Run's own, because two automatic Runs at one head for one pull
 * request is what `run_one_automatic_per_head` exists to refuse.
 */
const insertRun = async (
  status: string,
  pullRequestNumber = 7
): Promise<string> => {
  const [row] = await database.admin<{ id: string }>(
    `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha,
                      provenance, provenance_basis, trigger, harness, model, strategy,
                      autonomy, placement, allow_hosted_fallback, resolved_config,
                      config_digest, claimable_until, status)
     values (${ACME}, ${REPOSITORY}, ${pullRequestNumber}, '${"a".repeat(40)}', '${"b".repeat(40)}', 'internal',
             '{}'::jsonb, 'automatic', 'codex', 'gpt-5', 'standard', 'verify', 'hosted',
             false, '{}'::jsonb, 'sha256:1', '${CLAIMABLE_UNTIL.toISOString()}', '${status}')
     returning id`
  );
  if (!row) {
    throw new Error("no Run was inserted");
  }
  return row.id;
};

const statusOf = async (runId: string): Promise<string | undefined> => {
  const [row] = await database.admin<{ status: string }>(
    `select status from run where id = '${runId}'`
  );
  return row?.status;
};

describe("a Run's lifecycle, as the database arbitrates it", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
    await database.admin(
      `insert into owner (id, login, type) values (${ACME}, 'acme', 'organization')`
    );
    await database.admin(
      `insert into repository (id, owner_id, name_with_owner)
       values (${REPOSITORY}, ${ACME}, 'acme/reprove')`
    );
  });

  beforeEach(async () => {
    await database.admin("delete from run");
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  describe("recording the lifecycle", () => {
    it("is won by the first writer and refused to every later one", async () => {
      const runId = await insertRun("queued");

      const first = await runtime.withOwner(ACME, (tx) =>
        recordLifecycle(tx, runId, "wrun_first")
      );
      const second = await runtime.withOwner(ACME, (tx) =>
        recordLifecycle(tx, runId, "wrun_second")
      );

      expect(first).toBeTruthy();
      expect(second).toBeFalsy();
      await expect(
        runtime.withOwner(ACME, (tx) => readSchedule(tx, runId))
      ).resolves.toMatchObject({ workflowRunId: "wrun_first" });
    });

    it("is not repeatable even by the writer that won", async () => {
      // The column is written once. A lifecycle re-asserting its own id would
      // be harmless, but a statement that let it through would also let a
      // *different* id through on the same predicate.
      const runId = await insertRun("queued");
      await runtime.withOwner(ACME, (tx) =>
        recordLifecycle(tx, runId, "wrun_first")
      );

      await expect(
        runtime.withOwner(ACME, (tx) =>
          recordLifecycle(tx, runId, "wrun_first")
        )
      ).resolves.toBeFalsy();
    });

    it("matches nothing across the tenant boundary", async () => {
      const runId = await insertRun("queued");

      await expect(
        runtime.withOwner(STRANGER, (tx) =>
          recordLifecycle(tx, runId, "wrun_stranger")
        )
      ).resolves.toBeFalsy();
      await expect(
        runtime.withOwner(ACME, (tx) => readSchedule(tx, runId))
      ).resolves.toMatchObject({ workflowRunId: null });
    });
  });

  describe("reading the schedule", () => {
    it("returns what the lifecycle re-reads on every wake", async () => {
      const runId = await insertRun("queued");

      await expect(
        runtime.withOwner(ACME, (tx) => readSchedule(tx, runId))
      ).resolves.toStrictEqual({
        status: "queued",
        claimableUntil: CLAIMABLE_UNTIL,
        workflowRunId: null,
      });
    });

    it("returns nothing for a Run the tenant cannot see, the same as for none", async () => {
      const runId = await insertRun("queued");

      await expect(
        runtime.withOwner(STRANGER, (tx) => readSchedule(tx, runId))
      ).resolves.toBeNull();
      await expect(
        runtime.withOwner(ACME, (tx) =>
          readSchedule(tx, "00000000-0000-0000-0000-000000000000")
        )
      ).resolves.toBeNull();
    });
  });

  describe("expiring the unclaimed window", () => {
    it("moves a queued Run to unscheduled, when the writer is the recorded lifecycle", async () => {
      const runId = await insertRun("queued");
      await runtime.withOwner(ACME, (tx) =>
        recordLifecycle(tx, runId, "wrun_mine")
      );

      await expect(
        runtime.withOwner(ACME, (tx) => expireUnclaimed(tx, runId, "wrun_mine"))
      ).resolves.toBeTruthy();
      await expect(statusOf(runId)).resolves.toBe("unscheduled");
    });

    it("writes nothing for a lifecycle the Run does not record", async () => {
      // The orphan: it started, lost the race to be recorded, and wakes at its
      // deadline anyway. ADR 0014 makes it inert rather than preventing it.
      const runId = await insertRun("queued");
      await runtime.withOwner(ACME, (tx) =>
        recordLifecycle(tx, runId, "wrun_recorded")
      );

      await expect(
        runtime.withOwner(ACME, (tx) =>
          expireUnclaimed(tx, runId, "wrun_orphan")
        )
      ).resolves.toBeFalsy();
      await expect(statusOf(runId)).resolves.toBe("queued");
    });

    it("writes nothing while no lifecycle is recorded at all", async () => {
      // Inside the `start()` window nothing has been recorded yet. A deadline
      // that fired there belongs to a lifecycle whose claim to the Run is not
      // yet established, and it does not get to end the Run on the strength of
      // having started first.
      const runId = await insertRun("queued");

      await expect(
        runtime.withOwner(ACME, (tx) =>
          expireUnclaimed(tx, runId, "wrun_unrecorded")
        )
      ).resolves.toBeFalsy();
      await expect(statusOf(runId)).resolves.toBe("queued");
    });

    it("leaves every status other than queued exactly as it was", async () => {
      // `claimableUntil` bounds the unclaimed window and nothing else (ADR
      // 0014): a claimed or executing Run is not "never dispatched", and a
      // terminal one has already been decided. One Run per status, all
      // recorded to the same lifecycle, so the status is the only thing the
      // predicate can be refusing on.
      const held = RUN_STATUSES.filter((status) => status !== "queued");
      const inserted = await Promise.all(
        held.map((status, index) => insertRun(status, 100 + index))
      );
      await database.admin("update run set workflow_run_id = 'wrun_mine'");

      const expired = await Promise.all(
        inserted.map((runId) =>
          runtime.withOwner(ACME, (tx) =>
            expireUnclaimed(tx, runId, "wrun_mine")
          )
        )
      );
      const after = await Promise.all(inserted.map((runId) => statusOf(runId)));

      expect(expired).toStrictEqual(held.map(() => false));
      expect(after).toStrictEqual(held);
    });
  });
});
