// PROTOTYPE for #114. Throwaway, never merged.
// B0 scaffold: same-turn resumption across two local processes against a real
// Vercel Sandbox and a real Codex turn. The Provider credential is a firewall
// transform here (scaffolding only; ADR 0021 §4 forwards to a proxy instead).
//
//   node b0.mjs start [model]      create, bootstrap, materialize, start a turn, suspend, exit
//   node b0.mjs continue <name>    reattach by name in a new process, continue the same turn
//   node b0.mjs stop <name>
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { createCodex } from "@ai-sdk/harness-codex";
import { fixtureToken, ledger, log, vercelCredentials } from "./lib.mjs";
import { vercelSession } from "./vercel-session.mjs";

const creds = vercelCredentials();
const WORK = "/vercel/sandbox";
const WS = `${WORK}/ws`;
const out = (name, suffix) => new URL(`./out/b0-${name}.${suffix}`, import.meta.url);
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "commandsRun", "findings"],
  properties: {
    summary: { type: "string" },
    commandsRun: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "claim"], properties: { file: { type: "string" }, claim: { type: "string" } } } },
  },
};
const PROMPT = [
  "Review the repository in the working directory. Use the shell for every step, one command per tool call, in this order:",
  "1. `ls -la` 2. `sleep 20 && echo slice-marker-one` 3. `git log --oneline -5` 4. `cat` each tracked source file (at most three)",
  "5. `sleep 20 && echo slice-marker-two` 6. `sleep 20 && echo slice-marker-three`.",
  "Then answer with the JSON schema: a one-sentence summary, the exact commands you ran, and any concrete defects you found.",
].join("\n");

const t = () => performance.now();
const since = (t0) => Math.round(t() - t0);

function harness(model) {
  return createCodex({
    model,
    reasoningEffort: "low",
    auth: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    webSearch: false,
    codexConfig: { project_doc_max_bytes: 0, "skills.include_instructions": false },
  });
}

function recorder(name, slice) {
  const events = [];
  const emit = (event) => {
    const e = { slice, at: Date.now(), type: event.type };
    for (const k of ["id", "toolCallId", "toolName", "providerExecuted", "finishReason", "usage", "totalUsage", "delta"]) if (event[k] !== undefined) e[k] = event[k];
    events.push(e);
    appendFileSync(out(name, "events.jsonl"), `${JSON.stringify(e)}\n`);
    if (event.type !== "text-delta" && event.type !== "reasoning-delta") process.stdout.write(`  [slice ${slice}] ${event.type}${event.toolCallId ? ` ${event.toolCallId}` : ""}${event.toolName ? ` ${event.toolName}` : ""}\n`);
  };
  return { events, emit };
}

async function start(model = "gpt-6-luna") {
  const name = `p114-b0-${Date.now().toString(36)}`;
  const timing = {};
  const { token, owner, repo } = await fixtureToken();
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  let t0 = t();
  const sandbox = await Sandbox.create({
    ...creds, name, persistent: false, ports: [3000], timeout: 20 * 60_000,
    networkPolicy: { allow: { "registry.npmjs.org": [], "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }] } },
  });
  timing.createMs = since(t0);
  ledger({ kind: "sandbox", name, phase: "b0" });
  log("created", { name, sessionId: sandbox.currentSession().sessionId, domain: sandbox.domain(3000) });

  // Bootstrap the pinned bridge, as the local image build does, then materialize the fixture.
  t0 = t();
  const recipe = await createCodex().getBootstrap();
  await sandbox.writeFiles(recipe.files.map((f) => ({ path: `${WORK}/${f.path}`, content: Buffer.from(f.content) })));
  for (const c of recipe.commands) {
    const r = await sandbox.runCommand({ cmd: "sh", args: ["-c", c.command], cwd: `${WORK}/${recipe.bootstrapDir}` });
    log(`bootstrap: ${c.command}`, { exitCode: r.exitCode, tail: (await r.output("both")).slice(-400) });
  }
  timing.bootstrapMs = since(t0);
  t0 = t();
  const sha = (await (await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, { headers: { authorization: `Bearer ${token}` } })).json())[0].sha;
  const m = await sandbox.runCommand({ cmd: "sh", args: ["-c", `git init -q ${WS} && cd ${WS} && git fetch -q --no-tags https://github.com/${owner}/${repo} ${sha} && git checkout -q ${sha} && git log --oneline -1 && ls`] });
  log("materialized", { exitCode: m.exitCode, out: await m.output("both") });
  timing.materializeMs = since(t0);

  // The Harness declares its credential; install only that transform, which also drops npm and GitHub.
  const { io, counters } = vercelSession(sandbox, {
    workDir: WORK,
    trace: (k, v) => process.stdout.write(`  io.${k} ${typeof v === "string" ? v : JSON.stringify(v)}\n`),
    onRequestTransformations: async (entries) => {
      const allow = {};
      for (const e of entries) {
        (allow[e.match.host] ??= []).push({ match: { path: e.match.path, headers: e.match.headers }, transform: [{ headers: e.transform.headers }] });
      }
      const u0 = t();
      await sandbox.update({ networkPolicy: { allow } });
      timing.policyUpdateMs = since(u0);
    },
  });
  t0 = t();
  const session = await harness(model).doStart({ sessionId: name, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all" });
  timing.doStartMs = since(t0);
  log("session started", { isResume: session.isResume, counters: { ...counters } });

  const { events, emit } = recorder(name, 1);
  t0 = t();
  const control = await session.doPromptTurn({ prompt: PROMPT, skills: [], tools: [], responseFormat: { type: "json", schema: SCHEMA }, emit });
  // Suspend once the turn is demonstrably mid-flight: after the second completed tool call.
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (events.filter((e) => e.type === "tool-result").length >= 2 || events.some((e) => e.type === "finish")) { clearInterval(iv); resolve(); } }, 250);
  });
  const suspendAt = since(t0);
  const state = await session.doSuspendTurn();
  await control.done;
  timing.slice1Ms = since(t0);
  const finishedInSlice1 = events.some((e) => e.type === "finish");
  writeFileSync(out(name, "cursor.json"), JSON.stringify({ name, sessionId: sandbox.currentSession().sessionId, model, state, timing }, null, 2));
  log("slice 1 suspended", {
    suspendAtMs: suspendAt, finishedInSlice1, counters,
    eventTypes: events.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] ?? 0) + 1 }), {}),
    stateShape: { type: state.type, keys: Object.keys(state), dataKeys: Object.keys(state.data ?? {}), bridge: state.data?.bridge ? { ...state.data.bridge, token: `<${state.data.bridge.token.length} chars>` } : null, credentialEnvKeys: Object.keys(state.data?.sandboxCredentialEnvironment ?? {}) },
    cursorBytes: JSON.stringify(state).length,
    timing,
  });
  log("NEXT", `node b0.mjs continue ${name}`);
  process.exit(0); // end the process hard: nothing in memory carries over
}

async function cont(name) {
  const saved = JSON.parse(readFileSync(out(name, "cursor.json"), "utf8"));
  const timing = {};
  let t0 = t();
  const sandbox = await Sandbox.get({ ...creds, name });
  timing.getMs = since(t0);
  const sessionId = sandbox.currentSession().sessionId;
  log("reattached", { name, status: sandbox.status, sessionIdMatches: sessionId === saved.sessionId });
  if (sessionId !== saved.sessionId) throw new Error("found Sandbox is not the recorded one");
  const { io, counters } = vercelSession(sandbox, {
    workDir: WORK,
    trace: (k, v) => process.stdout.write(`  io.${k} ${typeof v === "string" ? v : JSON.stringify(v)}\n`),
    onRequestTransformations: async (entries) => log("resume asked for transforms again (policy left as is)", entries.length),
  });
  t0 = t();
  const session = await harness(saved.model).doStart({ sessionId: name, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all", continueFrom: saved.state });
  timing.doStartMs = since(t0);
  log("resumed session", { isResume: session.isResume, countersAfterStart: { ...counters } });
  const { events, emit } = recorder(name, 2);
  t0 = t();
  const control = await session.doContinueTurn({ skills: [], tools: [], responseFormat: { type: "json", schema: SCHEMA }, emit });
  const result = await control.done;
  timing.slice2Ms = since(t0);
  const all = readFileSync(out(name, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls = all.filter((e) => e.type === "tool-call").map((e) => e.toolCallId);
  const results = all.filter((e) => e.type === "tool-result").map((e) => e.toolCallId);
  const text = all.filter((e) => e.type === "text-delta").map((e) => e.delta).join("");
  const finishes = all.filter((e) => e.type === "finish");
  log("slice 2 done", {
    attachedWithoutSpawn: counters.spawns === 0, counters, result: result ?? null,
    evidence: {
      toolCalls: calls.length, uniqueToolCalls: new Set(calls).size, toolResults: results.length, uniqueToolResults: new Set(results).size,
      callsWithoutResult: calls.filter((c) => !results.includes(c)), finishEvents: finishes.length,
      finishSlices: finishes.map((f) => f.slice), usageBySlice: all.filter((e) => e.usage || e.totalUsage).map((e) => ({ slice: e.slice, type: e.type, usage: e.usage, totalUsage: e.totalUsage })),
    },
    answer: text.slice(0, 1500),
    timing,
  });
  await sandbox.stop();
  log("stopped", name);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "start") await start(arg);
else if (cmd === "continue") await cont(arg);
else if (cmd === "stop") await (await Sandbox.get({ ...creds, name: arg })).stop();
else { console.error("start [model] | continue <name> | stop <name>"); process.exit(1); }
