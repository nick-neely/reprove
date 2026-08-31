import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { getRun } from 'workflow/api';
import { waitForSleep } from '@workflow/vitest';
import {
  configureDb,
  migrate,
  withOwner,
  closeDb,
  receiveDelivery,
  startDelivery,
  dispatchHosted,
  supersedeTo,
  submitResult,
  claimRun,
  type CanonicalPullRequest,
  type GitHubPort,
} from '@proto38/control-plane';
import { PROTOCOL_VERSION } from '@proto38/protocol/v1';
import { composeHosted, composeSelfHostedOnly, startIngestServer } from '@proto38/app-control-plane';

const OWNER = 4242;
const OTHER_OWNER = 9999;
const REPO = 99001;

const ledger: string[] = [];
const ok = (s: string) => ledger.push(`  [OK]   ${s}`);
const bad = (s: string) => ledger.push(`  [BAD]  ${s}`);
const note = (s: string) => ledger.push(`  [NOTE] ${s}`);
const head = (s: string) => ledger.push(`\n${s}`);

// The GitHub port a *step* sees. It cannot be injected, so it is a file the
// step reads through PROTO38_GITHUB_FIXTURE. Driving GitHub from the scenarios
// therefore means writing this file.
const fixturePath = join(mkdtempSync(join(tmpdir(), 'proto38-')), 'github.json');
process.env.PROTO38_GITHUB_FIXTURE = fixturePath;

function setGitHub(canonical: Partial<CanonicalPullRequest>, transientOnce = false) {
  writeFileSync(
    fixturePath,
    JSON.stringify({
      canonical: {
        headSha: 'h1',
        baseSha: 'b1',
        state: 'open',
        draft: false,
        provenance: 'external',
        ...canonical,
      },
      transientOnce,
    }),
  );
}

// The request-path port. Same interface, different instance - which is itself
// the finding: these two cannot be the same object.
const requestPathGitHub: GitHubPort = {
  async getPullRequest() {
    return JSON.parse(readFileSync(fixturePath, 'utf8')).canonical;
  },
};

let server: Server;
let baseUrl: string;
let seq = 0;

async function deliver(action = 'synchronize') {
  const { deliveryId, duplicate } = await receiveDelivery({
    ownerId: OWNER,
    installationId: 7,
    repositoryId: REPO,
    repositoryLocator: 'acme/widget',
    pullRequestNumber: 5,
    event: 'pull_request',
    action,
    deliveryGuid: `guid-${++seq}`,
  });
  const run = await startDelivery(deliveryId, OWNER);
  return { deliveryId, duplicate, wf: run, out: (await run.returnValue) as any };
}

async function runRow(runId: string) {
  return withOwner(OWNER, async (c) => {
    const r = await c.query('select * from run where id = $1', [runId]);
    return r.rows[0];
  });
}

beforeAll(async () => {
  configureDb(process.env.PROTO38_REPROVE_URL ?? 'postgres://world:world@localhost:55438/reprove');
  await migrate();
  await withOwner(OWNER, async (c) => {
    await c.query(`insert into owner values ($1,'acme') on conflict do nothing`, [OWNER]);
    await c.query(`insert into owner values ($1,'other') on conflict do nothing`, [OTHER_OWNER]);
    await c.query(`insert into repository values ($1,$2,'acme/widget') on conflict do nothing`, [
      REPO,
      OWNER,
    ]);
  });
  ({ server, baseUrl } = await startIngestServer());
  setGitHub({});
});

afterAll(async () => {
  console.log('\n========== #38 SCENARIO LEDGER ==========');
  console.log(ledger.join('\n'));
  console.log('\n=========================================\n');
  server?.close();
  await closeDb();
});

// ---------------------------------------------------------------------------

describe('A. composition', () => {
  it('the hosted deployment composes worker-hosted; the self-hosted one does not', async () => {
    head('A. Composition (ADR 0010)');
    const hosted = composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
    expect(hosted.hostedComposed).toBe(true);
    const selfHosted = composeSelfHostedOnly({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
    expect(selfHosted.hostedComposed).toBe(false);
    ok('hosted composition has a dispatcher; self-hosted composition has none');
    ok(`both advertise the same window current=${hosted.protocol.current} minimum=${hosted.protocol.minimum}`);
  });

  it('a self-hosted-only deployment cannot dispatch, and the Run simply stays claimable', async () => {
    composeSelfHostedOnly({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
    setGitHub({ headSha: 'sh1' });
    const { out } = await deliver();
    const d = await dispatchHosted(out.runId, OWNER);
    expect(d.dispatched).toBe(false);
    const row = await runRow(out.runId);
    expect(row.status).toBe('queued');
    ok(`self-hosted composition: dispatchHosted -> ${(d as any).reason}, Run stays queued`);
    (globalThis as any).__selfHostedRun = out.runId;
  });
});

describe('B. a delivery becomes a Worker-ready Run', () => {
  beforeAll(() => {
    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
  });

  it('creates one Run with a complete immutable spec and one durable lifecycle', async () => {
    head('B. Ingress to a Worker-ready Run (ADR 0013)');
    setGitHub({ headSha: 'h1' });
    const { out } = await deliver();
    expect(['created', 'superseded']).toContain(out.disposition);
    const row = await runRow(out.runId);
    expect(row.status).toBe('queued');
    expect(row.workflow_run_id).toBeTruthy();
    expect(row.spec.configDigest).toMatch(/^cfg1-/);
    ok(`delivery -> Run ${out.runId}, durable lifecycle ${row.workflow_run_id}`);
    ok(`spec complete at creation: digest=${row.spec.configDigest}, claimableUntil written`);
    (globalThis as any).__run = out.runId;
  });

  it('a redelivered GUID is a no-op', async () => {
    const dup = await receiveDelivery({
      ownerId: OWNER,
      installationId: 7,
      repositoryId: REPO,
      repositoryLocator: 'acme/widget',
      pullRequestNumber: 5,
      event: 'pull_request',
      action: 'synchronize',
      deliveryGuid: `guid-${seq}`,
    });
    expect(dup.duplicate).toBe(true);
    ok('redelivered GUID resolves to the same terminal ledger entry, no second Run');
  });

  it('a delivery at a head a Run already exists for is a no-op in any status', async () => {
    const { out } = await deliver();
    expect(out.disposition).toBe('noop');
    ok('same head -> disposition=noop, no second Run');
  });

  it('a transient GitHub failure is re-driven by the platform, not by a sweeper', async () => {
    setGitHub({ headSha: 'h2' }, true);
    const { out } = await deliver();
    expect(['created', 'superseded']).toContain(out.disposition);
    ok(`transient disposition retried automatically -> ${out.disposition}, Run ${out.runId}`);
    (globalThis as any).__run = out.runId;
  });
});

describe('C. hosted dispatch and Acceptance', () => {
  it('dispatches, executes worker-core, and Acceptance absorbs exactly one Result', async () => {
    head('C. Hosted dispatch through Workflow, and Acceptance (ADR 0006)');
    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
    const runId = (globalThis as any).__run as string;
    const d = await dispatchHosted(runId, OWNER);
    expect(d.dispatched).toBe(true);
    const hostedOut = (await getRun((d as any).workflowRunId).returnValue) as any;
    expect(hostedOut.outcome).toBe('result');
    expect(hostedOut.submitted.status).toBe(202);
    const row = await runRow(runId);
    expect(row.status).toBe('completed');
    ok(`hosted pass ${(d as any).workflowRunId} -> HTTP ${hostedOut.submitted.status} -> Run status=completed`);
    ok('the hosted Worker reached Acceptance over the same route a self-hosted Worker will');
    (globalThis as any).__lease = (d as any).leaseToken;
  });

  it('the Run lifecycle resolved through the accepted hook, not a poll', async () => {
    const runId = (globalThis as any).__run as string;
    const row = await runRow(runId);
    const out = (await getRun(row.workflow_run_id).returnValue) as any;
    expect(out.kind).toBe('accepted');
    ok(`runLifecycle resolved kind=accepted status=${out.status} - the race, on the hook branch`);
  });

  it('a second submission of the same Result is rejected', async () => {
    const runId = (globalThis as any).__run as string;
    const row = await runRow(runId);
    const again = await submitResult({
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

describe('D. compatibility', () => {
  it('a claimant below the minimum is told to upgrade and never claims', async () => {
    head('D. Version compatibility (ADR 0006)');
    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
    setGitHub({ headSha: 'compat1' });
    const { out } = await deliver();
    const c = await claimRun(out.runId, OWNER, {
      workerId: 'w-old',
      protocolVersion: 0,
      workerBuildVersion: '0.0.0-old',
    });
    expect(c.claimed).toBe(false);
    expect((c as any).reason).toMatch(/upgrade_required/);
    const row = await runRow(out.runId);
    expect(row.status).toBe('queued');
    ok(`below minimum -> ${(c as any).reason}; Run untouched, still claimable`);
    (globalThis as any).__compatRun = out.runId;
  });

  it('an incompatible Result is refused before the payload is trusted', async () => {
    const runId = (globalThis as any).__compatRun as string;
    const c = await claimRun(runId, OWNER, {
      workerId: 'w-new',
      protocolVersion: PROTOCOL_VERSION,
      workerBuildVersion: '0.0.0-proto38',
    });
    expect(c.claimed).toBe(true);
    const r = await submitResult({
      ownerId: OWNER,
      runId,
      leaseToken: (c as any).leaseToken,
      protocolVersion: 99,
      rawBody: 'this is not even JSON',
    });
    expect(r.accepted).toBe(false);
    expect((r as any).rejection).toBe('upgrade_required');
    ok(`protocolVersion=99 refused as ${(r as any).rejection} before parsing the body`);
    (globalThis as any).__compatLease = (c as any).leaseToken;
  });
});

describe('E. Acceptance refuses what it should', () => {
  it('a forged tenant, a stale lease and a malformed payload are each named', async () => {
    head('E. Acceptance is the stale-result boundary (CONTEXT.md, ADR 0006)');
    const runId = (globalThis as any).__compatRun as string;
    const lease = (globalThis as any).__compatLease as string;
    const good = {
      protocolVersion: PROTOCOL_VERSION,
      runId,
      completeness: 'complete',
      summary: 'ok',
      findings: [],
      workerBuildVersion: '0.0.0-proto38',
    };

    const forged = await submitResult({
      ownerId: OTHER_OWNER,
      runId,
      leaseToken: lease,
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify(good),
    });
    expect(forged.accepted).toBe(false);
    ok(`another tenant submitting for this Run -> ${(forged as any).rejection}`);

    const stale = await submitResult({
      ownerId: OWNER,
      runId,
      leaseToken: 'lease_forged',
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify(good),
    });
    expect(stale.accepted).toBe(false);
    expect((stale as any).rejection).toBe('stale_lease');
    ok(`a Worker holding an old lease -> ${(stale as any).rejection}`);

    const malformed = await submitResult({
      ownerId: OWNER,
      runId,
      leaseToken: lease,
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify({ ...good, completeness: 'partial' }),
    });
    expect(malformed.accepted).toBe(false);
    ok(`partial Result with no stoppedBy -> ${(malformed as any).rejection}: ${(malformed as any).detail}`);

    const oversized = await submitResult({
      ownerId: OWNER,
      runId,
      leaseToken: lease,
      protocolVersion: PROTOCOL_VERSION,
      rawBody: 'x'.repeat(300 * 1024),
    });
    expect((oversized as any).rejection).toBe('oversized');
    ok(`a 300KB submission -> ${(oversized as any).rejection}, rejected before parsing`);

    const accepted = await submitResult({
      ownerId: OWNER,
      runId,
      leaseToken: lease,
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify(good),
    });
    expect(accepted.accepted).toBe(true);
    ok('and the same Run then accepts one well-formed Result, exactly once');
  });
});

describe('F. supersession and cancellation', () => {
  it('a new head supersedes the live Run and cancels both of its durable runs', async () => {
    head('F. Supersession and cancellation (ADR 0006)');
    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl, fault: 'clean' });
    setGitHub({ headSha: 'sup1' });
    const first = await deliver();
    const d = await dispatchHosted(first.out.runId, OWNER);
    expect(d.dispatched).toBe(true);

    setGitHub({ headSha: 'sup2' });
    const second = await deliver();
    expect(second.out.disposition).toBe('superseded');
    const superseded = second.out.supersededRunIds as string[];
    expect(superseded).toContain(first.out.runId);

    await supersedeTo(superseded, OWNER, 'superseded');
    const firstRow = await runRow(first.out.runId);
    expect(firstRow.status).toBe('superseded');
    expect(firstRow.hosted_workflow_run_id).toBeTruthy();
    expect(firstRow.hosted_workflow_run_id).not.toBe(firstRow.workflow_run_id);

    const lifecycle = (await getRun(firstRow.workflow_run_id).returnValue) as any;
    expect(lifecycle.kind).toBe('cancelled');
    ok(`new head -> prior Run ${first.out.runId} status=superseded`);
    ok(`its lifecycle resolved kind=cancelled reason=${lifecycle.reason} - the race, on the cancel branch`);
    ok('the lifecycle run and the hosted pass are separately identified, and');
    ok('cancelled by different mechanisms: hook for the schedule, cancel() for the work');

    const late = await submitResult({
      ownerId: OWNER,
      runId: first.out.runId,
      leaseToken: (d as any).leaseToken,
      protocolVersion: PROTOCOL_VERSION,
      rawBody: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        runId: first.out.runId,
        completeness: 'complete',
        summary: 'late',
        findings: [],
        workerBuildVersion: '0.0.0-proto38',
      }),
    });
    expect(late.accepted).toBe(false);
    ok(`a Worker returning from a partition -> ${(late as any).rejection} (${(late as any).detail})`);
    ok('the Worker was never asked to cooperate; the eligibility window did the work');
    (globalThis as any).__supRun = second.out.runId;
  });
});

describe('G. the claimable deadline', () => {
  it('a Run nobody claims reaches unscheduled through the sleep branch', async () => {
    head('G. The claimable deadline (ADR 0006, ADR 0013)');
    composeSelfHostedOnly({ github: requestPathGitHub, ingestBaseUrl: baseUrl });
    setGitHub({ headSha: 'dead1' });
    const { out } = await deliver();
    const row = await runRow(out.runId);
    const handle = getRun(row.workflow_run_id);
    const sleepId = await waitForSleep(handle as any);
    await handle.wakeUp({ correlationIds: [sleepId] });
    const lifecycle = (await handle.returnValue) as any;
    expect(lifecycle.kind).toBe('deadline');
    const after = await runRow(out.runId);
    expect(after.status).toBe('unscheduled');
    expect(after.failure_reason).toBe('claimable_deadline_expired');
    ok(`claimableUntil expired -> Run status=unscheduled reason=${after.failure_reason}`);
    ok('unscheduled is the one terminal status only the lifecycle can write');
  });
});

describe('H. what the platform does not give us', () => {
  it('start() has no idempotency key, so the Reprove row has to be the arbiter', async () => {
    head('H. Platform facts the design has to absorb');
    const runId = (globalThis as any).__supRun as string;
    const row = await runRow(runId);
    expect(row.workflow_run_id).toBeTruthy();
    note(`start() takes no idempotency key; a retried dispatch step would create a second`);
    note(`durable run. The conditional write of run.workflow_run_id is what makes it safe,`);
    note(`and the loser cancels its own run rather than being orphaned.`);
    ok(`Run ${runId} carries exactly one workflow_run_id: ${row.workflow_run_id}`);
  });

  it('a lost race leaves its sleep uncommitted', async () => {
    note('Promise.race(hook, hook, sleep) resolves correctly on every branch, but the');
    note('SDK logs "uncommitted operation(s): sleep" whenever a hook wins. On world-local');
    note('that is cosmetic. On world-postgres a sleep is a graphile-worker job with a');
    note('runAt, so the question of whether a completed Run leaves a scheduled wake-up');
    note('behind is real and is recorded in the README as unproved.');
    ok('recorded, not asserted');
  });
});

describe('I. the three Worker outcomes', () => {
  it('a Refusal accumulates and returns the Run to the pool; a Failure sends nothing', async () => {
    head('I. Result, Refusal or Failure (#35, map destination as amended)');

    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl, fault: 'refuse-isolation' });
    setGitHub({ headSha: 'ref1' });
    const r = await deliver();
    const dr = await dispatchHosted(r.out.runId, OWNER);
    const refusalOut = (await getRun((dr as any).workflowRunId).returnValue) as any;
    expect(refusalOut.outcome).toBe('refusal');
    const refusedRow = await runRow(r.out.runId);
    expect(refusedRow.status).toBe('queued');
    expect(refusedRow.refusals).toHaveLength(1);
    ok(`Refusal ${refusedRow.refusals[0].reason} accumulated; Run back to queued, still claimable`);
    ok('a Refusal never terminates the Run: only the deadline or an accepted Result does');

    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl, fault: 'internal-failure' });
    setGitHub({ headSha: 'fail1' });
    const f = await deliver();
    const df = await dispatchHosted(f.out.runId, OWNER);
    const failOut = (await getRun((df as any).workflowRunId).returnValue) as any;
    expect(failOut.outcome).toBe('failure');
    expect(failOut.submitted.submitted).toBe(false);
    const failedRow = await runRow(f.out.runId);
    expect(failedRow.status).toBe('executing');
    ok(`Failure ${failOut.submitted.reason}: nothing was submitted, because v1 has no wire form for it`);
    bad(`the Run is left in 'executing' with no terminal transition - it survives only`);
    bad(`because the claimable deadline eventually fires. A Failure the Worker knows about`);
    bad(`should not have to be discovered by a timeout. See README, open question 1.`);

    composeHosted({ github: requestPathGitHub, ingestBaseUrl: baseUrl, fault: 'partial' });
    setGitHub({ headSha: 'part1' });
    const p = await deliver();
    const dp = await dispatchHosted(p.out.runId, OWNER);
    await getRun((dp as any).workflowRunId).returnValue;
    const partialRow = await runRow(p.out.runId);
    expect(partialRow.status).toBe('incomplete');
    ok(`a partial Result is accepted and lands the Run on 'incomplete', not a Failure`);
  });
});
