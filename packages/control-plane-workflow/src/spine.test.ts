/**
 * The durable spine, run for real: the ingress workflow and the lifecycle it
 * dispatches, executed by `@workflow/vitest`'s builder against the local
 * World, over the real control plane on the local database stack, with GitHub
 * substituted at the transport and nowhere else.
 *
 * What is being measured is what [ADR
 * 0014](../../../docs/adr/0014-workflow-orchestration-seam.md) could only
 * decide on paper: that a created Run reaches a claimable state through the
 * real workflow runtime rather than a stub, that the `run` row arbitrates
 * between two lifecycles, that the unclaimed window closes as `unscheduled`
 * and nothing else, and that the re-drive of a contended delivery is the
 * platform's own step retry.
 *
 * **The steps compose their own control plane from `process.env`**, in a module
 * registry this file does not share - that is the builder-dependence the
 * package exists for, and the environment is set below before any workflow
 * starts. The test composes a control plane of its own beside it, over the same
 * database, to record deliveries and read Runs back.
 *
 * **The database is the local stack's maintenance database.** This package may
 * depend on no Postgres driver, so it cannot create a database of its own the
 * way `@reprove/control-plane`'s tests do; it bootstraps and migrates the one
 * `docker compose` created instead, and keeps every Run it makes distinct by
 * giving each case a repository id of its own. Rows accumulate there between
 * runs and `pnpm db:down` is what clears them.
 */
import { setTimeout } from "node:timers/promises";

import type {
  ControlPlane,
  DeliveryToProcess,
  Phase0RunProfile,
} from "@reprove/control-plane";
import {
  bootstrap,
  createControlPlane,
  migrate,
  PHASE_0_RUN_PROFILE,
} from "@reprove/control-plane";
import type { Result } from "@reprove/protocol/v1";
import { protocolVersion } from "@reprove/protocol/v1";
import type {
  HostedDispatchOutcome,
  HostedDispatchPorts,
  HostedPassOutcome,
} from "@reprove/worker-hosted";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, start } from "workflow/api";

import { dispatchHostedPass } from "./dispatch.js";
import { ENVIRONMENT } from "./environment.js";
import type { CannedGitHub } from "./github.test-support.js";
import {
  APP_ID,
  PRIVATE_KEY,
  signedDelivery,
  startCannedGitHub,
  WEBHOOK_SECRET,
} from "./github.test-support.js";
import type { IngressConclusion } from "./ingress.js";
import { ingressDelivery } from "./ingress.js";
import type { LifecycleOutcome } from "./lifecycle.js";
import { runLifecycle } from "./lifecycle.js";
import type { PassOutcome } from "./pass.js";
import {
  failedPass,
  PASS_FAILURE,
  silentPass,
  throwingPass,
  unfinishedPass,
} from "./pass.test-support.js";
import { composeHostedPlacement } from "./placement.js";

/**
 * The local stack, as `tools/db/compose.yaml` publishes it. Spelled here rather
 * than imported, because the module that knows these addresses in
 * `@reprove/control-plane` is unshipped and this package sees only what that
 * package publishes.
 */
const ADMIN_URL = "postgres://postgres@127.0.0.1:55532/reprove";
const RUNTIME_URL = "postgres://reprove_runtime@127.0.0.1:56532/reprove";
const RUNTIME_PASSWORD = "local-development-only";

const ACME = 1001;

/** A short window, so a case can watch it close. */
const SHORT_WINDOW_MS = 2000;

/**
 * How far past a closed claim window one case lands a late record: inside the
 * ten-second grace an unrecorded lifecycle spends before it would record
 * itself, with margin at both ends for a slow runner.
 */
const LATE_RECORD_MS = 3000;

/**
 * Each case gets a repository of its own, so nothing one case does to a pull
 * request is visible to another and rows left from an earlier run collide with
 * nothing. Seconds since an epoch this test chose, which stays inside `int4`
 * for as long as anyone will run it.
 */
let repositoryId = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 1000);
const freshRepository = (): number => {
  repositoryId += 1;
  return repositoryId;
};
let guid = 0;
const freshGuid = (): string => {
  guid += 1;
  return `spine-${repositoryId}-${guid}`;
};

let github: CannedGitHub;
let controlPlane: ControlPlane;
/** Every durable run this file started, cancelled at the end so none sleeps on. */
const started: string[] = [];

/**
 * Posts a signed delivery through the test's control plane and returns what
 * the webhook handed its kick - the same `DeliveryToProcess` the real kick
 * hands to `startDelivery()`.
 */
const commit = async (pullRequest: {
  action: string;
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
}): Promise<DeliveryToProcess> => {
  const handed: DeliveryToProcess[] = [];
  const recording = await createControlPlane({
    database: { connectionString: RUNTIME_URL },
    github: {
      webhookSecret: WEBHOOK_SECRET,
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      runProfile: PHASE_0_RUN_PROFILE,
    },
    kick: (delivery) => {
      handed.push(delivery);
    },
  });
  try {
    const response = await recording.handleGitHubWebhook(
      signedDelivery({
        ...pullRequest,
        deliveryGuid: freshGuid(),
        ownerId: ACME,
      })
    );
    expect(response.status).toBe(200);
  } finally {
    await recording.close();
  }
  const [delivery] = handed;
  if (!delivery) {
    throw new Error("the webhook acknowledged and kicked nothing");
  }
  return delivery;
};

/** Runs the ingress workflow to completion, as the kick would start it. */
const ingest = async (
  delivery: DeliveryToProcess
): Promise<IngressConclusion> => {
  const run = await start(ingressDelivery, [delivery]);
  started.push(run.runId);
  const conclusion = await run.returnValue;
  if (conclusion.dispatched?.workflowRunId) {
    started.push(conclusion.dispatched.workflowRunId);
  }
  return conclusion;
};

/**
 * A `queued` Run with a short unclaimed window, created through the real
 * critical section by a control plane whose profile has the short window, and
 * with no lifecycle dispatched for it - so a case can dispatch its own.
 */
const shortWindowRun = async (): Promise<{
  runId: string;
  repositoryId: number;
}> => {
  const repository = freshRepository();
  github.pullRequest(1, {
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    open: true,
    draft: false,
  });
  const shortProfile: Phase0RunProfile = {
    ...PHASE_0_RUN_PROFILE,
    claimableForMs: SHORT_WINDOW_MS,
  };
  const short = await createControlPlane({
    database: { connectionString: RUNTIME_URL },
    github: {
      webhookSecret: WEBHOOK_SECRET,
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      runProfile: shortProfile,
      apiUrl: github.url,
    },
    kick: () => {},
  });
  try {
    const delivery = await commit({
      action: "opened",
      repositoryId: repository,
      pullRequestNumber: 1,
      headSha: "b".repeat(40),
    });
    const processed = await short.processDelivery(delivery);
    if (processed.runId === null) {
      throw new Error(
        `no Run was created: ${JSON.stringify(processed.outcome)}`
      );
    }
    return { runId: processed.runId, repositoryId: repository };
  } finally {
    await short.close();
  }
};

/**
 * A **claimed** Run with a short execution-liveness window, taken through the
 * real hosted claim so that every execution-ownership column is written the way
 * a claim writes them - together, in one statement.
 *
 * Only **one** duration is moved (ADR 0016): the loop, the durable sleep and
 * the conditional UPDATE are all the real ones. A fake clock was rejected
 * upstream because Workflow's own `sleep` runs on wall time, so a control plane
 * advancing one would disagree with the schedule it is supposed to be testing.
 *
 * **`claimableForMs` keeps its Phase 0 value on purpose.** It is measured from
 * Run creation, and the claim below happens after `processDelivery` has taken
 * the advisory lock, fetched canonical state and inserted the Run - so a short
 * claim window here would be a race between this helper and its own setup, and
 * a slow runner would fail at `claim_window_closed` before reaching the state
 * every case using this actually wants. Nothing here watches the claim window
 * close; `shortWindowRun` is what does that, and it is the one that shortens it.
 */
const shortLivenessRun = async (): Promise<{
  runId: string;
  executionToken: string;
}> => {
  const repository = freshRepository();
  github.pullRequest(1, {
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    open: true,
    draft: false,
  });
  const shortProfile: Phase0RunProfile = {
    ...PHASE_0_RUN_PROFILE,
    livenessForMs: SHORT_WINDOW_MS,
  };
  const short = await createControlPlane({
    database: { connectionString: RUNTIME_URL },
    github: {
      webhookSecret: WEBHOOK_SECRET,
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      runProfile: shortProfile,
      apiUrl: github.url,
    },
    kick: () => {},
  });
  try {
    const delivery = await commit({
      action: "opened",
      repositoryId: repository,
      pullRequestNumber: 1,
      headSha: "b".repeat(40),
    });
    const processed = await short.processDelivery(delivery);
    if (processed.runId === null) {
      throw new Error(
        `no Run was created: ${JSON.stringify(processed.outcome)}`
      );
    }
    const claimed = await short.claimRun({
      ownerId: ACME,
      runId: processed.runId,
    });
    if (claimed.kind !== "granted") {
      throw new Error(`the Run was not claimed: ${JSON.stringify(claimed)}`);
    }
    return {
      executionToken: claimed.grant.executionToken,
      runId: processed.runId,
    };
  } finally {
    await short.close();
  }
};

/**
 * The smallest Result Acceptance will take: no Findings, so nothing here is a
 * claim about review quality, which is Phase 1's.
 */
const acceptableResult = (runId: string): Result => ({
  completeness: "complete",
  disprovedHypothesisCount: 0,
  findings: [],
  passes: [],
  protocolVersion,
  runId,
  stoppedBy: null,
  summary: "Reviewed the change and found nothing to report.",
  usage: { inputTokens: 1000, outputTokens: 100 },
  workerBuildVersion: "0.1.0",
});

/**
 * A queued hosted Run created through a control plane the caller supplies, so a
 * case can choose the profile whose windows it needs.
 */
const queuedRunThrough = async (plane: ControlPlane): Promise<string> => {
  const repository = freshRepository();
  github.pullRequest(1, {
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    open: true,
    draft: false,
  });
  const delivery = await commit({
    action: "opened",
    repositoryId: repository,
    pullRequestNumber: 1,
    headSha: "b".repeat(40),
  });
  const processed = await plane.processDelivery(delivery);
  if (processed.runId === null) {
    throw new Error(`no Run was created: ${JSON.stringify(processed.outcome)}`);
  }
  return processed.runId;
};

/**
 * A control plane whose **execution**-liveness window is short, for the cases
 * that watch a watchdog close one. The caller closes it.
 *
 * Only that one duration moves (ADR 0016): the claim, the loop, the durable
 * sleep and the conditional UPDATE are all the real ones.
 */
const shortLivenessPlane = async (): Promise<ControlPlane> =>
  await createControlPlane({
    database: { connectionString: RUNTIME_URL },
    github: {
      webhookSecret: WEBHOOK_SECRET,
      appId: APP_ID,
      privateKey: PRIVATE_KEY,
      runProfile: { ...PHASE_0_RUN_PROFILE, livenessForMs: SHORT_WINDOW_MS },
      apiUrl: github.url,
    },
    kick: () => {},
  });

/**
 * Hosted dispatch in the shipped order, over the shipped ports, with the pass
 * itself supplied by the case.
 *
 * The stand-in is what makes a watchdog case possible at all: the shipped
 * `hostedPass` composes the Phase 0 fixture Worker core, so it submits a Result
 * within milliseconds and terminalizes the Run - leaving nothing for a
 * watchdog to close. A pass that has not answered yet is the ordinary shape in
 * production and the impossible one for a fixture, and the watchdog reads
 * exactly one thing about a pass: the status its durable run carries. So the
 * ordering, the claim and the `markExecuting` write are all the real ones, and
 * only what `start()` starts is the case's.
 *
 * The write is overridable for the one case that needs it not to land, which is
 * ADR 0016's abandoned Run: a port that rejects before its durable write lands
 * is the crash between `start()` and the write, and it leaves the row that case
 * is about.
 */
const dispatchStandIn = async (
  plane: ControlPlane,
  runId: string,
  startPass: () => Promise<{ runId: string }>,
  markExecuting: HostedDispatchPorts["markExecuting"] = (execution) =>
    plane.markExecuting(execution)
): Promise<HostedDispatchOutcome> => {
  const placement = await composeHostedPlacement(
    () => import("@reprove/worker-hosted")
  );
  if (placement === null) {
    throw new Error("this workspace installs @reprove/worker-hosted");
  }
  return await placement.dispatchHostedRun(
    {
      claimRun: (request) => plane.claimRun(request),
      markExecuting,
      startPass: async () => {
        const run = await startPass();
        started.push(run.runId);
        return { hostedWorkflowRunId: run.runId };
      },
    },
    { ownerId: ACME, runId }
  );
};

/** A claimed Run with a short liveness window and a recorded stand-in pass. */
const withRecordedPass = async (
  startPass: () => Promise<{ runId: string }>
): Promise<{
  runId: string;
  hostedWorkflowRunId: string;
  executionToken: string;
}> => {
  const short = await shortLivenessPlane();
  try {
    const runId = await queuedRunThrough(short);
    const dispatched = await dispatchStandIn(short, runId, startPass);
    if (dispatched.kind !== "dispatched") {
      throw new Error(
        `the Run was not dispatched: ${JSON.stringify(dispatched)}`
      );
    }
    return {
      executionToken: dispatched.executionToken,
      hostedWorkflowRunId: dispatched.hostedWorkflowRunId,
      runId,
    };
  } finally {
    await short.close();
  }
};

const dispatch = async (
  runId: string
): Promise<{ workflowRunId: string; outcome: Promise<LifecycleOutcome> }> => {
  const lifecycle = await start(runLifecycle, [runId, ACME]);
  started.push(lifecycle.runId);
  return { workflowRunId: lifecycle.runId, outcome: lifecycle.returnValue };
};

describe("the durable spine", () => {
  beforeAll(async () => {
    github = await startCannedGitHub();

    // The steps read these, in a module registry of their own. Set before the
    // first workflow starts, and the same for every case in this file.
    process.env[ENVIRONMENT.databaseUrl] = RUNTIME_URL;
    process.env[ENVIRONMENT.webhookSecret] = WEBHOOK_SECRET;
    process.env[ENVIRONMENT.appId] = APP_ID;
    process.env[ENVIRONMENT.privateKey] = PRIVATE_KEY;
    process.env[ENVIRONMENT.githubApiUrl] = github.url;

    await bootstrap({
      connectionString: ADMIN_URL,
      runtimePassword: RUNTIME_PASSWORD,
    });
    await migrate({ connectionString: ADMIN_URL });
    controlPlane = await createControlPlane({
      database: { connectionString: RUNTIME_URL },
      github: {
        webhookSecret: WEBHOOK_SECRET,
        appId: APP_ID,
        privateKey: PRIVATE_KEY,
        runProfile: PHASE_0_RUN_PROFILE,
        apiUrl: github.url,
      },
      kick: () => {},
    });
  });

  afterAll(async () => {
    await Promise.all(
      started.map((workflowRunId) =>
        getRun(workflowRunId)
          .cancel()
          .catch(() => {})
      )
    );
    await controlPlane?.close();
    await github?.close();
  });

  it("turns a committed delivery into a queued Run whose lifecycle is recorded and running", async () => {
    const repository = freshRepository();
    github.pullRequest(7, {
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      open: true,
      draft: false,
    });

    const conclusion = await ingest(
      await commit({
        action: "opened",
        repositoryId: repository,
        pullRequestNumber: 7,
        headSha: "b".repeat(40),
      })
    );

    expect(conclusion).toMatchObject({
      processed: { outcome: { state: "done" } },
      dispatched: {
        workflowRunId: expect.stringMatching(/^wrun_/u),
        cancelledLifecycle: null,
      },
      notified: [],
    });
    const runId = conclusion.processed.runId ?? "";
    // The Run is claimable, and the lifecycle it records is the one the
    // dispatch step started - which is still running, asleep toward the
    // deadline, in the real runtime.
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "queued",
      workflowRunId: conclusion.dispatched?.workflowRunId,
    });
    await expect(
      getRun(conclusion.dispatched?.workflowRunId ?? "").status
    ).resolves.toBe("running");
    // The canonical fetch really happened: App JWT for a token, then the pull
    // request, in that order.
    expect(github.seen.map((seen) => `${seen.method} ${seen.path}`)).toContain(
      "GET /repos/acme/reprove/pulls/7"
    );
  });

  it("supersedes the live Run at a moved head and wakes its lifecycle, which ends reportably", async () => {
    const repository = freshRepository();
    github.pullRequest(8, {
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      open: true,
      draft: false,
    });
    const first = await ingest(
      await commit({
        action: "opened",
        repositoryId: repository,
        pullRequestNumber: 8,
        headSha: "b".repeat(40),
      })
    );
    const firstRunId = first.processed.runId ?? "";
    const firstLifecycle = first.dispatched?.workflowRunId ?? "";

    github.pullRequest(8, {
      headSha: "c".repeat(40),
      baseSha: "a".repeat(40),
      open: true,
      draft: false,
    });
    const second = await ingest(
      await commit({
        action: "synchronize",
        repositoryId: repository,
        pullRequestNumber: 8,
        headSha: "c".repeat(40),
      })
    );

    // The status was committed by the transaction that decided it; the
    // notification followed, and it reached the lifecycle the Run records.
    expect(second.notified).toStrictEqual([
      { runId: firstRunId, notified: true, workflowRunId: firstLifecycle },
    ]);
    await expect(
      getRun<LifecycleOutcome>(firstLifecycle).returnValue
    ).resolves.toStrictEqual({
      kind: "ended",
      status: "superseded",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, firstRunId)
    ).resolves.toMatchObject({
      status: "superseded",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, second.processed.runId ?? "")
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("closes the unclaimed window as unscheduled, from the recorded lifecycle", async () => {
    const { runId } = await shortWindowRun();

    const lifecycle = await dispatch(runId);
    await expect(
      controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId)
    ).resolves.toBeTruthy();

    await expect(lifecycle.outcome).resolves.toStrictEqual({
      kind: "unscheduled",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "unscheduled",
      workflowRunId: lifecycle.workflowRunId,
    });
  });

  it("leaves an orphaned lifecycle inert, and the recorded one in charge", async () => {
    // Two lifecycles for one Run, which is what an unclosable `start()` window
    // produces. The row records one; the other wakes at the same deadline,
    // matches nothing, and ends having written nothing.
    const { runId } = await shortWindowRun();

    const recorded = await dispatch(runId);
    const orphan = await dispatch(runId);
    await expect(
      controlPlane.lifecycle.record(ACME, runId, recorded.workflowRunId)
    ).resolves.toBeTruthy();

    await expect(orphan.outcome).resolves.toStrictEqual({
      kind: "orphaned",
      recordedLifecycle: recorded.workflowRunId,
    });
    await expect(recorded.outcome).resolves.toStrictEqual({
      kind: "unscheduled",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "unscheduled",
      workflowRunId: recorded.workflowRunId,
    });
  });

  it("yields to a record that lands during the grace, and ends as the orphan", async () => {
    // The grace is not only a wait; a record that arrives inside it is
    // honoured. This lifecycle is past its deadline with the column empty, so
    // it is counting down the wakes before it would record itself. Another id
    // lands three seconds in, and the next wake reads that id and returns
    // above every write - the Run is left exactly as it was.
    //
    // That is the reachable half of the `IS NULL` race. The other half - a
    // writer landing between the last read and `recordSelf`, a gap one step
    // boundary wide - has no deterministic seam short of a test-only branch in
    // shipped orchestration, which #87 has just removed. It is left to the two
    // things that make it harmless: the write is `IS NULL`-guarded, so a late
    // writer takes the column outright, and the loop acts on the re-read
    // rather than on its own write, so the lifecycle that lost reports
    // `orphaned` on the next wake exactly as this one does.
    const { runId } = await shortWindowRun();
    // A lifecycle id nobody started. Nothing but the record below can write to
    // this Run, so "no transition was attempted" is unambiguous; the column is
    // `text` and the loop only ever compares it, so a synthetic id serves
    // where a second real lifecycle would add a durable run that must not run.
    const lateRecord = "wrun_late_record";

    const orphan = await dispatch(runId);
    const schedule = await controlPlane.lifecycle.schedule(ACME, runId);
    if (schedule === null) {
      throw new Error("the Run this case created is not visible");
    }
    // Measured from the deadline the row carries rather than from here, so a
    // slow setup eats the margin instead of the property.
    await setTimeout(
      schedule.claimableUntil.getTime() + LATE_RECORD_MS - Date.now()
    );
    await expect(
      controlPlane.lifecycle.record(ACME, runId, lateRecord)
    ).resolves.toBeTruthy();

    await expect(orphan.outcome).resolves.toStrictEqual({
      kind: "orphaned",
      recordedLifecycle: lateRecord,
    });
    // Still `queued`, and the id is the late writer's: the orphan returned
    // above `expireUnclaimed`, and it never recorded itself either.
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "queued",
      workflowRunId: lateRecord,
    });
  });

  it("records itself after the grace when nobody recorded it, and closes the unclaimed window", async () => {
    // The dispatch step's `start()` succeeded and its `record` never landed, so
    // the deadline passes over a Run that names no lifecycle at all. Both
    // transitions carry `workflow_run_id = <the writer>`, so no lifecycle could
    // close either window from there and the Run would stay `queued` past its
    // deadline forever. This one is alive, so once the grace has proved that no
    // record is coming it writes its own through the same first-writer-wins
    // statement, and the next wake closes the window it was already watching.
    const { runId } = await shortWindowRun();

    const unrecorded = await dispatch(runId);

    await expect(unrecorded.outcome).resolves.toStrictEqual({
      kind: "unscheduled",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "unscheduled",
      workflowRunId: unrecorded.workflowRunId,
    });
  });

  it("ends a claimed Run nobody came back for, from the same durable run", async () => {
    // ADR 0016's mandatory abandoned case, through the real loop: the Run is
    // claimed, no pass is ever recorded, and no Result ever arrives.
    // `claimableUntil` cannot touch it - it writes only over `queued` - so
    // without the second window this Run stays Result-eligible forever.
    //
    // The lifecycle that closes it is the *same* durable run that was
    // scheduling the claim window, which is what "a state-driven loop over both
    // windows rather than a second durable run" means observably.
    const { runId } = await shortLivenessRun();

    const lifecycle = await dispatch(runId);
    await expect(
      controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId)
    ).resolves.toBeTruthy();

    await expect(lifecycle.outcome).resolves.toStrictEqual({
      // No pass was ever recorded, so there is nothing to cancel and nothing
      // the watchdog can say beyond the deadline having passed.
      cancelledPass: null,
      kind: "worker_lost",
      lostFrom: "claimed",
      observation: "deadline_elapsed",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "failed",
      workflowRunId: lifecycle.workflowRunId,
    });
    // Exactly one durable run was ever started for this Run: the watchdog is a
    // branch of the lifecycle, not a workflow beside it. A second `start()`
    // would be a third orphan window of the kind that created the `claimed`
    // hole this case exists to close.
    expect(started.filter((id) => id === lifecycle.workflowRunId)).toHaveLength(
      1
    );
  });

  it("records itself after the grace when nobody recorded it, and ends the claimed Run", async () => {
    // The same Run as the case above, with the one difference that makes it the
    // hole ADR 0015 exists to close: nothing records a lifecycle, so the Run is
    // claimed, Result-eligible, and carries no writer either transition could
    // name. `claimableUntil` cannot touch it - it writes only over `queued` -
    // and neither could any lifecycle, so it would stay eligible forever. The
    // grace passes, this lifecycle records itself, and the liveness branch it
    // was already in closes the window on the next wake.
    const { runId } = await shortLivenessRun();

    const unrecorded = await dispatch(runId);

    await expect(unrecorded.outcome).resolves.toStrictEqual({
      // Nothing recorded a lifecycle, so nothing recorded a pass either: there
      // is nothing to cancel and nothing the watchdog can say beyond the
      // deadline having passed.
      cancelledPass: null,
      kind: "worker_lost",
      lostFrom: "claimed",
      observation: "deadline_elapsed",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "failed",
      workflowRunId: unrecorded.workflowRunId,
    });
  });

  it("leaves an orphaned lifecycle inert over the executing window too", async () => {
    // ADR 0014's ownership guard holds on the second window as on the first.
    const { runId } = await shortLivenessRun();

    const recorded = await dispatch(runId);
    const orphan = await dispatch(runId);
    await expect(
      controlPlane.lifecycle.record(ACME, runId, recorded.workflowRunId)
    ).resolves.toBeTruthy();

    await expect(orphan.outcome).resolves.toStrictEqual({
      kind: "orphaned",
      recordedLifecycle: recorded.workflowRunId,
    });
    await expect(recorded.outcome).resolves.toMatchObject({
      kind: "worker_lost",
    });
  });

  it("reports a Run that ended while it slept, rather than terminalizing it", async () => {
    // The loop re-reads authoritative state on every wake rather than trusting
    // the timestamp it slept toward, and this is what that buys: Acceptance
    // absorbed a Result while the lifecycle was asleep toward the execution
    // deadline, so the wake finds a terminal Run and reports it instead of
    // writing a Failure over a completed one.
    //
    // It is the same re-read that will make self-hosted Lease renewal a column
    // write rather than a second liveness system (ADR 0015) - a renewal that
    // lands mid-sleep is simply the next deadline. Renewal itself has no
    // transport in Phase 0, so what is exercised here is the re-read.
    const { executionToken, runId } = await shortLivenessRun();
    const lifecycle = await dispatch(runId);
    await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

    await expect(
      controlPlane.acceptResult({
        executionToken,
        ownerId: ACME,
        result: acceptableResult(runId),
        runId,
      })
    ).resolves.toStrictEqual({ kind: "accepted", runStatus: "completed" });

    await expect(lifecycle.outcome).resolves.toStrictEqual({
      kind: "ended",
      status: "completed",
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({ status: "completed" });
  });

  describe("the hosted placement", () => {
    it("runs a hosted Run through Worker core, and its Result reaches Acceptance", async () => {
      // The whole point of the placement, end to end and through the shipped
      // composition: `dispatchHostedPass` claims, starts the durable pass and
      // records it; the pass composes the Phase 0 Worker core and submits what
      // it produced to the same Acceptance a self-hosted Worker reaches over
      // HTTP. Placement decided the composition; nothing about the Run's
      // treatment differs.
      const runId = await queuedRunThrough(controlPlane);

      const dispatched = await dispatchHostedPass(ACME, runId);
      if (dispatched.kind !== "dispatched") {
        throw new Error(
          `the Run was not dispatched: ${JSON.stringify(dispatched)}`
        );
      }
      started.push(dispatched.hostedWorkflowRunId);

      await expect(
        getRun<PassOutcome>(dispatched.hostedWorkflowRunId).returnValue
      ).resolves.toStrictEqual({ kind: "accepted", runStatus: "completed" });
      // The Run records the pass, which is the column the lifecycle cancels
      // from, and it is terminal because a Result was absorbed rather than
      // because anything here said so.
      await expect(
        controlPlane.lifecycle.schedule(ACME, runId)
      ).resolves.toMatchObject({
        hostedWorkflowRunId: dispatched.hostedWorkflowRunId,
        status: "completed",
      });
    });

    it("serves a self-hosted Run with no hosted placement composed at all", async () => {
      // ADR 0010's other deployment: `control-plane` + `control-plane-workflow`
      // and no harness code anywhere. Nothing on this path consults the hosted
      // composition - the webhook, the ingress workflow, Run creation, the
      // lifecycle and the claim are all reached without it - so a control plane
      // whose hosted driver is not installed serves exactly as this one does.
      await expect(
        composeHostedPlacement(() =>
          Promise.reject(
            Object.assign(
              new Error(
                "Cannot find package '@reprove/worker-hosted' imported from composition.js"
              ),
              { code: "ERR_MODULE_NOT_FOUND" }
            )
          )
        )
      ).resolves.toBeNull();

      const selfHosted = await createControlPlane({
        database: { connectionString: RUNTIME_URL },
        github: {
          webhookSecret: WEBHOOK_SECRET,
          appId: APP_ID,
          privateKey: PRIVATE_KEY,
          runProfile: { ...PHASE_0_RUN_PROFILE, placement: "self_hosted" },
          apiUrl: github.url,
        },
        kick: () => {},
      });
      let runId = "";
      try {
        runId = await queuedRunThrough(selfHosted);
      } finally {
        await selfHosted.close();
      }

      // Claimable, and waiting for its own placement: the hosted claim is
      // refused by name rather than taking a Run another mechanism dispatches.
      await expect(
        controlPlane.lifecycle.schedule(ACME, runId)
      ).resolves.toMatchObject({
        hostedWorkflowRunId: null,
        status: "queued",
      });
      await expect(
        controlPlane.claimRun({ ownerId: ACME, runId })
      ).resolves.toStrictEqual({
        kind: "refused",
        reason: "placement_mismatch",
      });
    });

    it("leaves a Run claimed with no pass recorded when the write never lands", async () => {
      // ADR 0016's mandatory abandoned case, through the shipped ordering over
      // the real claim: a `markExecuting` port that rejects before its durable
      // write lands is the crash between `start()` and the write. The pass is
      // genuinely running - it is
      // a real durable run started here - and the row records none, which is
      // the whole of what the window is.
      const short = await shortLivenessPlane();
      let runId = "";
      try {
        runId = await queuedRunThrough(short);
        await expect(
          dispatchStandIn(
            short,
            runId,
            () => start(unfinishedPass, []),
            () => Promise.reject(new Error("the dispatching process died"))
          )
        ).rejects.toThrow("the dispatching process died");
      } finally {
        await short.close();
      }

      await expect(
        controlPlane.lifecycle.schedule(ACME, runId)
      ).resolves.toMatchObject({
        hostedWorkflowRunId: null,
        status: "claimed",
      });

      // `claimableUntil` writes only over `queued`, so nothing but execution
      // liveness can end this Run - which is why ADR 0015 covers the whole of
      // Acceptance's window rather than `executing` alone.
      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      await expect(lifecycle.outcome).resolves.toStrictEqual({
        cancelledPass: null,
        kind: "worker_lost",
        lostFrom: "claimed",
        observation: "deadline_elapsed",
      });
    });

    it("terminalizes the Run first and cancels the pass it recorded second", async () => {
      // The ordering #56 left structural. The database write is the
      // correctness boundary; cancelling is reclamation that follows a
      // transition that won.
      const { hostedWorkflowRunId, runId } = await withRecordedPass(() =>
        start(unfinishedPass, [])
      );
      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      await expect(lifecycle.outcome).resolves.toStrictEqual({
        cancelledPass: hostedWorkflowRunId,
        kind: "worker_lost",
        // The pass is still running past the Run's deadline, so the watchdog
        // has seen nothing but the deadline and says only that.
        lostFrom: "executing",
        observation: "deadline_elapsed",
      });
      await expect(
        controlPlane.lifecycle.schedule(ACME, runId)
      ).resolves.toMatchObject({ hostedWorkflowRunId, status: "failed" });
      await expect(getRun(hostedWorkflowRunId).status).resolves.toBe(
        "cancelled"
      );
    });

    it("cancels nothing when its transition lost the race to Acceptance", async () => {
      // Cancelling first would make a resource operation load-bearing for
      // correctness: the Run completed while the lifecycle slept, so the pass
      // that produced that Result must not be killed on the way past.
      const { executionToken, hostedWorkflowRunId, runId } =
        await withRecordedPass(() => start(unfinishedPass, []));

      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);
      await expect(
        controlPlane.acceptResult({
          executionToken,
          ownerId: ACME,
          result: acceptableResult(runId),
          runId,
        })
      ).resolves.toStrictEqual({ kind: "accepted", runStatus: "completed" });

      await expect(lifecycle.outcome).resolves.toStrictEqual({
        kind: "ended",
        status: "completed",
      });
      await expect(getRun(hostedWorkflowRunId).status).resolves.toBe("running");
    });

    it("names a pass that was cancelled out of band", async () => {
      const { hostedWorkflowRunId, runId } = await withRecordedPass(() =>
        start(unfinishedPass, [])
      );
      await getRun(hostedWorkflowRunId).cancel();

      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      await expect(lifecycle.outcome).resolves.toMatchObject({
        kind: "worker_lost",
        observation: "workflow_cancelled",
      });
    });

    it("names a pass that ended without ever submitting a Result", async () => {
      // The Run is still inside Acceptance's window, so a pass that returned
      // normally submitted nothing. That is a different fact from a deadline
      // that merely elapsed, and the failure detail records which.
      const { hostedWorkflowRunId, runId } = await withRecordedPass(() =>
        start(silentPass, [])
      );
      await expect(getRun(hostedWorkflowRunId).returnValue).resolves.toBe(
        "returned"
      );

      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      await expect(lifecycle.outcome).resolves.toMatchObject({
        kind: "worker_lost",
        observation: "workflow_terminal_without_result",
      });
    });

    it("loses a structured Failure's reason, because no transition carries one", async () => {
      // The gap, measured rather than remembered. Worker core failed, the
      // placement returned the Failure as the pass's own value, and it wrote
      // nothing - Phase 0 has no transition for a structured Failure, and
      // `RUN_FAILURE_REASONS` has no member but `worker_lost` for one to land
      // in. So the Run is left inside Acceptance's window, and the watchdog
      // reads a pass that ended `completed` and closes it as an execution that
      // reported nothing. The reason, the phase and the detail survive only in
      // the durable run's return value, which nothing reads.
      //
      // Unreachable in the shipped composition: `createPhase0WorkerCore`
      // produces the fixture Result or throws. The first real Worker core makes
      // it reachable, and closing it means a transition and the reason codes it
      // writes. This case is here so that change has something to break.
      const { hostedWorkflowRunId, runId } = await withRecordedPass(() =>
        start(failedPass, [])
      );
      await expect(
        getRun<HostedPassOutcome>(hostedWorkflowRunId).returnValue
      ).resolves.toStrictEqual(PASS_FAILURE);

      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      // Strictly equal, because what this case is about is the fields that are
      // *not* there: the whole of what the terminal transition wrote is a
      // `worker_lost` Failure observed as a pass that ended without a Result,
      // and neither `sandbox_teardown_incomplete` nor `teardown` appears in it.
      await expect(lifecycle.outcome).resolves.toStrictEqual({
        cancelledPass: hostedWorkflowRunId,
        kind: "worker_lost",
        lostFrom: "executing",
        observation: "workflow_terminal_without_result",
      });
      await expect(
        controlPlane.lifecycle.schedule(ACME, runId)
      ).resolves.toMatchObject({ hostedWorkflowRunId, status: "failed" });
    });

    it("names a pass that failed where no in-process detector could see it", async () => {
      // The `hosted_prompt` detector catches a Pass that throws inside the
      // placement. This is the other shape: the durable run itself failed, so
      // the only witness is the World, and the watchdog is what reads it.
      const { hostedWorkflowRunId, runId } = await withRecordedPass(() =>
        start(throwingPass, [])
      );
      await expect(getRun(hostedWorkflowRunId).returnValue).rejects.toThrow(
        /pass threw|failed/u
      );

      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      await expect(lifecycle.outcome).resolves.toMatchObject({
        kind: "worker_lost",
        observation: "workflow_failed",
      });
    });

    it("says the pass state was unavailable, and still cancels best-effort", async () => {
      // A pass id the World has never heard of. Reclamation is best-effort by
      // design - the Run is already terminal, and a cancel that throws must not
      // retry a transition that has been decided.
      const short = await shortLivenessPlane();
      let runId = "";
      let token = "";
      try {
        runId = await queuedRunThrough(short);
        const claim = await short.claimRun({ ownerId: ACME, runId });
        if (claim.kind !== "granted") {
          throw new Error(`the Run was not claimed: ${JSON.stringify(claim)}`);
        }
        token = claim.grant.executionToken;
        await expect(
          short.markExecuting({
            executionToken: token,
            hostedWorkflowRunId: "wrun_never_started",
            ownerId: ACME,
            runId,
          })
        ).resolves.toBeTruthy();
      } finally {
        await short.close();
      }

      const lifecycle = await dispatch(runId);
      await controlPlane.lifecycle.record(ACME, runId, lifecycle.workflowRunId);

      await expect(lifecycle.outcome).resolves.toStrictEqual({
        cancelledPass: "wrun_never_started",
        kind: "worker_lost",
        lostFrom: "executing",
        observation: "workflow_state_unavailable",
      });
    });
  });

  it("re-drives a contended delivery through the platform's step retry", async () => {
    // Two deliveries for one pull request, started together. The canned
    // GitHub holds the first canonical fetch, which is the window ADR 0013 puts
    // the fetch inside: the advisory lock is held across it, so the second
    // processor finds the lock taken and settles `contended`. Nothing Reprove
    // owns retries it; the step throws `RetryableError`, and the platform
    // brings the same step back, where it now finds a Run at the canonical
    // head and concludes `duplicate_head`.
    const repository = freshRepository();
    github.pullRequest(
      9,
      {
        headSha: "b".repeat(40),
        baseSha: "a".repeat(40),
        open: true,
        draft: false,
      },
      { delayMs: 1500 }
    );
    const pullRequest = {
      repositoryId: repository,
      pullRequestNumber: 9,
      headSha: "b".repeat(40),
    };
    const [opened, synchronized] = await Promise.all([
      commit({ ...pullRequest, action: "opened" }),
      commit({ ...pullRequest, action: "synchronize" }),
    ]);

    const [first, second] = await Promise.all([
      ingest(opened),
      ingest(synchronized),
    ]);

    const outcomes = [first.processed.outcome, second.processed.outcome];
    expect(outcomes).toContainEqual({ state: "done" });
    expect(outcomes).toContainEqual({
      state: "discarded",
      disposition: "duplicate_head",
    });
    // Exactly one Run, and the one that lost the lock created none.
    const created = [first, second].filter(
      (conclusion) => conclusion.processed.runId !== null
    );
    expect(created).toHaveLength(1);
    // The re-driven attempt reached GitHub a second time, which is what says
    // it was retried rather than concluded from the first attempt's failure.
    expect(
      github.seen.filter((seen) => seen.path === "/repos/acme/reprove/pulls/9")
        .length
    ).toBeGreaterThanOrEqual(2);
  });
});
