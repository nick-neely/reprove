// The smoke gate a review asked for.
//
// The architecture depends on a bundling behaviour that fails at RUNTIME, in
// production, with an error naming an innocent workflow. A green build does not
// catch it, so this inspects the emitted workflow bundle and the output trace
// directly. Run it after `next build` (`npm run gate` does both).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FLOW = 'app/.well-known/workflow/v1/flow/route.js';
let failures = 0;
const ok = (m) => console.log(`  [OK]   ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  [BAD]  ${m}`);
};

console.log('\nWorkflow bundle gate\n');

if (!existsSync(FLOW)) {
  bad(`${FLOW} not found. Run \`next build\` first.`);
  process.exit(1);
}
const flow = readFileSync(FLOW, 'utf8');

// 1. Nothing CommonJS or Node-built-in may reach the workflow bundle: it runs
//    in a VM with no `require`.
const FORBIDDEN = [
  ['pg', /node_modules\/pg\/lib\/client\.js/],
  ['pg-pool', /node_modules\/pg-pool\//],
  ['node:crypto', /require\(["']node:crypto["']\)/],
  ['node:fs', /require\(["']node:fs["']\)/],
];
for (const [name, re] of FORBIDDEN) {
  if (re.test(flow)) bad(`${name} is inlined into the workflow bundle; it will throw at runtime`);
  else ok(`${name} is absent from the workflow bundle`);
}

// 2. Generically: a bare require() of any external module is the failure mode.
const requires = [...flow.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((m) => m[1]);
const bare = [...new Set(requires)].filter((r) => !r.startsWith('.'));
if (bare.length) bad(`workflow bundle calls require() for: ${bare.slice(0, 8).join(', ')}`);
else ok('the workflow bundle calls require() for no external module');

// 3. Size is a proxy for "something large leaked in". The regression this
//    catches took the bundle from ~40KB to 706KB.
const kb = Math.round(flow.length / 1024);
if (kb > 400) bad(`workflow bundle is ${kb}KB, which suggests an inlined dependency`);
else ok(`workflow bundle is ${kb}KB`);

// 4. The output trace must carry whatever the steps import dynamically, or the
//    escape works locally and fails on deploy.
const traceRoot = '.next/server/app';
if (existsSync(traceRoot)) {
  const traces = readdirSync(traceRoot, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.nft.json'));
  if (traces.length === 0) {
    ok('this build target emits no output traces (informational)');
  } else {
    const all = traces
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(traceRoot, f), 'utf8')).files ?? [];
        } catch {
          return [];
        }
      })
      .flat()
      .join('\n');
    if (/node_modules\/pg\//.test(all)) ok(`the output trace includes pg (${traces.length} traces)`);
    else bad('the output trace omits pg; a dynamically imported driver would fail on deploy');
  }
} else {
  ok('no .next/server/app trace directory (informational)');
}

console.log(failures === 0 ? '\n  Gate passed.\n' : `\n  ${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
