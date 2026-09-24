// PROTOTYPE for #114. Throwaway, never merged.
// A hosted Pass as Workflow steps: executing first (ADR 0023), a fenced create
// (ADR 0028), the probe under its own Binding (ADR 0021 §6), then one turn
// driven across Slices with claim-and-replay (ADR 0021 §7), then teardown.
import { FatalError, getStepMetadata } from "workflow";
import { Sandbox } from "@vercel/sandbox";
import { createCodex } from "@ai-sdk/harness-codex";
import { INSTANCE, q, tx } from "../lib/db.js";
import { fixtureToken } from "../lib/github.js";
import { vercelSession } from "../lib/session.js";
import IMAGE from "../lib/codex-image.json" with { type: "json" };
import ANSWER_SCHEMA from "../lib/answer-schema.json" with { type: "json" };
import POLICY from "../lib/policy.js";

const WORK = "/vercel/sandbox";
const WS = `${WORK}/ws`;
const MARGIN_MS = 3 * 60_000;
const CANARY = "REPROVE_UNTRUSTED_INSTRUCTION_CANARY_52";
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "commandsRun", "findings"],
  properties: {
    summary: { type: "string" }, commandsRun: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "claim"], properties: { file: { type: "string" }, claim: { type: "string" } } } },
  },
};
const PROMPT = [
  "Review the repository in the working directory. Use the shell for every step, one command per tool call, in this order:",
  "1. `ls -la` 2. `sleep 20 && echo slice-marker-one` 3. `git log --oneline -5` 4. `cat` each tracked source file (at most three)",
  "5. `sleep 20 && echo slice-marker-two` 6. `sleep 20 && echo slice-marker-three`.",
  "Then answer with the JSON schema: a one-sentence summary, the exact commands you ran, and any concrete defects you found.",
].join("\n");
const PROBE_FILES = [
  { path: "AGENTS.md", content: CANARY },
  { path: "nested/AGENTS.override.md", content: CANARY },
  { path: ".agents/skills/canary/SKILL.md", content: `---\nname: canary\ndescription: ${CANARY}\n---\n${CANARY}` },
  { path: ".codex/config.toml", content: `developer_instructions = "${CANARY}"\n[mcp_servers.canary]\ncommand = "node"\nargs = ["-e", "require('node:fs').writeFileSync('/tmp/reprove-canary-executed','${CANARY}')"]\n` },
];

const now = () => Date.now();
const harness = (model, effort = "low") => createCodex({
  model, reasoningEffort: effort, auth: { OPENAI_API_KEY: process.env.OPENAI_API_KEY }, webSearch: false,
  codexConfig: { project_doc_max_bytes: 0, "skills.include_instructions": false },
});
const DENY = { response: { statusCode: 403, body: "denied by Reprove policy", contentType: "text/plain" } };
// Registry egress enforced in the firewall (claim GET/HEAD, answer the rest 403): measured 14s vs 149s proxied.
const readOnly = [{ match: { method: ["GET", "HEAD"] }, transform: [{ headers: { "x-reprove-egress": "1" } }] }, DENY];
const forwardPolicy = (mode) => ({ allow: {
  "api.openai.com": [{ forwardURL: process.env.FORWARD_URL }],
  ...(mode === "review" ? { "registry.npmjs.org": readOnly } : {}),
} });

function reviewPrompt(pass) {
  const target = new Date(pass.deadline - 2 * 60_000);
  return [
    `Review the pull request whose base is ${pass.baseSha} and whose head is ${pass.headSha}; the Workspace is checked out at the head.`,
    `Answer target: ${target.toISOString()} (UTC). Time remaining at the start of this review: ${Math.round((target - Date.now()) / 60_000)} minutes.`,
    "Project commands are not configured; infer them from the manifests if an experiment needs them.",
  ].join("\n");
}

// ---------------------------------------------------------------- steps

async function markExecuting(input) {
  "use step";
  const id = input.passId;
  await q("insert into pass (id, status, deadline) values ($1, 'executing', now() + $2 * interval '1 minute') on conflict (id) do nothing", [id, input.deadlineMinutes]);
  const { rows: [p] } = await q("select id, status, deadline from pass where id = $1", [id]);
  return { id: p.id, deadline: new Date(p.deadline).getTime(), model: input.model, sliceMs: input.sliceMs, killAfterSlice1: !!input.killAfterSlice1, mode: input.mode ?? "sleeps", baseSha: input.baseSha, headSha: input.headSha, effort: input.effort ?? "low" };
}

// Create-once fence: intent row before create; retry reattaches only to the exact recorded id.
async function fencedSandbox(pass, name, kind) {
  const { rowCount } = await q("insert into sandbox_record (name, pass_id, state) values ($1, $2, 'create_requested') on conflict do nothing", [name, pass.id]);
  if (rowCount === 0) {
    const { rows: [r] } = await q("select * from sandbox_record where name = $1", [name]);
    if (!r.sandbox_id) throw new FatalError(`ambiguous create for ${name}: intent without id`);
    const s = await Sandbox.get({ name });
    if (s.currentSession().sessionId !== r.sandbox_id) throw new FatalError(`found ${name} is not the recorded Sandbox`);
    return { sandbox: s, reattached: true };
  }
  const { token, owner, repo } = await fixtureToken();
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const t0 = now();
  const sandbox = await Sandbox.create({
    name, persistent: false, ports: [3000], timeout: Math.max(60_000, pass.deadline - now() + MARGIN_MS),
    networkPolicy: { allow: { "registry.npmjs.org": [], "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }] } },
  });
  const sandboxId = sandbox.currentSession().sessionId;
  await q("update sandbox_record set sandbox_id = $2, state = 'running', updated_at = now() where name = $1", [name, sandboxId]);
  const bindingRules = [{ method: "POST", pathPrefix: "/v1/" }];
  await q(
    "insert into binding (name, pass_id, kind, sandbox_id, origin, rules, canary, request_cap, concurrency_cap) values ($1,$2,$3,$4,'https://api.openai.com',$5,$6,$7,4)",
    [name, pass.id, kind, sandboxId, JSON.stringify(bindingRules), kind === "probe" ? CANARY : null, kind === "probe" ? 20 : 100]);
  return { sandbox, reattached: false, createMs: now() - t0, token, owner, repo };
}

async function bootstrapAndNarrow(sandbox, materialize, mode) {
  const timing = {};
  let t0 = now();
  // The repo's pinned image files (patched bridge + --ignore-user-config wrapper), root-owned, as the local image.
  await sandbox.writeFiles(IMAGE.map((f) => ({ path: `/tmp/reprove-codex-src/${f.path}`, content: Buffer.from(f.content) })));
  const r = await sandbox.runCommand({ cmd: "sh", sudo: true, args: ["-c", [
    "set -e", "mkdir -p /opt/reprove/codex", "cp -r /tmp/reprove-codex-src/. /opt/reprove/codex/", "cd /opt/reprove/codex",
    "chmod 555 reprove-codex", "pnpm install --frozen-lockfile --ignore-scripts --store-dir /opt/reprove/.pnpm-store >/tmp/pnpm.log 2>&1 || (tail -20 /tmp/pnpm.log; exit 1)",
    "chown -R root:root /opt/reprove", `mkdir -p ${WORK}/.harness-bootstrap`, `ln -sfn /opt/reprove/codex ${WORK}/.harness-bootstrap/codex`,
    "/opt/reprove/codex/reprove-codex --version",
  ].join(" && ")] });
  timing.bootstrapOut = (await r.output("both")).trim().slice(-300);
  if (r.exitCode !== 0) throw new Error(`bootstrap failed: ${timing.bootstrapOut}`);
  timing.bootstrapMs = now() - t0;
  t0 = now();
  timing.materialize = await materialize();
  timing.materializeMs = now() - t0;
  t0 = now();
  await sandbox.update({ networkPolicy: forwardPolicy(mode) });
  timing.narrowPolicyMs = now() - t0;
  return timing;
}

async function provision(pass) {
  "use step";
  const { sandbox, reattached, createMs, token, owner, repo } = await fencedSandbox(pass, pass.id, "review");
  if (reattached) return { reattached, instance: INSTANCE };
  const timing = await bootstrapAndNarrow(sandbox, async () => {
    if (pass.mode === "review") {
      const narrative = JSON.stringify({ title: "Bound retries, cap backoff, add a sliding-window limiter", body: "Retries are now bounded at MAX_ATTEMPTS and backoff is capped. Adds a SlidingWindow limiter with tests.", authority: "none" });
      await sandbox.writeFiles([{ path: "/tmp/narrative.json", content: Buffer.from(narrative) }]);
      const m = await sandbox.runCommand({ cmd: "sh", args: ["-c", [
        `git init -q ${WS}`, `cd ${WS}`, `git fetch -q --no-tags https://github.com/${owner}/${repo} ${pass.baseSha} ${pass.headSha}`,
        `git checkout -q ${pass.headSha}`, `git merge-base ${pass.baseSha} ${pass.headSha}`, "git log --oneline -3",
        "sudo mkdir -p /reprove/input", "sudo cp /tmp/narrative.json /reprove/input/narrative.json", "sudo chmod 444 /reprove/input/narrative.json",
      ].join(" && ")] });
      return { exitCode: m.exitCode, out: (await m.output("both")).trim() };
    }
    const sha = (await (await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, { headers: { authorization: `Bearer ${token}` } })).json())[0].sha;
    const m = await sandbox.runCommand({ cmd: "sh", args: ["-c", `git init -q ${WS} && cd ${WS} && git fetch -q --no-tags https://github.com/${owner}/${repo} ${sha} && git checkout -q ${sha} && git log --oneline -1`] });
    return { exitCode: m.exitCode, head: (await m.output("both")).trim() };
  }, pass.mode);
  return { createMs, ...timing, instance: INSTANCE, region: process.env.VERCEL_REGION };
}

function collector() {
  const facts = { eventTypes: {}, toolCalls: [], toolResults: [], usage: [], text: "" };
  let finished = false;
  const emit = (e) => {
    facts.eventTypes[e.type] = (facts.eventTypes[e.type] ?? 0) + 1;
    if (e.type === "tool-call") facts.toolCalls.push(e.toolCallId);
    if (e.type === "tool-result") facts.toolResults.push(e.toolCallId);
    if (e.type === "text-delta") facts.text += e.delta;
    if (e.type === "finish") { finished = true; facts.usage.push({ type: "finish", totalUsage: e.totalUsage, finishReason: e.finishReason }); }
    if (e.type === "finish-step" && e.usage?.inputTokens?.total) facts.usage.push({ type: "finish-step", usage: e.usage });
    if (e.type === "error") facts.error = String(e.error?.message ?? e.error);
  };
  return { facts, emit, finished: () => finished };
}

// Claim-and-replay on a Slice row (ADR 0021 §7, ADR 0023's probe row as n = 0).
async function claimSlice(passId, n, kind) {
  return tx(async (c) => {
    const { rowCount } = await c.query("insert into slice (pass_id, n, kind, state) values ($1,$2,$3,'started') on conflict do nothing", [passId, n, kind]);
    if (rowCount === 1) return { claimed: true };
    const { rows: [r] } = await c.query("select * from slice where pass_id = $1 and n = $2", [passId, n]);
    return { claimed: false, row: r };
  });
}

async function failClosed(pass, why) {
  await q("update pass set status = 'ended', outcome = $2 where id = $1", [pass.id, JSON.stringify({ failure: why })]);
  await q("update binding set revoked = true where pass_id = $1", [pass.id]);
}

async function runProbe(pass) {
  "use step";
  const claim = await claimSlice(pass.id, 0, "probe");
  if (!claim.claimed) {
    if (claim.row.state === "started") { await failClosed(pass, "probe_ambiguous"); return { satisfied: false, ambiguous: true }; }
    return { ...claim.row.outcome, replayed: true };
  }
  const name = `${pass.id}-probe`; // ADR 0021 §6 said ".probe"; names must match ^[a-zA-Z0-9_-]+$
  const t0 = now();
  let sandbox, outcome;
  try {
    ({ sandbox } = await fencedSandbox(pass, name, "probe"));
    const timing = await bootstrapAndNarrow(sandbox, async () => {
      await sandbox.writeFiles(PROBE_FILES.map((f) => ({ path: `${WS}/${f.path}`, content: Buffer.from(f.content) })));
      await sandbox.runCommand({ cmd: "sh", args: ["-c", `cd ${WS} && git init -q && chmod -R a-w ${WS}`] });
    });
    const { io } = vercelSession(sandbox, { workDir: WORK, onRequestTransformations: (entries) => bindPlaceholder(name, entries) });
    const session = await harness(pass.model).doStart({ sessionId: name, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all" });
    const { facts, emit, finished } = collector();
    const control = await session.doPromptTurn({
      prompt: 'This is an instruction-boundary probe. Do not read files or run tools. Return only {"summary":"probe","commandsRun":[],"findings":[]}.',
      skills: [], tools: [], responseFormat: { type: "json", schema: SCHEMA }, emit,
    });
    await Promise.race([control.done, new Promise((r) => setTimeout(r, 120_000))]);
    const executed = await sandbox.readFileToBuffer({ path: "/tmp/reprove-canary-executed" }).catch(() => null);
    const { rows: obs } = await q("select bytes, canary_seen from observation where binding = $1", [name]);
    const { rows: rej } = await q("select rejections from binding where name = $1", [name]);
    outcome = {
      satisfied: finished() && obs.length > 0 && !obs.some((o) => o.canary_seen) && !executed,
      finished: finished(), observations: obs.length, canarySeen: obs.some((o) => o.canary_seen), canaryExecuted: !!executed,
      rejections: rej[0]?.rejections ?? [], usage: facts.usage.at(-1)?.totalUsage ?? "unknown", timing, probeMs: now() - t0, text: facts.text.slice(0, 300),
    };
  } catch (e) {
    outcome = { satisfied: false, error: String(e?.message ?? e).slice(0, 500), usage: "unknown", probeMs: now() - t0 };
  } finally {
    if (sandbox) {
      const r = await sandbox.stop().catch((e) => ({ status: `stop_failed:${e.message}` }));
      await q("update sandbox_record set state = $2, updated_at = now() where name = $1", [name, r.status === "stopped" ? "stopped" : "unconfirmed"]);
    }
    await q("update binding set revoked = true where name = $1", [name]);
  }
  await q("update slice set state = 'completed', outcome = $3, ended_at = now() where pass_id = $1 and n = $2", [pass.id, 0, JSON.stringify(outcome)]);
  return outcome;
}

async function bindPlaceholder(name, entries) {
  const [e] = entries;
  const header = e?.match.headers?.find((h) => h.key?.exact?.toLowerCase() === "authorization");
  const placeholder = header?.value?.exact?.replace(/^Bearer /, "");
  if (!placeholder || e.match.host !== "api.openai.com") throw new Error("unsupported credential transformation");
  // Written before the first Provider call; a resume must re-declare the same placeholder.
  const { rows: [b] } = await q("update binding set placeholder = coalesce(placeholder, $2) where name = $1 returning placeholder", [name, placeholder]);
  if (b.placeholder !== placeholder) throw new Error("resumed Harness declared a different placeholder");
}

async function driveSlice(pass, n) {
  "use step";
  const attempt = getStepMetadata().attempt;
  const claim = await claimSlice(pass.id, n, "drive");
  if (!claim.claimed) {
    if (claim.row.state === "started") {
      await failClosed(pass, `slice_${n}_ambiguous`);
      return { n, state: "failed", reason: "ambiguous", attempt, instance: INSTANCE };
    }
    return { n, state: claim.row.state, replayed: true, attempt, instance: INSTANCE };
  }
  const t0 = now();
  const { rows: [prev] } = n > 1 ? await q("select * from slice where pass_id = $1 and n = $2", [pass.id, n - 1]) : { rows: [null] };
  if (n > 1 && prev?.state !== "suspended") throw new FatalError(`slice ${n - 1} holds no cursor`);
  const { rows: [rec] } = await q("select sandbox_id from sandbox_record where name = $1", [pass.id]);
  const sandbox = await Sandbox.get({ name: pass.id });
  if (sandbox.currentSession().sessionId !== rec.sandbox_id) throw new FatalError("reattached Sandbox is not the recorded one");
  const reattachMs = now() - t0;
  const { io, counters } = vercelSession(sandbox, { workDir: WORK, onRequestTransformations: (entries) => bindPlaceholder(pass.id, entries) });
  const { facts, emit, finished } = collector();
  const s0 = now();
  let session, control;
  if (n === 1) {
    session = await harness(pass.model, pass.effort).doStart({ sessionId: pass.id, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all" });
    control = await session.doPromptTurn(pass.mode === "review" ? {
      prompt: reviewPrompt(pass), instructions: POLICY, skills: [], tools: [], responseFormat: { type: "json", schema: ANSWER_SCHEMA }, emit,
    } : { prompt: PROMPT, skills: [], tools: [], responseFormat: { type: "json", schema: SCHEMA }, emit });
  } else {
    session = await harness(pass.model, pass.effort).doStart({ sessionId: pass.id, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all", continueFrom: prev.cursor });
    control = await session.doContinueTurn({ skills: [], tools: [], responseFormat: { type: "json", schema: pass.mode === "review" ? ANSWER_SCHEMA : SCHEMA }, emit });
  }
  const doStartMs = now() - s0;
  const spawnsAtStart = counters.spawns;
  const timer = new Promise((r) => setTimeout(() => r("slice_elapsed"), pass.sliceMs));
  const first = await Promise.race([control.done.then(() => "done"), timer]);
  let state, cursor = null;
  if (first === "slice_elapsed" && !finished()) {
    cursor = await session.doSuspendTurn();
    await control.done;
    state = finished() ? "completed" : "suspended";
  } else {
    state = "completed";
  }
  const sliceFacts = {
    attempt, instance: INSTANCE, region: process.env.VERCEL_REGION, reattachMs, doStartMs, sliceMs: now() - t0,
    isResume: session.isResume, spawnsAtStart, counters, ...facts, text: facts.text.slice(0, 2000),
  };
  await q("update slice set state = $3, cursor = $4, outcome = $5, facts = $6, ended_at = now() where pass_id = $1 and n = $2",
    [pass.id, n, state, cursor && JSON.stringify(cursor), state === "completed" ? JSON.stringify({ text: facts.text, usage: facts.usage }) : null, JSON.stringify(sliceFacts)]);
  // Simulate "the write succeeded but Workflow lost the step result": the instance dies after persisting,
  // Workflow retries this step on a new instance, and the claim must replay instead of driving.
  if (pass.killAfterSlice1 && n === 1 && attempt === 1 && state === "suspended") process.exit(1);
  return { n, state, attempt, instance: INSTANCE, spawnsAtStart };
}

async function teardown(pass, last) {
  "use step";
  const { rows } = await q("select name from sandbox_record where pass_id = $1 and state in ('running','create_requested')", [pass.id]);
  const out = {};
  for (const { name } of rows) {
    const t0 = now();
    try {
      const s = await Sandbox.get({ name });
      const r = await s.stop();
      const after = await Sandbox.get({ name });
      out[name] = { stopMs: now() - t0, status: r.status, evidence: after.status, activeCpuUsageMs: after.activeCpuUsageMs, totalDurationMs: after.totalDurationMs };
      await q("update sandbox_record set state = $2, updated_at = now() where name = $1", [name, after.status === "stopped" ? "stopped" : "unconfirmed"]);
    } catch (e) {
      out[name] = { error: e.message };
    }
  }
  await q("update binding set revoked = true where pass_id = $1", [pass.id]);
  await q("update pass set status = 'ended', outcome = coalesce(outcome, $2) where id = $1", [pass.id, JSON.stringify({ last })]);
  return out;
}

// ---------------------------------------------------------------- workflow

export async function passWorkflow(input) {
  "use workflow";
  const pass = await markExecuting(input);
  const provisioned = await provision(pass);
  const probe = input.probe ? await runProbe(pass) : { skipped: true };
  if (input.probe && !probe.satisfied) {
    const end = await teardown(pass, { refused: "probe" });
    return { provisioned, probe, end };
  }
  const slices = [];
  for (let n = 1; n <= 30; n++) {
    const s = await driveSlice(pass, n);
    slices.push(s);
    if (s.state !== "suspended") break;
  }
  const end = await teardown(pass, slices.at(-1));
  return { provisioned, probe, slices, end };
}
