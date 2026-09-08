/**
 * The writes a lifecycle is allowed, measured against the real database because
 * every one of them is a claim about a conditional statement.
 *
 * [ADR 0014](../../../../docs/adr/0014-workflow-orchestration-seam.md) makes the
 * `run` row the arbiter between two lifecycles for one Run: the first writer of
 * the lifecycle id wins, and every later write is conditional on that column
 * naming the writer. Those are properties of the `WHERE` clause, and a stub
 * cannot state them.
 *
 * The last of them is
 * [ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)'s
 * terminal transition, and it is the one with two callers rather than one: the
 * lifecycle watchdog and the in-process detector reach the same statement with
 * different evidence. So the cases below fix both the window - which is
 * Acceptance's, exactly, and is the whole of it rather than `executing` alone -
 * and the two evidence conjuncts, since a detector that could write outside the
 * window would make Acceptance's boundary unenforceable from the other side.
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
import { hashExecutionToken } from "../worker/execution-token.js";
import {
  expireUnclaimed,
  markExecuting,
  readSchedule,
  recordLifecycle,
  terminateLostExecution,
} from "./lifecycle.js";
import type {
  ExecutionLossEvidence,
  ExecutionLossOutcome,
} from "./schedule.js";

const DATABASE = "reprove_test_run_lifecycle";

const ACME = 1001;
const STRANGER = 2002;
const REPOSITORY = 3001;

const CLAIMABLE_UNTIL = new Date("2026-02-01T12:05:00.000Z");

/** The lifecycle every claimed Run below records, so the guard is not the variable. */
const LIFECYCLE = "wrun_recorded";
/** The pass: one hosted Worker's attempt, which is a different durable run. */
const PASS = "wrun_pass";
/** The token the claim handed back. Only its digest is ever stored. */
const TOKEN = "an-execution-token-handed-back-by-the-claim";
const CLAIMED_AT = new Date("2026-02-01T12:00:00.000Z");
/** When a watchdog wakes: after the deadline below, inside the one above it. */
const NOW = new Date("2026-02-01T12:20:00.000Z");
/** `claimedAt + livenessFor`, already passed at `NOW`. */
const EXPIRED = new Date("2026-02-01T12:10:00.000Z");
/** A deadline a renewing Lease could have written; still ahead at `NOW`. */
const NOT_YET = new Date("2026-02-01T12:30:00.000Z");
/** A self-hosted Worker's durable identity, for the placement-neutrality pair. */
const WORKER = "11111111-1111-4111-8111-111111111111";

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

/**
 * A pull request number nobody else in this file is using.
 * `run_one_live_per_pull_request` is a partial unique index over `queued`,
 * `claimed` and `executing`, so every live Run a case makes needs one of its
 * own.
 */
let pullRequest = 500;
const freshPullRequest = (): number => {
  pullRequest += 1;
  return pullRequest;
};

/** The Run as the terminal transition and its callers read it back. */
interface TerminalRow {
  status: string;
  failure_reason: string | null;
  failure_detail: {
    detector: string;
    observation: string;
    lostFrom: string;
  } | null;
}

const terminalRowOf = async (runId: string): Promise<TerminalRow> => {
  const [row] = await database.admin<TerminalRow>(
    `select status, failure_reason, failure_detail from run where id = '${runId}'`
  );
  if (!row) {
    throw new Error("no such Run");
  }
  return row;
};

/**
 * A Run that has been claimed, written directly rather than through the claim
 * path: what is under test is the terminal transition's predicate, and the
 * claim has a test file of its own.
 *
 * Every column execution ownership writes is settable, because each of them is
 * one conjunct of the predicate and a case has to be able to move exactly one.
 */
const claimedRun = async (
  status: "claimed" | "executing",
  fields: {
    readonly executionExpiresAt?: Date | null;
    readonly executionTokenHash?: string;
    readonly workflowRunId?: string | null;
    readonly acceptedAt?: Date;
    readonly workerId?: string | null;
  } = {}
): Promise<string> => {
  const runId = await insertRun(status, freshPullRequest());
  const expiresAt =
    fields.executionExpiresAt === undefined
      ? EXPIRED
      : fields.executionExpiresAt;
  await database.admin(
    `update run set
       claimed_at = '${CLAIMED_AT.toISOString()}',
       execution_token_hash = '${fields.executionTokenHash ?? hashExecutionToken(TOKEN)}',
       execution_expires_at = ${expiresAt === null ? "null" : `'${expiresAt.toISOString()}'`},
       worker_id = ${fields.workerId ? `'${fields.workerId}'` : "null"},
       workflow_run_id = ${
         fields.workflowRunId === null
           ? "null"
           : `'${fields.workflowRunId ?? LIFECYCLE}'`
       },
       accepted_at = ${fields.acceptedAt ? `'${fields.acceptedAt.toISOString()}'` : "null"}
     where id = '${runId}'`
  );
  return runId;
};

/** The watchdog's evidence: this lifecycle, waking at this moment. */
const watchdog = (
  workflowRunId: string = LIFECYCLE,
  now: Date = NOW
): ExecutionLossEvidence => ({ kind: "deadline", now, workflowRunId });

/** The prompt detector's evidence: the token the crashed execution held. */
const crashed = (executionToken: string = TOKEN): ExecutionLossEvidence => ({
  kind: "execution",
  executionToken,
});

const terminate = async (
  runId: string,
  evidence: ExecutionLossEvidence,
  ownerId: number = ACME
): Promise<ExecutionLossOutcome> =>
  await runtime.withOwner(ownerId, (tx) =>
    terminateLostExecution(tx, {
      detector:
        evidence.kind === "deadline" ? "hosted_watchdog" : "hosted_prompt",
      evidence,
      observation:
        evidence.kind === "deadline" ? "deadline_elapsed" : "uncaught_throw",
      ownerId,
      runId,
    })
  );

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
    // One enrolled self-hosted Worker, so a Run may record the durable identity
    // the placement-neutrality pair needs on one side and not the other.
    await database.admin(
      `insert into worker (id, owner_id, protocol_version, worker_build_version)
       values ('${WORKER}', ${ACME}, 1, 'worker-0.0.0')`
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
        // Both windows, because the loop reads both. A Run that was never
        // claimed has no execution to bound, so the second one is null here.
        executionExpiresAt: null,
        workflowRunId: null,
        // The pass is the other durable run, and a Run that was never claimed
        // has none. ADR 0014 keeps the two in separate columns because they are
        // cancelled by opposite mechanisms.
        hostedWorkflowRunId: null,
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

  describe("taking the claimed Run into executing", () => {
    it("records the pass and moves the Run, for the execution that holds the token", async () => {
      const runId = await claimedRun("claimed");

      await expect(
        runtime.withOwner(ACME, (tx) =>
          markExecuting(tx, {
            executionToken: TOKEN,
            hostedWorkflowRunId: PASS,
            ownerId: ACME,
            runId,
          })
        )
      ).resolves.toBeTruthy();
      await expect(
        runtime.withOwner(ACME, (tx) => readSchedule(tx, runId))
      ).resolves.toMatchObject({
        hostedWorkflowRunId: PASS,
        status: "executing",
      });
    });

    it("writes nothing for an execution whose token is not this Run's current one", async () => {
      // The token is the whole of this write's ownership guard, exactly as it
      // is for the in-process detector: only the execution the claim granted
      // may say which pass is running it.
      const runId = await claimedRun("claimed");

      await expect(
        runtime.withOwner(ACME, (tx) =>
          markExecuting(tx, {
            executionToken: "a-token-rotated-out-from-under-it",
            hostedWorkflowRunId: PASS,
            ownerId: ACME,
            runId,
          })
        )
      ).resolves.toBeFalsy();
      await expect(statusOf(runId)).resolves.toBe("claimed");
    });

    it("writes nothing over a Run that has already accepted a Result", async () => {
      // The window is Acceptance's, so a Run that terminalized while the
      // dispatcher was between `start()` and this write is left alone. Moving
      // it to `executing` would revive a Run whose Acceptance has closed.
      const runId = await claimedRun("claimed", { acceptedAt: NOW });

      await expect(
        runtime.withOwner(ACME, (tx) =>
          markExecuting(tx, {
            executionToken: TOKEN,
            hostedWorkflowRunId: PASS,
            ownerId: ACME,
            runId,
          })
        )
      ).resolves.toBeFalsy();
      await expect(statusOf(runId)).resolves.toBe("claimed");
    });

    it("leaves every status other than claimed exactly as it was", async () => {
      // `claimed -> executing` and no other transition. `executing` is refused
      // too: a second pass id written over a Run that is already executing
      // would replace the id the lifecycle needs in order to cancel the pass
      // actually running.
      const held = RUN_STATUSES.filter((status) => status !== "claimed");
      const inserted = await Promise.all(
        held.map((status, index) => insertRun(status, 800 + index))
      );
      // Every Run in the table carries the current token, so **status is the
      // only thing the predicate can be refusing on**.
      await database.admin(
        `update run set execution_token_hash = '${hashExecutionToken(TOKEN)}'`
      );

      const written = await Promise.all(
        inserted.map((runId) =>
          runtime.withOwner(ACME, (tx) =>
            markExecuting(tx, {
              executionToken: TOKEN,
              hostedWorkflowRunId: PASS,
              ownerId: ACME,
              runId,
            })
          )
        )
      );
      const statuses = await Promise.all(inserted.map(statusOf));

      expect(written).toStrictEqual(held.map(() => false));
      expect(statuses).toStrictEqual([...held]);
    });

    it("matches nothing across the tenant boundary", async () => {
      const runId = await claimedRun("claimed");

      await expect(
        runtime.withOwner(STRANGER, (tx) =>
          markExecuting(tx, {
            executionToken: TOKEN,
            hostedWorkflowRunId: PASS,
            ownerId: STRANGER,
            runId,
          })
        )
      ).resolves.toBeFalsy();
      await expect(statusOf(runId)).resolves.toBe("claimed");
    });
  });

  describe("terminating a lost execution", () => {
    it("ends an abandoned executing Run as failed(worker_lost)", async () => {
      const runId = await claimedRun("executing");

      await expect(terminate(runId, watchdog())).resolves.toStrictEqual({
        lostFrom: "executing",
        terminalized: true,
      });
      await expect(terminalRowOf(runId)).resolves.toStrictEqual({
        failure_detail: {
          detector: "hosted_watchdog",
          lostFrom: "executing",
          observation: "deadline_elapsed",
        },
        failure_reason: "worker_lost",
        status: "failed",
      });
    });

    it("ends a Run left at claimed with no pass recorded, by liveness alone", async () => {
      // ADR 0016's mandatory abandoned case: the dispatch path claimed the Run
      // and died before anything recorded a pass, so nothing knows a pass
      // exists and `claimableUntil` never fires - it writes only over `queued`.
      // Without this transition the Run stays Result-eligible forever. No
      // Result is submitted here, and none ever needs to be.
      const runId = await claimedRun("claimed");

      await expect(terminate(runId, watchdog())).resolves.toStrictEqual({
        lostFrom: "claimed",
        terminalized: true,
      });
      await expect(terminalRowOf(runId)).resolves.toMatchObject({
        failure_detail: { lostFrom: "claimed" },
        failure_reason: "worker_lost",
        status: "failed",
      });
    });

    it("reaches both placements identically, on the same window", async () => {
      // The pair is the point (ADR 0016): one Run carrying a self-hosted
      // Worker's durable identity and one carrying none, ending in the same
      // row through the same statement. Either alone would leave the window
      // looking like a hosted special case.
      const selfHosted = await claimedRun("executing", { workerId: WORKER });
      const hosted = await claimedRun("executing", { workerId: null });

      const outcomes = [
        await terminate(selfHosted, watchdog()),
        await terminate(hosted, watchdog()),
      ];
      const rows = [
        await terminalRowOf(selfHosted),
        await terminalRowOf(hosted),
      ];

      expect(outcomes[0]).toStrictEqual(outcomes[1]);
      expect(rows[0]).toStrictEqual(rows[1]);
      expect(rows[0]).toMatchObject({
        failure_reason: "worker_lost",
        status: "failed",
      });
    });

    it("leaves every status outside Acceptance's window exactly as it was", async () => {
      // The window is `claimed | executing`, and it is the *whole* window
      // rather than `executing` alone. A `queued` Run holds no execution to
      // lose, and a terminal one has already been decided - writing over
      // either would state something false about it.
      const held = RUN_STATUSES.filter(
        (status) => status !== "claimed" && status !== "executing"
      );
      const inserted = await Promise.all(
        held.map((status, index) => insertRun(status, 700 + index))
      );
      // Every Run in the table, which is exactly the ones just inserted: the
      // `beforeEach` empties it. Each carries the recorded lifecycle, the
      // current token and an elapsed deadline, so **status is the only thing
      // the predicate can be refusing on**.
      await database.admin(
        `update run set workflow_run_id = '${LIFECYCLE}',
           execution_token_hash = '${hashExecutionToken(TOKEN)}',
           execution_expires_at = '${EXPIRED.toISOString()}'`
      );

      const outcomes = await Promise.all(
        inserted.map((runId) => terminate(runId, watchdog()))
      );
      const after = await Promise.all(inserted.map((runId) => statusOf(runId)));

      expect(outcomes.map((outcome) => outcome.terminalized)).toStrictEqual(
        held.map(() => false)
      );
      expect(after).toStrictEqual(held);
    });

    it("writes nothing over a Run that has already accepted a Result", async () => {
      // The `acceptedAt IS NULL` half, which is the one a detector scoped to
      // status alone would drop. Acceptance won this race; the transition must
      // not overwrite a completed Run with a Failure.
      const runId = await claimedRun("executing", { acceptedAt: NOW });

      await expect(terminate(runId, watchdog())).resolves.toStrictEqual({
        lostFrom: null,
        terminalized: false,
      });
      await expect(statusOf(runId)).resolves.toBe("executing");
    });

    it("writes nothing while the execution deadline is still ahead", async () => {
      const runId = await claimedRun("executing", {
        executionExpiresAt: NOT_YET,
      });

      await expect(terminate(runId, watchdog())).resolves.toMatchObject({
        terminalized: false,
      });
      await expect(statusOf(runId)).resolves.toBe("executing");
    });

    it("writes nothing where no deadline was recorded at all", async () => {
      // Unreachable by construction - the claim writes all six ownership
      // columns in one statement - but the comparison is NULL-safe rather than
      // NULL-blind, so a row that lost its deadline is left alone instead of
      // being terminalized on a NULL.
      const runId = await claimedRun("executing", { executionExpiresAt: null });

      await expect(terminate(runId, watchdog())).resolves.toMatchObject({
        terminalized: false,
      });
      await expect(statusOf(runId)).resolves.toBe("executing");
    });

    it("writes nothing for a lifecycle the Run does not record", async () => {
      // ADR 0014's ownership guard, on the second window as on the first: an
      // orphaned lifecycle wakes at the same deadline and stays inert.
      const runId = await claimedRun("executing");

      await expect(
        terminate(runId, watchdog("wrun_orphan"))
      ).resolves.toMatchObject({ terminalized: false });
      await expect(statusOf(runId)).resolves.toBe("executing");
    });

    it("writes nothing while no lifecycle is recorded at all", async () => {
      const runId = await claimedRun("executing", { workflowRunId: null });

      await expect(terminate(runId, watchdog())).resolves.toMatchObject({
        terminalized: false,
      });
      await expect(statusOf(runId)).resolves.toBe("executing");
    });

    it("matches nothing across the tenant boundary", async () => {
      const runId = await claimedRun("executing");

      await expect(
        terminate(runId, watchdog(), STRANGER)
      ).resolves.toMatchObject({ terminalized: false });
      await expect(statusOf(runId)).resolves.toBe("executing");
    });

    describe("the in-process detector", () => {
      it("ends the Run on the token alone, without waiting out the deadline", async () => {
        // ADR 0015: "an uncaught throw is a moment Reprove's own code is
        // running, and waiting out a ten-minute deadline for a crash it
        // witnessed is a choice, not a constraint." The deadline here is still
        // ahead, and the transition writes anyway.
        const runId = await claimedRun("executing", {
          executionExpiresAt: NOT_YET,
        });

        await expect(terminate(runId, crashed())).resolves.toStrictEqual({
          lostFrom: "executing",
          terminalized: true,
        });
        await expect(terminalRowOf(runId)).resolves.toStrictEqual({
          failure_detail: {
            detector: "hosted_prompt",
            lostFrom: "executing",
            observation: "uncaught_throw",
          },
          failure_reason: "worker_lost",
          status: "failed",
        });
      });

      it("writes nothing when the token is not this Run's current one", async () => {
        // The token is this detector's ownership guard, in the place the
        // watchdog carries the recorded lifecycle. A crash in some other
        // execution does not get to end this Run.
        const runId = await claimedRun("executing");

        await expect(
          terminate(runId, crashed("a-token-rotated-out-from-under-it"))
        ).resolves.toMatchObject({ terminalized: false });
        await expect(statusOf(runId)).resolves.toBe("executing");
      });

      it("still writes nothing outside the eligibility window", async () => {
        // The evidence differs between detectors; the window does not.
        const runId = await claimedRun("executing", { acceptedAt: NOW });

        await expect(terminate(runId, crashed())).resolves.toMatchObject({
          terminalized: false,
        });
        await expect(statusOf(runId)).resolves.toBe("executing");
      });
    });
  });
});
