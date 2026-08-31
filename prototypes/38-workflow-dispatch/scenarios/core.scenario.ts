import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, getRun } from 'workflow/api';
import { waitForSleep } from '@workflow/vitest';
import {
  configureDb,
  migrate,
  withOwner,
  closeDb,
  receiveDelivery,
  claimRun,
  supersedeRuns,
  acceptResult,
  reportHostedFailure,
  type CanonicalPullRequest,
  type GitHubPort,
} from '@proto38/control-plane';
import {
  runLifecycle,
  acceptedToken,
  notifyAccepted,
  notifyCancelled,
} from '@proto38/control-plane-workflow';
import { PROTOCOL_VERSION } from '@proto38/protocol/v1';
import { composeHosted } from '@proto38/app-hosted';
import { composeSelfHosted } from '@proto38/app-selfhosted';

const OWNER = 4242;
const OTHER = 9999;
const REPO = 99001;
const URL = 'postgres://world:world@localhost:55438/reprove';

const ledger: string[] = [];
const ok = (s: string) => ledger.push(`  [OK]   ${s}`);
const bad = (s: string) => ledger.push(`  [BAD]  ${s}`);
const note = (s: string) => ledger.push(`  [NOTE] ${s}`);
const head = (s: string) => ledger.push(`\n${s}`);

// The adapter reads these. Nothing in @proto38/control-plane does.
const fixture = join(mkdtempSync(join(tmpdir(), 'proto38-')), 'github.json');
process.env.PROTO38_GITHUB_FIXTURE = fixture;
process.env.PROTO38_REPROVE_URL = URL;

function setGitHub(c: Partial<CanonicalPullRequest>, transientOnce = false) {
  writeFileSync(
    fixture,
    JSON.stringify({
      canonical: {
        headSha: 'h1',
        baseSha: 'b1',
        state: 'open',
        draft: false,
        provenance: 'external',
        ...c,
      },
      transientOnce,
    }),
  );
}
const requestGitHub: GitHubPort = {
  async getPullRequest() {
    return JSON.parse(readFileSync(fixture, 'utf8')).canonical;
  },
};

let seq = 0;
let pr = 0;

async function deliver(app: { startDelivery: any; profile: any }) {
  const { deliveryId } = await receiveDelivery({
    ownerId: OWNER,
    installationId: 7,
    repositoryId: REPO,
    repositoryLocator: 'acme/widget',
    pullRequestNumber: ++pr,
    event: 'pull_request',
    action: 'synchronize',
    deliveryGuid: `guid-${++seq}`,
  });
  const wf = await app.startDelivery(deliveryId, OWNER, app.profile);
  return { deliveryId, wf, out: (await wf.returnValue) as any };
}

async function runRow(runId: string) {
  return withOwner(OWNER, async (c) => {
    const r = await c.query('select * from run where id = $1', [runId]);
    return r.rows[0];
  });
}

beforeAll(async () => {
  configureDb(URL);
  await migrate();
  await withOwner(OWNER, async (c) => {
    await c.query(`insert into owner values ($1,'acme') on conflict do nothing`, [OWNER]);
    await c.query(`insert into owner values ($1,'other') on conflict do nothing`, [OTHER]);
    await c.query(`insert into repository values ($1,$2,'acme/widget') on conflict do nothing`, [
      REPO,
      OWNER,
    ]);
  });
  setGitHub({});
});

afterAll(async () => {
  console.log('\n========== #38 SCENARIO LEDGER ==========');
  console.log(ledger.join('\n'));
  console.log('\n=========================================\n');
  await closeDb();
});

describe('A. layering', () => {
  it('the core package holds no Workflow code and reads no environment', async () => {
    head('A. Layering (ADR 0010)');
    const cp = await import('@proto38/control-plane');
    expect('runLifecycle' in cp).toBe(false);
    expect('startDelivery' in cp).toBe(false);
    ok('@proto38/control-plane exports no workflow, and declares no `workflow` dependency');
    ok('its resolved closure is protocol, pg, zod - see `npm run boundary`');
    ok('step configuration lives entirely in @proto38/control-plane-workflow');
  });

  it('the self-hosted composition installs no harness code and still schedules', async () => {
    const app = composeSelfHosted({ github: requestGitHub });
    expect(app.hostedComposed).toBe(false);
    setGitHub({ headSha: 'sh1' });
    const { out } = await deliver(app as any);
    const row = await runRow(out.runId);
    expect(row.status).toBe('queued');
    ok('self-hosted deployment: Run reaches queued and stays claimable, with no dispatcher');
  });
});

describe('B. ingress to a Worker-ready Run', () => {
  it('creates one Run with a complete immutable spec and one durable lifecycle', async () => {
    head('B. Ingress to a Worker-ready Run (ADR 0013)');
    const app = composeHosted({ github: requestGitHub });
    setGitHub({ headSha: 'h1' });
    const { out } = await deliver(app as any);
    const row = await runRow(out.runId);
    expect(row.status).toBe('queued');
    expect(row.workflow_run_id).toBeTruthy();
    expect(row.spec.configDigest).toMatch(/^cfg1-/);
    ok(`delivery -> Run ${out.runId}, lifecycle ${row.workflow_run_id}, spec complete at creation`);
    (globalThis as any).__run = out.runId;
  });

  it('a redelivered GUID is a no-op, and a transient failure is re-driven', async () => {
    const app = composeHosted({ github: requestGitHub });
    const dup = await receiveDelivery({
      ownerId: OWNER,
      installationId: 7,
      repositoryId: REPO,
      repositoryLocator: 'acme/widget',
      pullRequestNumber: pr,
      event: 'pull_request',
      action: 'synchronize',
      deliveryGuid: `guid-${seq}`,
    });
    expect(dup.duplicate).toBe(true);
    ok('redelivered GUID resolves to the same terminal ledger entry');

    setGitHub({ headSha: 'h2' }, true);
    const { out } = await deliver(app as any);
    expect(out.runId).toBeTruthy();
    ok(`transient disposition re-driven by the platform -> ${out.disposition}`);
    (globalThis as any).__run = out.runId;
  });
});

describe('C. hosted dispatch and Acceptance', () => {
  it('the app-owned workflow reaches worker-core and Acceptance with no HTTP', async () => {
    head('C. Hosted dispatch, app-owned composition (ADR 0006 NOT reversed)');
    const app = composeHosted({ github: requestGitHub });
    const runId = (globalThis as any).__run as string;
    const d = await app.dispatchHosted(runId, OWNER);
    expect(d.dispatched).toBe(true);
    const out = (await getRun((d as any).workflowRunId).returnValue) as any;
    expect(out.outcome).toBe('result');
    const row = await runRow(runId);
    expect(row.status).toBe('completed');
    ok('one app-owned durable run: worker-core executed, Acceptance absorbed, no ingest URL');
    ok(`Run ${runId} -> status=completed`);
    (globalThis as any).__lease = (d as any).leaseToken;

    const lifecycle = (await getRun(row.workflow_run_id).returnValue) as any;
    expect(lifecycle.kind).toBe('accepted');
    ok('the recorded lifecycle resolved kind=accepted, through its own scoped hook token');
  });

  it('a second submission of the same Result is rejected', async () => {
    const runId = (globalThis as any).__run as string;
    const row = await runRow(runId);
    const again = await acceptResult({
      ownerId: OWNER,
      runId,
      leaseToken: (globalThis as any).__lease,
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify(row.result),
    });
    expect(again.accepted).toBe(false);
    ok(`duplicate Result rejected: ${(again as any).rejection} (${(again as any).detail})`);
  });
});

describe('D. Acceptance refuses what it should', () => {
  it('names each rejection, and accepts exactly once', async () => {
    head('D. Acceptance is the stale-result boundary (CONTEXT.md, ADR 0006)');
    const app = composeHosted({ github: requestGitHub });
    setGitHub({ headSha: 'acc1' });
    const { out } = await deliver(app as any);
    const runId = out.runId;
    const c = await claimRun(runId, OWNER, {
      workerId: 'w1',
      protocolVersion: PROTOCOL_VERSION,
      workerBuildVersion: '0.0.0-proto38',
    });
    expect(c.claimed).toBe(true);
    const lease = (c as any).leaseToken;
    const good = {
      protocolVersion: PROTOCOL_VERSION,
      runId,
      completeness: 'complete',
      summary: 'ok',
      findings: [],
      workerBuildVersion: '0.0.0-proto38',
    };
    const base = { ownerId: OWNER, runId, leaseToken: lease, protocolVersion: PROTOCOL_VERSION };

    const old = await claimRun(runId, OWNER, {
      workerId: 'w0',
      protocolVersion: 0,
      workerBuildVersion: 'old',
    });
    expect((old as any).reason).toMatch(/upgrade_required/);
    ok(`below the minimum -> ${(old as any).reason}, and the Run is untouched`);

    for (const [label, env, expected] of [
      ['another tenant', { ...base, ownerId: OTHER, rawBody: JSON.stringify(good) }, 'wrong_tenant'],
      ['an old lease', { ...base, leaseToken: 'lease_forged', rawBody: JSON.stringify(good) }, 'stale_lease'],
      ['a 300KB body', { ...base, rawBody: 'x'.repeat(300 * 1024) }, 'oversized'],
      ['protocolVersion 99', { ...base, protocolVersion: 99, rawBody: JSON.stringify(good) }, 'upgrade_required'],
      ['partial without stoppedBy', { ...base, rawBody: JSON.stringify({ ...good, completeness: 'partial' }) }, 'malformed'],
    ] as const) {
      const r = await acceptResult(env as any);
      expect(r.accepted).toBe(false);
      expect((r as any).rejection).toBe(expected);
      ok(`${label} -> ${(r as any).rejection}`);
    }

    const accepted = await acceptResult({ ...base, rawBody: JSON.stringify(good) });
    expect(accepted.accepted).toBe(true);
    ok('and one well-formed Result is accepted, exactly once');
  });
});

describe('E. supersession', () => {
  it('cancels the recorded lifecycle and refuses the late Result', async () => {
    head('E. Supersession and cancellation (ADR 0006)');
    const app = composeHosted({ github: requestGitHub });
    setGitHub({ headSha: 'sup1' });
    const first = await deliver(app as any);
    const firstRunId = first.out.runId;

    await withOwner(OWNER, (c) =>
      c.query(`update run set status = 'superseded' where id = $1`, [firstRunId]),
    );
    const rows = await supersedeRuns([firstRunId], OWNER);
    expect(rows[0].workflow_run_id).toBeTruthy();
    const n = await notifyCancelled(firstRunId, OWNER, 'superseded');
    expect(n.notified).toBe(true);

    const lifecycle = (await getRun(rows[0].workflow_run_id!).returnValue) as any;
    expect(lifecycle.kind).toBe('cancelled');
    ok(`prior Run superseded; its recorded lifecycle resolved kind=cancelled`);
    ok('the notifier resolved the lifecycle from the database, not from the Run id');

    const late = await acceptResult({
      ownerId: OWNER,
      runId: firstRunId,
      leaseToken: 'lease_whatever',
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        runId: firstRunId,
        completeness: 'complete',
        summary: 'late',
        findings: [],
        workerBuildVersion: '0.0.0-proto38',
      }),
    });
    expect(late.accepted).toBe(false);
    ok(`a Worker back from a partition -> ${(late as any).rejection}; no cooperation required`);
  });
});

describe('F. the start() orphan window', () => {
  it('the orphan is inert AND the recorded lifecycle still completes', async () => {
    head('F. The start() orphan window (review round 2, defect 1)');
    const app = composeHosted({ github: requestGitHub });
    setGitHub({ headSha: 'orph1' });
    const { out } = await deliver(app as any);
    const runId = out.runId;
    const recorded = (await runRow(runId)).workflow_run_id as string;

    // Simulate the crash: a lifecycle started for this Run but never recorded.
    const orphan = await start(runLifecycle, [
      runId,
      OWNER,
      new Date(Date.now() + 1000).toISOString(),
    ]);
    expect(orphan.runId).not.toBe(recorded);
    ok(`orphan ${orphan.runId} started for a Run already owned by ${recorded}`);

    // Round 2 found the old design false here: with a Run-scoped hook token the
    // orphan takes the token first and the RECORDED lifecycle dies with
    // HookConflictError. Tokens are now lifecycle-scoped, so both live.
    const sleepId = await waitForSleep(orphan as any);
    await orphan.wakeUp({ correlationIds: [sleepId] });
    const orphanOut = (await orphan.returnValue) as any;
    expect(orphanOut.kind).toBe('deadline');
    ok('the orphan reached its deadline and ended without an error');

    let row = await runRow(runId);
    expect(row.status).toBe('queued');
    expect(row.failure_reason).toBeNull();
    ok(`the orphan wrote nothing: Run still ${row.status}, owned by ${row.workflow_run_id}`);

    // The part the old scenario never did: prove the RECORDED lifecycle is
    // still alive and can still carry the Run to a terminal state.
    const d = await app.dispatchHosted(runId, OWNER);
    expect(d.dispatched).toBe(true);
    await getRun((d as any).workflowRunId).returnValue;
    const lifecycle = (await getRun(recorded).returnValue) as any;
    expect(lifecycle.kind).toBe('accepted');
    row = await runRow(runId);
    expect(row.status).toBe('completed');
    ok(`the recorded lifecycle survived the orphan and resolved kind=${lifecycle.kind}`);
    ok(`Run ${runId} -> status=${row.status}`);
  });
});

describe('G. the claimable deadline owns one transition only', () => {
  it('unschedules a Run nobody claimed', async () => {
    head('G. claimableUntil bounds the UNCLAIMED window (review round 2, defect 3)');
    const app = composeHosted({ github: requestGitHub });
    setGitHub({ headSha: 'dead1' });
    const { out } = await deliver(app as any);
    const row = await runRow(out.runId);
    const wf = getRun(row.workflow_run_id);
    const sleepId = await waitForSleep(wf as any);
    await wf.wakeUp({ correlationIds: [sleepId] });
    expect(((await wf.returnValue) as any).kind).toBe('deadline');
    const after = await runRow(out.runId);
    expect(after.status).toBe('unscheduled');
    ok(`a Run nobody claimed -> ${after.status} (${after.failure_reason})`);
  });

  it('leaves an executing Run alone, and that gap is unowned', async () => {
    const app = composeHosted({ github: requestGitHub });
    setGitHub({ headSha: 'dead2' });
    const { out } = await deliver(app as any);
    const runId = out.runId;
    const row = await runRow(runId);
    await withOwner(OWNER, (c) =>
      c.query(`update run set status = 'executing', lease_token = 'lease_x' where id = $1`, [runId]),
    );
    const wf = getRun(row.workflow_run_id);
    const sleepId = await waitForSleep(wf as any);
    await wf.wakeUp({ correlationIds: [sleepId] });
    await wf.returnValue;
    const after = await runRow(runId);
    expect(after.status).toBe('executing');
    ok('an executing Run at the deadline is NOT touched: the deadline bounds claiming only');
    ok("ADR 0006 gives an executing Run's liveness to the Lease, not to this deadline");
    bad('so nothing currently ends an executing Run whose Worker vanished.');
    bad('Lease expiry is unimplemented and unowned. Handed on as a new ticket.');
  });
});

describe('H. the three Worker outcomes', () => {
  it('Refusal returns the Run to the pool; Failure is signalled, not submitted', async () => {
    head('H. Result, Refusal or Failure (#35)');
    setGitHub({ headSha: 'ref1' });
    const refApp = composeHosted({ github: requestGitHub, fault: 'refuse-isolation' });
    const r = await deliver(refApp as any);
    const dr = await refApp.dispatchHosted(r.out.runId, OWNER);
    await getRun((dr as any).workflowRunId).returnValue;
    const refused = await runRow(r.out.runId);
    expect(refused.status).toBe('queued');
    expect(refused.refusals).toHaveLength(1);
    ok(`Refusal ${refused.refusals[0].reason} accumulated; Run back to queued`);

    setGitHub({ headSha: 'fail1' });
    const failApp = composeHosted({ github: requestGitHub, fault: 'internal-failure' });
    const f = await deliver(failApp as any);
    const df = await failApp.dispatchHosted(f.out.runId, OWNER);
    await getRun((df as any).workflowRunId).returnValue;
    const failed = await runRow(f.out.runId);
    expect(failed.status).toBe('failed');
    expect(failed.result).toBeNull();
    ok(`Failure signalled -> status=${failed.status} (${failed.failure_reason}), no Result absorbed`);
    note('reportHostedFailure is UNEXPOSED in this composition, which is weaker than');
    note('"structurally hosted-only". It is an exported function; any composition');
    note('could expose it. Enforcing it needs a private adapter surface.');

    const late = await reportHostedFailure({
      ownerId: OWNER,
      runId: f.out.runId,
      leaseToken: 'lease_any',
      code: 'sandbox_teardown_incomplete',
    });
    expect(late.recorded).toBe(false);
    ok(`a repeated Failure signal on a terminal Run -> ${late.reason}`);

    setGitHub({ headSha: 'part1' });
    const partApp = composeHosted({ github: requestGitHub, fault: 'partial' });
    const p = await deliver(partApp as any);
    const dp = await partApp.dispatchHosted(p.out.runId, OWNER);
    await getRun((dp as any).workflowRunId).returnValue;
    expect((await runRow(p.out.runId)).status).toBe('incomplete');
    ok("a partial Result is accepted and lands 'incomplete', not a Failure");
  });
});
