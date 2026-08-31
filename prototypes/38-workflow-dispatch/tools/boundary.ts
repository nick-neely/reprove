// ADR 0010's dependency matrix, asserted the way the ADR says it should be:
// "a small explicit script asserting the table above, kept deliberately tiny."
//
// It checks two different things, because either alone is insufficient:
//   1. declared dependencies in package.json
//   2. the actual import graph, because a package can import what it never
//      declared, and a type-only import still couples the build
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

type Rule = { dir: string; name: string; mayNotReach: string[] };

const MATRIX: Rule[] = [
  { dir: 'packages/protocol', name: '@proto38/protocol', mayNotReach: ['@proto38/', 'ai-sdk-harness-stub', 'workflow', 'pg'] },
  { dir: 'packages/worker-core', name: '@proto38/worker-core', mayNotReach: ['@proto38/control-plane', 'workflow', 'pg'] },
  { dir: 'packages/worker-hosted', name: '@proto38/worker-hosted', mayNotReach: ['@proto38/control-plane', 'pg'] },
  // The headline property: a control plane that dispatches only to self-hosted
  // Workers installs no harness code at all.
  { dir: 'packages/control-plane', name: '@proto38/control-plane', mayNotReach: ['@proto38/worker-core', '@proto38/worker-hosted', 'ai-sdk-harness-stub'] },
  { dir: 'apps/control-plane', name: '@proto38/app-control-plane', mayNotReach: ['pg', 'ai-sdk-harness-stub'] },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (e === 'node_modules') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT_RE)) out.push(m[1]);
  return out;
}

let violations = 0;
const lines: string[] = [];

for (const rule of MATRIX) {
  let ruleViolations = 0;
  const abs = join(ROOT, rule.dir);
  const pkg = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

  for (const forbidden of rule.mayNotReach) {
    const bad = declared.filter((d) => d === forbidden || d.startsWith(forbidden));
    if (bad.length) {
      violations++;
      ruleViolations++;
      lines.push(`  [BAD]  ${rule.name} declares ${bad.join(', ')} (forbidden: ${forbidden})`);
    }
  }

  for (const file of sources(abs)) {
    for (const spec of imports(file)) {
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      for (const forbidden of rule.mayNotReach) {
        if (spec === forbidden || spec.startsWith(forbidden)) {
          violations++;
          ruleViolations++;
          lines.push(
            `  [BAD]  ${rule.name} imports ${spec} in ${file.slice(ROOT.length + 1)} (forbidden: ${forbidden})`,
          );
        }
      }
    }
  }
  if (ruleViolations === 0)
    lines.push(`  [OK]   ${rule.name} reaches none of: ${rule.mayNotReach.join(', ')}`);
}

console.log('\nADR 0010 dependency matrix\n');
console.log(lines.join('\n'));
console.log(
  violations === 0
    ? '\n  All boundaries hold.\n'
    : `\n  ${violations} violation(s).\n`,
);
process.exit(violations === 0 ? 0 : 1);
