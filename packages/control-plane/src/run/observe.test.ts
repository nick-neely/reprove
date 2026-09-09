/**
 * The observation read, measured against the real database because the two
 * things it claims are both properties of the boundary rather than of the
 * projection.
 *
 * [ADR 0016](../../../../docs/adr/0016-phase-0-acceptance-scenario.md) has the
 * Phase 0 exit read the `run` row back "through `withOwner()` on the pooled
 * runtime role", and what makes that worth doing rather than reading the
 * columns as the admin role is exactly what a stub cannot state: a Run another
 * Owner holds is **invisible** rather than merely ineligible (ADR 0008), which
 * is the same fact that removed `wrong_tenant` from Acceptance's rejection set.
 * So the cases below fix that, and fix the structured failure detail against
 * what the terminal transition really wrote rather than against jsonb this file
 * spelled itself.
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
import { hashExecutionToken } from "../worker/execution-token.js";
import { terminateLostExecution } from "./lifecycle.js";
import { readRun } from "./observe.js";
import type { RunRecord } from "./record.js";

const DATABASE = "reprove_test_run_observe";

const ACME = 1001;
const STRANGER = 2002;
const REPOSITORY = 3001;
/** The stranger's own repository, because a Run's repository is Owner-scoped. */
const STRANGER_REPOSITORY = 3002;

const CLAIMABLE_UNTIL = new Date("2026-02-01T12:05:00.000Z");
const CLAIMED_AT = new Date("2026-02-01T12:00:00.000Z");
/** `claimedAt + livenessFor`, already passed when the watchdog wakes below. */
const EXPIRED = new Date("2026-02-01T12:10:00.000Z");
const NOW = new Date("2026-02-01T12:20:00.000Z");
const ACCEPTED_AT = new Date("2026-02-01T12:03:00.000Z");

/** The lifecycle a claimed Run records, which is the watchdog's own guard. */
const LIFECYCLE = "wrun_recorded";
/** The pass: one hosted Worker's attempt, which is a different durable run. */
const PASS = "wrun_pass";
/** The token the claim handed back. Only its digest is ever stored. */
const TOKEN = "an-execution-token-handed-back-by-the-claim";
/** A well-formed Run id nobody holds. */
const NOBODY = "11111111-1111-4111-8111-111111111111";

let database: TestDatabase;
let runtime: RuntimeDb;

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

const insertRun = async (
  status: string,
  ownerId: number = ACME
): Promise<string> => {
  const repositoryId = ownerId === ACME ? REPOSITORY : STRANGER_REPOSITORY;
  const [row] = await database.admin<{ id: string }>(
    `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha,
                      provenance, provenance_basis, trigger, harness, model, strategy,
                      autonomy, placement, allow_hosted_fallback, resolved_config,
                      config_digest, claimable_until, status)
     values (${ownerId}, ${repositoryId}, ${freshPullRequest()}, '${"a".repeat(40)}', '${"b".repeat(40)}',
             'internal', '{}'::jsonb, 'automatic', 'codex', 'gpt-5', 'standard', 'verify',
             'hosted', false, '{}'::jsonb, 'sha256:1', '${CLAIMABLE_UNTIL.toISOString()}',
             '${status}')
     returning id`
  );
  if (!row) {
    throw new Error("no Run was inserted");
  }
  return row.id;
};

/** A Run claimed by a hosted execution whose pass has been recorded. */
const claimedRun = async (status: "claimed" | "executing"): Promise<string> => {
  const runId = await insertRun(status);
  await database.admin(
    `update run set
       claimed_at = '${CLAIMED_AT.toISOString()}',
       execution_token_hash = '${hashExecutionToken(TOKEN)}',
       execution_expires_at = '${EXPIRED.toISOString()}',
       workflow_run_id = '${LIFECYCLE}',
       hosted_workflow_run_id = ${status === "executing" ? `'${PASS}'` : "null"}
     where id = '${runId}'`
  );
  return runId;
};

const observe = async (
  runId: string,
  ownerId: number = ACME
): Promise<RunRecord | null> =>
  await runtime.withOwner(ownerId, (tx) => readRun(tx, runId));

describe("a Run, read back through the tenant boundary", () => {
  beforeAll(async () => {
    database = await createTestDatabase(DATABASE);
    await bootstrap({
      connectionString: database.adminUrl,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: database.adminUrl });
    runtime = await createRuntimeDb({ connectionString: database.runtimeUrl });
    // A second Owner, with a repository of its own: a Run's repository is
    // Owner-scoped, and the invisibility case below needs a Run that really
    // belongs to somebody else rather than one this Owner cannot see by
    // accident.
    await database.admin(
      `insert into owner (id, login, type) values
         (${ACME}, 'acme', 'organization'),
         (${STRANGER}, 'stranger', 'organization')`
    );
    await database.admin(
      `insert into repository (id, owner_id, name_with_owner) values
         (${REPOSITORY}, ${ACME}, 'acme/reprove'),
         (${STRANGER_REPOSITORY}, ${STRANGER}, 'stranger/reprove')`
    );
  });

  beforeEach(async () => {
    await database.admin("delete from run");
  });

  afterAll(async () => {
    await runtime?.close();
    await database?.drop();
  });

  it("reads a queued Run as one nothing has happened to yet", async () => {
    const runId = await insertRun("queued");

    await expect(observe(runId)).resolves.toStrictEqual({
      acceptedAt: null,
      executionTokenHash: null,
      failureDetail: null,
      failureReason: null,
      hostedWorkflowRunId: null,
      placement: "hosted",
      resultSummary: null,
      status: "queued",
    } satisfies RunRecord);
  });

  it("reads back the digest of the token the claim minted, and never the token", async () => {
    const runId = await claimedRun("claimed");

    const record = await observe(runId);

    expect(record?.executionTokenHash).toBe(hashExecutionToken(TOKEN));
    expect(record?.executionTokenHash).not.toContain(TOKEN);
  });

  it("reads a claimed Run that records no pass, which is the abandoned shape", async () => {
    // ADR 0016's mandatory case: `start()` returned, the process died before
    // `markExecuting`, and nothing knows the pass exists. The observation is
    // what makes that row shape checkable from outside.
    const runId = await claimedRun("claimed");

    await expect(observe(runId)).resolves.toMatchObject({
      hostedWorkflowRunId: null,
      status: "claimed",
    });
  });

  it("reads the pass an executing Run records", async () => {
    const runId = await claimedRun("executing");

    await expect(observe(runId)).resolves.toMatchObject({
      hostedWorkflowRunId: PASS,
      status: "executing",
    });
  });

  it("reads when Acceptance absorbed a Result, and the prose it absorbed", async () => {
    const runId = await insertRun("completed");
    await database.admin(
      `update run set accepted_at = '${ACCEPTED_AT.toISOString()}',
                      result_summary = 'No review was performed.'
       where id = '${runId}'`
    );

    await expect(observe(runId)).resolves.toMatchObject({
      acceptedAt: ACCEPTED_AT,
      resultSummary: "No review was performed.",
      status: "completed",
    });
  });

  it("reads the structured detail the terminal transition itself wrote", async () => {
    // Written by `terminateLostExecution` rather than by this file, because a
    // detail spelled here would prove the projection agrees with the test
    // rather than with the writer.
    const runId = await claimedRun("claimed");
    const outcome = await runtime.withOwner(ACME, (tx) =>
      terminateLostExecution(tx, {
        detector: "hosted_watchdog",
        evidence: { kind: "deadline", now: NOW, workflowRunId: LIFECYCLE },
        observation: "deadline_elapsed",
        ownerId: ACME,
        runId,
      })
    );

    expect(outcome.terminalized).toBeTruthy();
    await expect(observe(runId)).resolves.toMatchObject({
      failureDetail: {
        detector: "hosted_watchdog",
        lostFrom: "claimed",
        observation: "deadline_elapsed",
      },
      failureReason: "worker_lost",
      status: "failed",
    });
  });

  it("reads nothing for a Run another Owner holds, rather than refusing it", async () => {
    // The tenancy fact ADR 0016 leans on when it removes `wrong_tenant`: from
    // inside `withOwner()` another Owner's Run is invisible, so this read and a
    // read of a Run id nobody holds are deliberately indistinguishable.
    const runId = await insertRun("queued", STRANGER);

    await expect(observe(runId)).resolves.toBeNull();
    await expect(observe(runId, STRANGER)).resolves.toMatchObject({
      status: "queued",
    });
  });

  it("reads nothing for a Run id nobody holds", async () => {
    await expect(observe(NOBODY)).resolves.toBeNull();
  });
});
