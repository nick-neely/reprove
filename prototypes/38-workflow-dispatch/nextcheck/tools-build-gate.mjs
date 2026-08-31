// The real-builder workflow check.
//
// It protects OBSERVABLE EXECUTION, not the current artifact shape. The Workflow
// SDK documents workflow-mode transformation and dead-code elimination; it does
// not promise one shared bundle, nor its externalization behaviour. So this
// asserts properties that must hold for the app to run, and then actually runs
// it, rather than canonising what today's builder happens to emit.
//
// The failure it guards is invisible at build time: a module-scope helper called
// from a workflow body drags its transitive graph into the workflow bundle, which
// runs in a VM with no `require`. The build stays green and every workflow in the
// app breaks at runtime, with an error naming whichever one executed first.
//
// Usage: `npm run gate` (clean build, then this).
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const FLOW = 'app/.well-known/workflow/v1/flow/route.js';
const PORT = process.env.GATE_PORT ?? '3939';

let failures = 0;
const ok = (m) => console.log(`  [OK]   ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  [BAD]  ${m}`);
};

// ---------------------------------------------------------------------------
// 0. Build from clean. The generated workflow routes are stale-prone across
//    builds, and a stale artifact silently invalidates every check below.
// ---------------------------------------------------------------------------
console.log('\nReal-builder workflow gate\n');
for (const dir of ['.next', 'app/.well-known']) rmSync(dir, { recursive: true, force: true });
const build = spawnSync('npx', ['next', 'build'], { encoding: 'utf8', timeout: 600_000 });
if (build.status !== 0) {
  bad(`next build failed:\n${(build.stderr || build.stdout || '').slice(-2000)}`);
  process.exit(1);
}
ok('built from clean (.next and app/.well-known removed first)');

// ---------------------------------------------------------------------------
// 1. The artifact must exist. Absence is a failure, never "informational":
//    a check that passes when it cannot find what it inspects protects nothing.
// ---------------------------------------------------------------------------
if (!existsSync(FLOW)) {
  bad(`${FLOW} was not emitted; the gate cannot inspect what it must protect`);
  process.exit(1);
}
const flow = readFileSync(FLOW, 'utf8');
ok(`workflow bundle emitted (${Math.round(flow.length / 1024)}KB)`);

// ---------------------------------------------------------------------------
// 2. Structural: the workflow bundle must not require() anything external.
//    This is the property, not the artifact shape. No size threshold: size is a
//    brittle proxy once the structural and runtime checks exist.
// ---------------------------------------------------------------------------
const bare = [
  ...new Set([...flow.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((m) => m[1])),
].filter((r) => !r.startsWith('.'));
if (bare.length) bad(`workflow bundle require()s external modules: ${bare.slice(0, 10).join(', ')}`);
else ok('workflow bundle require()s no external module');

// ---------------------------------------------------------------------------
// 3. Trace: whatever the steps need must ship. A dynamically imported driver
//    that works locally and is dropped from the trace fails only on deploy.
// ---------------------------------------------------------------------------
const REQUIRED_IN_TRACE = ['node_modules/pg/'];
const traceRoot = '.next/server/app';
if (!existsSync(traceRoot)) {
  bad(`${traceRoot} missing; cannot verify the output trace`);
} else {
  const traces = readdirSync(traceRoot, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.nft.json'));
  if (traces.length === 0) {
    bad('no output traces emitted; cannot verify step dependencies ship');
  } else {
    const files = traces
      .flatMap((f) => {
        try {
          return JSON.parse(readFileSync(join(traceRoot, f), 'utf8')).files ?? [];
        } catch {
          return [];
        }
      })
      .join('\n');
    for (const need of REQUIRED_IN_TRACE) {
      if (files.includes(need)) ok(`output trace includes ${need} (${traces.length} traces)`);
      else bad(`output trace omits ${need}; it would be missing after deploy`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Runtime: start the built app and execute a real workflow. This is the only
//    check that observes what the gate actually cares about, and the only one
//    that survives a change in how the builder chunks its output.
// ---------------------------------------------------------------------------
const env = {
  ...process.env,
  PORT,
  WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
  WORKFLOW_POSTGRES_URL:
    process.env.WORKFLOW_POSTGRES_URL ?? 'postgres://world:world@localhost:55438/world',
  WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${PORT}`,
  PROTO38_REPROVE_URL:
    process.env.PROTO38_REPROVE_URL ?? 'postgres://world:world@localhost:55438/reprove',
  PROTO38_GITHUB_FIXTURE: process.env.PROTO38_GITHUB_FIXTURE ?? '/tmp/proto38-gate-fixture.json',
};
const server = spawn('npx', ['next', 'start', '-p', PORT], { env, stdio: 'pipe' });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      up = true;
    } catch {
      await sleep(500);
    }
  }
  if (!up) {
    bad('built app did not start; cannot execute a workflow');
  } else {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/matrix`, { method: 'POST' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.viaStatic?.instance) {
      bad(
        `executing a workflow failed (HTTP ${res.status}). ` +
          `Server said: ${serverLog.slice(-800)}`,
      );
    } else {
      ok('a representative workflow executed end to end in the built app');
    }
  }
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  server.kill('SIGKILL');
}

console.log(failures === 0 ? '\n  Gate passed.\n' : `\n  ${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
