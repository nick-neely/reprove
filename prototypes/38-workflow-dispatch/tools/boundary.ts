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

type Rule = {
  dir: string;
  name: string;
  /** Must not appear in package.json, nor in any import statement. */
  mayNotReach: string[];
  /**
   * Must not appear anywhere in the resolved dependency closure. This is the
   * stronger property, and the only one that matches ADR 0010's own test:
   * "verify with `pnpm why` instead of having to believe it".
   */
  mayNotResolve?: string[];
};

const MATRIX: Rule[] = [
  { dir: 'packages/protocol', name: '@proto38/protocol', mayNotReach: ['@proto38/', 'ai-sdk-harness-stub', 'workflow', 'pg'] },
  { dir: 'packages/worker-core', name: '@proto38/worker-core', mayNotReach: ['@proto38/control-plane', 'workflow', 'pg'] },
  { dir: 'packages/worker-hosted', name: '@proto38/worker-hosted', mayNotReach: ['@proto38/control-plane', 'pg'] },
  // The headline property: a control plane that dispatches only to self-hosted
  // Workers installs no harness code at all.
  {
    dir: 'packages/control-plane',
    name: '@proto38/control-plane',
    mayNotReach: ['@proto38/worker-core', '@proto38/worker-hosted', 'ai-sdk-harness-stub'],
    mayNotResolve: ['@proto38/worker-core', '@proto38/worker-hosted', 'ai-sdk-harness-stub'],
  },
  { dir: 'apps/control-plane', name: '@proto38/app-control-plane', mayNotReach: ['pg', 'ai-sdk-harness-stub'] },
  // The app-owned composition is permitted to depend on BOTH packages. That is
  // what makes a static-import step legal, and why the HTTP shape is not forced.
  // A hosted-capable app legitimately resolves harness code; what it may not do
  // is reach past worker-hosted to worker-core or @ai-sdk/* directly.
  { dir: 'apps/control-plane-appowned', name: '@proto38/app-appowned', mayNotReach: ['pg', '@proto38/worker-core', 'ai-sdk-harness-stub'] },
  // The self-hosted deployment: a separate package that must not reach harness
  // code at all, in declared dependencies OR in the resolved closure.
  {
    dir: 'apps/control-plane-selfhosted',
    name: '@proto38/app-selfhosted',
    mayNotReach: ['pg', '@proto38/worker-hosted', '@proto38/worker-core', 'ai-sdk-harness-stub'],
    mayNotResolve: ['@proto38/worker-hosted', '@proto38/worker-core', 'ai-sdk-harness-stub'],
  },
];

/**
 * ADR 0010's headline claim is about what an operator can verify with `pnpm why`,
 * so it is about the resolved dependency *closure*, not just direct declarations.
 * Walking it is what the first version of this check was missing.
 */
function closure(pkgName: string, seen = new Set<string>()): Set<string> {
  if (seen.has(pkgName)) return seen;
  seen.add(pkgName);
  const dir = MATRIX.find((r) => r.name === pkgName)?.dir ?? LOCAL.get(pkgName);
  if (!dir) return seen;
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) closure(dep, seen);
  return seen;
}

const LOCAL = new Map<string, string>([
  ['@proto38/protocol', 'packages/protocol'],
  ['@proto38/worker-core', 'packages/worker-core'],
  ['@proto38/worker-hosted', 'packages/worker-hosted'],
  ['@proto38/control-plane', 'packages/control-plane'],
  ['@proto38/app-appowned', 'apps/control-plane-appowned'],
  ['ai-sdk-harness-stub', 'stubs/ai-sdk-harness'],
]);

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
  // The closure check: not "does it declare it" but "does installing it pull it in".
  const reachable = closure(rule.name);
  reachable.delete(rule.name);
  for (const forbidden of rule.mayNotResolve ?? []) {
    if (reachable.has(forbidden)) {
      violations++;
      ruleViolations++;
      lines.push(
        `  [BAD]  ${rule.name} resolves ${forbidden} transitively (closure: ${[...reachable].join(', ')})`,
      );
    }
  }

  if (ruleViolations === 0) {
    lines.push(`  [OK]   ${rule.name} imports none of: ${rule.mayNotReach.join(', ')}`);
    if (rule.mayNotResolve)
      lines.push(
        `  [OK]   ${rule.name} RESOLVES none of: ${rule.mayNotResolve.join(', ')}` +
          `\n         closure: ${[...reachable].sort().join(', ') || '(none)'}`,
      );
  }
}

console.log('\nADR 0010 dependency matrix\n');
console.log(lines.join('\n'));
console.log(
  violations === 0
    ? '\n  All boundaries hold.\n'
    : `\n  ${violations} violation(s).\n`,
);
process.exit(violations === 0 ? 0 : 1);
