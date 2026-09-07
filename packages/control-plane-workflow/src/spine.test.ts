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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRun, start } from "workflow/api";

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
 * Only the two durations are moved (ADR 0016): the loop, the durable sleep and
 * the conditional UPDATE are all the real ones. A fake clock was rejected
 * upstream because Workflow's own `sleep` runs on wall time, so a control plane
 * advancing one would disagree with the schedule it is supposed to be testing.
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
    claimableForMs: SHORT_WINDOW_MS,
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

  it("lets a lifecycle nobody recorded end at its deadline without touching the Run", async () => {
    // The dispatch step crashed between `start()` and recording. Its retry
    // will start and record another; this one may write nothing.
    const { runId } = await shortWindowRun();

    const unrecorded = await dispatch(runId);

    await expect(unrecorded.outcome).resolves.toStrictEqual({
      kind: "orphaned",
      recordedLifecycle: null,
    });
    await expect(
      controlPlane.lifecycle.schedule(ACME, runId)
    ).resolves.toMatchObject({
      status: "queued",
      workflowRunId: null,
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
      kind: "worker_lost",
      lostFrom: "claimed",
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
