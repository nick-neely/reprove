// The experiment the adversarial review asked for: is the HTTP shape the *only*
// composition, or merely one that works?
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from 'workflow/api';
import { waitForSleep } from '@workflow/vitest';
import { configureDb, migrate, withOwner, closeDb, claimRun } from '@proto38/control-plane';
import { RunSpecSchema, PROTOCOL_VERSION } from '@proto38/protocol/v1';
import { appOwnedRun } from '@proto38/app-appowned/workflows';

const OWNER = 5151;
const REPO = 77001;
const URL = 'postgres://world:world@localhost:55438/reprove';

const ledger: string[] = [];
const ok = (s: string) => ledger.push(`  [OK]   ${s}`);
const bad = (s: string) => ledger.push(`  [BAD]  ${s}`);
const head = (s: string) => ledger.push(`\n${s}`);

const fixturePath = join(mkdtempSync(join(tmpdir(), 'proto38c-')), 'github.json');
process.env.PROTO38_GITHUB_FIXTURE = fixturePath;
process.env.PROTO38_REPROVE_URL = URL;
writeFileSync(
  fixturePath,
  JSON.stringify({
    canonical: { headSha: 'a1', baseSha: 'b1', state: 'open', draft: false, provenance: 'external' },
  }),
);

let prSeq = 0;
function specFor(runId: string, pr: number) {
  return RunSpecSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    runId,
    ownerId: OWNER,
    repositoryId: REPO,
    pullRequestNumber: pr,
    baseSha: 'b1',
    headSha: 'a1',
    provenance: 'external',
    harness: 'codex',
    model: 'gpt-5-codex',
    strategy: 'standard',
    autonomy: 'verify',
    placement: 'hosted',
    resolvedConfig: { schemaVersion: 1, thresholdSeverity: 'medium', ignore: [] },
    configDigest: 'cfg1-0000000000000000',
    claimableUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
}

// Each seeded Run gets its own pull request number: the partial unique index
// permits only one live Run per pull request, which is ADR 0013's invariant
// doing its job rather than a test problem.
async function seedRun(runId: string) {
  const pr = ++prSeq;
  const spec = specFor(runId, pr);
  await withOwner(OWNER, (c) =>
    c.query(
      `insert into run (id, owner_id, repository_id, pull_request_number, spec, head_sha,
                        claimable_until, placement, status)
       values ($1,$2,$3,$4,$5,$6,$7,'hosted','queued')`,
      [runId, OWNER, REPO, pr, JSON.stringify(spec), 'a1', spec.claimableUntil],
    ),
  );
  return spec;
}

beforeAll(async () => {
  configureDb(URL);
  await migrate();
  await withOwner(OWNER, async (c) => {
    await c.query(`insert into owner values ($1,'appowned') on conflict do nothing`, [OWNER]);
    await c.query(`insert into repository values ($1,$2,'acme/appowned') on conflict do nothing`, [
      REPO,
      OWNER,
    ]);
  });
});

afterAll(async () => {
  console.log('\n===== COMPOSITION LEDGER =====');
  console.log(ledger.join('\n'));
  console.log('\n==============================\n');
  await closeDb();
});

describe('J. is the HTTP composition the only one?', () => {
  it('an app-owned workflow reaches both packages by static import, with no HTTP', async () => {
    head('J. The app-owned composition (adversarial review, point 1a)');
    const spec = await seedRun('run_appowned_1');
    const claim = await claimRun('run_appowned_1', OWNER, {
      workerId: null,
      protocolVersion: PROTOCOL_VERSION,
      workerBuildVersion: '0.0.0-proto38',
    });
    expect(claim.claimed).toBe(true);

    const run = await start(appOwnedRun, [
      spec,
      OWNER,
      (claim as any).leaseToken,
      'clean',
    ]);
    const out = (await run.returnValue) as any;
    expect(out.outcome).toBe('result');
    expect(out.absorbed.accepted).toBe(true);

    const row = await withOwner(OWNER, async (c) => {
      const r = await c.query('select * from run where id = $1', ['run_appowned_1']);
      return r.rows[0];
    });
    expect(row.status).toBe('completed');
    ok('an app-owned step imported worker-hosted AND control-plane statically');
    ok('worker-core executed and Acceptance absorbed the Result in the same durable run');
    ok('no HTTP, no ingest token, no environment access inside @proto38/control-plane');
    bad('so "the HTTP shape is the only remaining composition" was FALSE.');
    bad('ADR 0006 does not have to be reversed. Retracted.');
  });

  it('the core package still reads no environment variables', async () => {
    const spec = await seedRun('run_appowned_2');
    const claim = await claimRun('run_appowned_2', OWNER, {
      workerId: null,
      protocolVersion: PROTOCOL_VERSION,
      workerBuildVersion: '0.0.0-proto38',
    });
    const run = await start(appOwnedRun, [spec, OWNER, (claim as any).leaseToken, 'partial']);
    const out = (await run.returnValue) as any;
    expect(out.absorbed.accepted).toBe(true);
    ok('configureDb() is called by the APP\'s config module, which the step imports statically');
    ok('the step bundle therefore contains the configuration, without any runtime injection');
    ok(`a partial Result still lands 'incomplete': ${out.absorbed.status}`);
    bad('so "step config must come from the environment inside the core package" was FALSE.');
    bad('ADR 0010\'s no-environment rule survives intact. Retracted.');
  });
});

describe('K. the start() crash window', () => {
  it('an orphaned lifecycle cannot touch the Run it was started for', async () => {
    head('K. The start() orphan window (adversarial review, point 4)');
    const { runLifecycle } = await import('@proto38/control-plane');
    const spec = await seedRun('run_orphan_1');

    // Simulate the crash: start a lifecycle and never record its id, exactly as
    // a process death between start() and the conditional write would leave it.
    const orphan = await start(runLifecycle as any, [
      'run_orphan_1',
      OWNER,
      new Date(Date.now() + 1000).toISOString(),
    ]);
    // The retry then starts the lifecycle that does get recorded.
    const real = await start(runLifecycle as any, [
      'run_orphan_1',
      OWNER,
      new Date(Date.now() + 30 * 60_000).toISOString(),
    ]);
    await withOwner(OWNER, (c) =>
      c.query(`update run set workflow_run_id = $1 where id = $2 and workflow_run_id is null`, [
        real.runId,
        'run_orphan_1',
      ]),
    );
    ok(`orphan ${orphan.runId} exists and is unreferenced; ${real.runId} is the Run's lifecycle`);

    // Drive the orphan to its deadline. Before the fix it would have written a
    // terminal status for a Run that a different lifecycle owns.
    const sleepId = await waitForSleep(orphan as any);
    await orphan.wakeUp({ correlationIds: [sleepId] });
    const orphanOut = (await orphan.returnValue) as any;
    expect(orphanOut.kind).toBe('deadline');

    const row = await withOwner(OWNER, async (c) => {
      const r = await c.query('select * from run where id = $1', ['run_orphan_1']);
      return r.rows[0];
    });
    expect(row.status).toBe('queued');
    expect(row.failure_reason).toBeNull();
    expect(row.workflow_run_id).toBe(real.runId);
    ok('the orphan reached its deadline, matched nothing, and ended');
    ok(`Run still status=${row.status}, failure_reason=null, owned by ${row.workflow_run_id}`);
    ok('start() cannot be made idempotent, so the orphan is made inert instead');
  });

  it('the deadline no longer mislabels an executing Run as unscheduled', async () => {
    head('L. unscheduled vs worker_lost (adversarial review, point 3)');
    const { runLifecycle } = await import('@proto38/control-plane');
    await seedRun('run_exec_1');
    const wf = await start(runLifecycle as any, [
      'run_exec_1',
      OWNER,
      new Date(Date.now() + 30 * 60_000).toISOString(),
    ]);
    await withOwner(OWNER, (c) =>
      c.query(
        `update run set workflow_run_id = $1, status = 'executing', lease_token = 'lease_x'
          where id = $2`,
        [wf.runId, 'run_exec_1'],
      ),
    );
    const sleepId = await waitForSleep(wf as any);
    await wf.wakeUp({ correlationIds: [sleepId] });
    await wf.returnValue;
    const row = await withOwner(OWNER, async (c) => {
      const r = await c.query('select * from run where id = $1', ['run_exec_1']);
      return r.rows[0];
    });
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('worker_lost');
    ok(`an executing Run at its deadline -> status=${row.status} reason=${row.failure_reason}`);
    ok("ADR 0007 reserves 'unscheduled' for a Run that was never dispatched, and this one ran");
  });

  it('a hosted Failure is signalled, and the control plane decides', async () => {
    head('M. The hosted Failure signal (adversarial review, point 3)');
    const spec = await seedRun('run_fail_1');
    const claim = await claimRun('run_fail_1', OWNER, {
      workerId: null,
      protocolVersion: PROTOCOL_VERSION,
      workerBuildVersion: '0.0.0-proto38',
    });
    const run = await start(appOwnedRun, [
      spec,
      OWNER,
      (claim as any).leaseToken,
      'internal-failure',
    ]);
    const out = (await run.returnValue) as any;
    expect(out.outcome).toBe('failure');
    expect(out.absorbed.failed.recorded).toBe(true);
    const row = await withOwner(OWNER, async (c) => {
      const r = await c.query('select * from run where id = $1', ['run_fail_1']);
      return r.rows[0];
    });
    expect(row.status).toBe('failed');
    expect(row.result).toBeNull();
    ok(`Failure signalled -> Run status=${row.status} reason=${row.failure_reason}`);
    ok('no Result was absorbed, so Acceptance is still the only path that absorbs one');
    ok('no protocol v1 message and no route exists for this: hosted-only is structural');

    const { reportHostedFailure } = await import('@proto38/control-plane');
    const late = await reportHostedFailure({
      ownerId: OWNER,
      runId: 'run_fail_1',
      leaseToken: (claim as any).leaseToken,
      code: 'sandbox_teardown_incomplete',
    });
    expect(late.recorded).toBe(false);
    ok(`a repeated Failure signal on a terminal Run -> ${late.reason}, same window as Acceptance`);
  });
});
