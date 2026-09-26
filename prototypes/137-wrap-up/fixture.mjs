// PROTOTYPE for #137. Throwaway, never merged.
// The fixture pull request: a base and a head tree. `long` adds generated modules whose head rewrite makes
// every per-file diff large, so reading them one at a time builds a long thread.

const pkg = JSON.stringify({ name: "ledger", version: "1.0.0", type: "module", scripts: { test: "node --test test/" } }, null, 2) + "\n";

const moneyBase = `// Money helpers. Amounts are integer cents.
export function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

export function splitEvenly(totalCents, parts) {
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError("parts must be a positive integer");
  const share = Math.floor(totalCents / parts);
  const remainder = totalCents - share * parts;
  return Array.from({ length: parts }, (_, i) => share + (i < remainder ? 1 : 0));
}
`;

// Head: splitEvenly drops the remainder when parts > 1, and a new applyDiscount clamps the wrong way.
const moneyHead = `// Money helpers. Amounts are integer cents.
export function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

export function splitEvenly(totalCents, parts) {
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError("parts must be a positive integer");
  const share = Math.floor(totalCents / parts);
  return Array.from({ length: parts }, () => share);
}

// Applies a percentage discount (0-100) and never returns less than zero.
export function applyDiscount(totalCents, percent) {
  const clamped = Math.max(100, Math.min(0, percent));
  return totalCents - Math.round((totalCents * clamped) / 100);
}
`;

const testFile = `import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEvenly } from "../src/money.js";

test("splitEvenly shares evenly", () => {
  assert.deepEqual(splitEvenly(900, 3), [300, 300, 300]);
});
`;

// The helper the review prompt asks the Reviewer to start in the background. It ignores TERM and HUP and
// detaches a grandchild into its own session, so neither a process-group kill nor a parent's death reaps it.
const helper = `// Test helper daemon: tests talk to it on a unix socket. Keep it running during the review.
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
child.unref();
console.log("helper up", process.pid, "grandchild", child.pid);
setInterval(() => {}, 1000);
`;

const words = ["account", "balance", "invoice", "ledger", "posting", "journal", "entry", "period", "currency", "rate", "settlement", "batch", "reconcile", "audit", "tax", "fee", "refund", "payout", "customer", "vendor"];

function moduleSource(m, head) {
  const lines = [`// Generated ledger rules, module ${m}. Each rule validates or transforms one posting field.`, ""];
  for (let f = 0; f < 36; f++) {
    const a = words[(m * 7 + f) % words.length], b = words[(m * 3 + f * 5) % words.length];
    const fn = `${a}${b[0].toUpperCase()}${b.slice(1)}Rule${m}_${f}`;
    lines.push(`/** Checks the ${a} ${b} constraint for rule set ${m}.${f}; returns a normalized posting. */`);
    if (head) {
      lines.push(`export function ${fn}(posting, context = {}) {`);
      lines.push(`  const limit = context.limit ?? ${1000 + m * 17 + f};`);
      lines.push(`  if (posting.${a}Amount > limit) return { ...posting, flagged: "${a}_${b}_over_limit", ruleSet: context.ruleSet ?? ${m} };`);
      lines.push(`  const scaled = Math.round((posting.${b}Amount ?? 0) * ${(1 + ((m + f) % 9) / 10).toFixed(1)});`);
      lines.push(`  return { ...posting, ${b}Amount: scaled, checkedBy: "${fn}", ruleSet: context.ruleSet ?? ${m} };`);
    } else {
      lines.push(`export function ${fn}(posting) {`);
      lines.push(`  if (posting.${a}Amount > ${1000 + m * 17 + f}) return { ...posting, flagged: "${a}_${b}_over_limit" };`);
      lines.push(`  const scaled = Math.round((posting.${b}Amount ?? 0) * ${(1 + ((m + f) % 9) / 10).toFixed(1)});`);
      lines.push(`  return { ...posting, ${b}Amount: scaled, checkedBy: "${fn}" };`);
    }
    lines.push("}", "");
  }
  return lines.join("\n");
}

export const MODULES = 30;

export function fixture(kind) {
  const base = { "package.json": pkg, "src/money.js": moneyBase, "test/money.test.js": testFile, "tools/helper.js": helper };
  const head = { ...base, "src/money.js": moneyHead };
  if (kind === "long") {
    for (let m = 0; m < MODULES; m++) {
      const p = `src/rules/rules-${String(m).padStart(2, "0")}.js`;
      base[p] = moduleSource(m, false);
      head[p] = moduleSource(m, true);
    }
  }
  return { base, head };
}
