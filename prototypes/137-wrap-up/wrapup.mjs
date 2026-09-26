// PROTOTYPE for #137. Throwaway, never merged.
// Measures ADR 0032's wrap-up on a real Vercel Sandbox with Codex 0.156.1 under the ADR 0020 policy:
// the reserve from abort A to a persisted Result, toolCallId stability across attach, whether the wrap-up's
// `finish` Usage covers the aborted turn, and the quiescence proof against a backgrounded Reviewer process.
//
//   node wrapup.mjs long   [model] [baseFiles]   seed a long thread, abort the review turn on it
//   node wrapup.mjs repair [model]               slice the initial turn three times, abort the repair turn
//   node wrapup.mjs stop <name>
//
// Launch path is the #135 image (patched bridge, allowlist wrapper, Reviewer uid 2000). The Provider
// credential is a firewall header transform (the #114 b0 scaffold), not the ADR 0021 proxy.
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCodex } from "@ai-sdk/harness-codex";
import { Sandbox } from "@vercel/sandbox";
import pg from "pg";
import WebSocket from "ws";
import { fixture, MODULES } from "./fixture.mjs";
import POLICY from "./policy.js";

// This host's AAAA lookups time out; force IPv4 (as the #114 rig does).
const lookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === "function") [cb, opts] = [opts, {}];
  if (typeof opts === "number") opts = { family: opts };
  return lookup(host, { ...opts, family: 4 }, cb);
};

// ---------------------------------------------------------------- credentials (the #114 rig's)
const CONFIG = join(homedir(), ".config", "reprove-proto-114", "env");
for (const line of readFileSync(CONFIG, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
let vercelToken = process.env.VERCEL_TOKEN;
const cliAuth = join(homedir(), ".local/share/com.vercel.cli/auth.json");
if (!vercelToken && existsSync(cliAuth)) vercelToken = JSON.parse(readFileSync(cliAuth, "utf8")).token;
const creds = { token: vercelToken, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID };
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!creds.token || !creds.teamId || !creds.projectId || !OPENAI_API_KEY || !process.env.DATABASE_URL) throw new Error(`missing credentials in ${CONFIG}`);

const WORK = "/vercel/sandbox";
const WS = `${WORK}/ws`;
const PORT = 3000;
const here = (p) => new URL(p, import.meta.url);
const ANSWER_SCHEMA = JSON.parse(readFileSync(here("./answer-schema.json"), "utf8"));
const [SCENARIO, MODEL_ARG, TARGET_ARG] = process.argv.slice(2);
const MODEL = MODEL_ARG ?? "gpt-6-sol";
const LONG_CAP_MS = 4 * 60_000; // abort anyway after this long in the review turn
const SEEDS = 4;
const LONG_ABORT_AFTER_RESULTS = Number(process.env.P137_ABORT_AFTER ?? 2);
const SEED_BASE_FILES = Number(TARGET_ARG ?? 12); // base files added to the 30 head files; tunes the thread length
const SEED_GAP_MS = 25_000;
const REFILL_MS = 65_000;
// A turn control whose settlement is observed, so a rejected turn is recorded rather than unhandled.
const track = (c) => {
  c.state = "pending";
  c.done.then(() => { c.state = "resolved"; }, (e) => { c.state = "rejected"; c.error = String(e?.message ?? e).slice(0, 300); });
  return c;
};

// The wrap-up text: a versioned Adapter template (ADR 0032 §3). v0 is this prototype's draft.
const WRAPUP_PROMPT_V0 = [
  "Your time for this review is up. Do not run any further commands or tools.",
  "Return the required JSON answer now, from what you have already established in this review.",
  "Report only Findings you already have grounds for, cite as Evidence only commands you actually executed earlier, and state in unfinished what you did not review.",
].join(" ");
const REPAIR_PROMPT = "The previous answer failed result_invalid. Repair the answer using the required JSON shape and only Evidence supported by commands you actually executed. Do not change the review policy.";

// ---------------------------------------------------------------- secrets never reach an artifact
const TOKENS = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")]; // generation 1, 2
const sha8 = (t) => createHash("sha256").update(t).digest("hex").slice(0, 8);
const safe = (text) => {
  if (TOKENS.some((t) => text.includes(t)) || text.includes(OPENAI_API_KEY) || /sk-[A-Za-z0-9_-]{20,}/u.test(text)) throw new Error("refusing to write a secret-bearing artifact");
  return text;
};
const record = { timeline: [] };
const log = (label, value) => {
  record[label] = value;
  process.stdout.write(safe(`\n[${new Date().toISOString()}] ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`));
};
const now = () => performance.now();
let tA = null;
const mark = (step, extra = {}) => {
  const e = { step, at: new Date().toISOString(), sinceAbortMs: tA === null ? null : Math.round(now() - tA), ...extra };
  record.timeline.push(e);
  process.stdout.write(`  >> ${step}${e.sinceAbortMs === null ? "" : ` +${e.sinceAbortMs}ms`}\n`);
  return now();
};

// ---------------------------------------------------------------- image files (the #135 image)
const exactlyOnce = (text, from, to, what) => {
  if (text.split(from).length !== 2) throw new Error(`bridge patch: expected one match for ${what}`);
  return text.replace(from, to);
};
function imageFiles() {
  const files = JSON.parse(readFileSync(here("./codex-image-0.156.1.json"), "utf8"));
  const out = [];
  for (const f of files) {
    if (f.path === "reprove-codex") continue;
    if (f.path !== "bridge.mjs") { out.push(f); continue; }
    let c = f.content;
    c = exactlyOnce(c, 'import { randomUUID } from "crypto";', 'import { randomUUID, timingSafeEqual } from "crypto";', "crypto import");
    c = exactlyOnce(
      c,
      '  const expectedToken = options.token ?? procEnv.BRIDGE_CHANNEL_TOKEN ?? "";\n',
      '  const expectedToken = options.token ?? procEnv.BRIDGE_CHANNEL_TOKEN ?? "";\n' +
        '  if (!/^[0-9a-f]{64}$/.test(expectedToken)) {\n' +
        '    process.stderr.write("reprove: refusing to start the bridge without a 64-hex BRIDGE_CHANNEL_TOKEN\\n");\n' +
        "    process.exit(78);\n" +
        "  }\n" +
        "  const expectedTokenBytes = Buffer.from(expectedToken, \"hex\");\n" +
        "  const tokenMatches = (candidate) => typeof candidate === \"string\" && /^[0-9a-f]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate, \"hex\"), expectedTokenBytes);\n",
      "expectedToken",
    );
    c = exactlyOnce(c, 'if (url.searchParams.get("agent_bridge_token") !== expectedToken) {', 'if (!tokenMatches(url.searchParams.get("agent_bridge_token"))) {', "token comparison");
    out.push({ path: "bridge.mjs", content: c });
  }
  for (const name of ["reprove-codex", "reprove-codex-stage2"]) out.push({ path: name, content: readFileSync(here(`./sandbox/${name}`), "utf8") });
  return out;
}
const proofFiles = ["reviewer-idle.sh", "ws-probe.mjs", "scan.mjs", "rollout.mjs", "procs.sh", "quiesce.sh", "plant.sh"];

// ---------------------------------------------------------------- helpers
async function run(sandbox, script, { sudo = false } = {}) {
  const r = await sandbox.runCommand({ cmd: "sh", args: ["-c", script], sudo });
  return { exitCode: r.exitCode, stdout: (await r.stdout()).trim(), stderr: (await r.stderr()).trim() };
}
const asReviewer = (sandbox, args) =>
  sandbox
    .runCommand({ cmd: "setpriv", args: ["--reuid=reviewer", "--regid=reviewer", "--init-groups", "--no-new-privs", "--", ...args], sudo: true })
    .then(async (r) => ({ exitCode: r.exitCode, stdout: (await r.stdout()).trim(), stderr: (await r.stderr()).trim() }));
const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const rollout = async (sandbox) => JSON.parse((await run(sandbox, "node /opt/reprove-proof/rollout.mjs", { sudo: true })).stdout || "[]");
const procs = async (sandbox, oldPid = "") => (await run(sandbox, `sh /opt/reprove-proof/procs.sh ${oldPid}`, { sudo: true })).stdout.split("\n");
const bridgePid = async (sandbox) => {
  const r = await run(sandbox, "for p in $(pgrep -f '^(sh -c )?node [^ ]*/bridge[.]mjs.? --workdir'); do echo \"$p $(cat /proc/$p/comm)\"; done", { sudo: true });
  const ps = r.stdout.split("\n").filter(Boolean).map((l) => l.split(" "));
  return { all: ps.map((p) => p[0]), pid: ps.find((p) => p[1] === "node" || p[1] === "MainThread")?.[0] ?? ps.at(-1)?.[0] };
};
function wsProbe(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    const timer = setTimeout(() => { ws.terminate(); resolve({ close: "timeout", messages }); }, 8000);
    ws.on("message", (m) => { messages.push(JSON.parse(String(m)).type); if (messages.length === 1) ws.close(1000); });
    ws.on("close", (code) => { clearTimeout(timer); resolve({ close: code, messages }); });
    ws.on("error", (e) => { clearTimeout(timer); resolve({ close: `error:${e.message}`, messages }); });
  });
}

// ---------------------------------------------------------------- the session (the #135 hosted io)
function streamsOf(command) {
  let out, err;
  const stdout = new ReadableStream({ start: (c) => { out = c; } });
  const stderr = new ReadableStream({ start: (c) => { err = c; } });
  (async () => {
    try { for await (const line of command.logs()) (line.stream === "stderr" ? err : out).enqueue(new TextEncoder().encode(line.data)); } catch {}
    try { out.close(); } catch {}
    try { err.close(); } catch {}
  })();
  return { stdout, stderr };
}
function hostedSession(sandbox, instanceId) {
  const counters = { spawns: 0, runs: 0 };
  const read = async (path) => { const b = await sandbox.readFileToBuffer({ path }); return b ? new Uint8Array(b) : null; };
  const write = (path, bytes) => sandbox.writeFiles([{ path, content: Buffer.from(bytes) }]);
  const io = {
    id: instanceId,
    description: "Reprove #137 prototype Vercel Sandbox",
    defaultWorkingDirectory: WORK,
    ports: [PORT],
    getPortUrl: async ({ port }) => sandbox.domain(port),
    getPortEndpoint: async ({ port, protocol }) => { const url = sandbox.domain(port); return { url: protocol === "ws" ? url.replace(/^https:/, "wss:") : url }; },
    stop: async () => {},
    destroy: async () => {},
    readBinaryFile: ({ path }) => read(path),
    readFile: async ({ path }) => { const b = await read(path); return b === null ? null : new Response(b).body; },
    readTextFile: async ({ path, startLine, endLine }) => {
      const b = await read(path);
      if (b === null) return null;
      const text = new TextDecoder().decode(b);
      return startLine !== undefined || endLine !== undefined ? text.split("\n").slice((startLine ?? 1) - 1, endLine).join("\n") : text;
    },
    writeBinaryFile: ({ path, content }) => write(path, content),
    writeTextFile: ({ path, content }) => write(path, new TextEncoder().encode(content)),
    writeFile: async ({ path, content }) => write(path, new Uint8Array(await new Response(content).arrayBuffer())),
    run: async ({ command, workingDirectory, env }) => {
      counters.runs++;
      const done = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd: workingDirectory ?? WORK, env });
      return { exitCode: done.exitCode ?? -1, stdout: await done.stdout(), stderr: await done.stderr() };
    },
    spawn: async ({ command, workingDirectory, env }) => {
      counters.spawns++;
      if (!/\/bridge\.mjs'? --workdir /u.test(command)) throw new Error(`unexpected spawn: ${command.slice(0, 80)}`);
      const cmd = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd: workingDirectory ?? WORK, env, sudo: true, detached: true });
      const { stdout, stderr } = streamsOf(cmd);
      return { stdout, stderr, wait: async () => ({ exitCode: (await cmd.wait()).exitCode ?? -1 }), kill: async () => { await cmd.kill().catch(() => {}); } };
    },
    addRequestTransformations: async (entries) => {
      const allow = {};
      for (const e of entries) (allow[e.match.host] ??= []).push({ match: { path: e.match.path, headers: e.match.headers }, transform: [{ headers: e.transform.headers }] });
      await sandbox.update({ networkPolicy: { allow } });
    },
  };
  io.restricted = () => ({
    description: io.description,
    readFile: io.readFile, readBinaryFile: io.readBinaryFile, readTextFile: io.readTextFile,
    writeFile: io.writeFile, writeBinaryFile: io.writeBinaryFile, writeTextFile: io.writeTextFile,
    run: io.run, spawn: io.spawn,
  });
  return { io, counters };
}

// One harness per bridge generation. mintBridgeToken returns that generation's committed token, once.
function harnessFor(generation, instanceId) {
  let minted = 0;
  const h = createCodex({
    model: MODEL,
    reasoningEffort: "low",
    auth: { OPENAI_API_KEY },
    webSearch: false,
    codexConfig: { project_doc_max_bytes: 0, "skills.include_instructions": false },
    mintBridgeToken: (sandboxId) => {
      if (sandboxId !== instanceId) throw new Error("mintBridgeToken: not the recorded instance");
      if (minted++ > 0) throw new Error(`mintBridgeToken: generation ${generation} already spawned`);
      return TOKENS[generation - 1];
    },
  });
  return { h, minted: () => minted };
}

// Every event, tagged with (generation, turn, slice), kept in memory; content is summarised, never logged.
const events = [];
const helperCallIds = new Set();
let diagSandbox = null;
function recorder(generation, turn, slice) {
  return (e) => {
    const r = { generation, turn, slice, at: Date.now(), type: e.type };
    for (const k of ["id", "toolCallId", "toolName", "nativeName", "providerExecuted", "finishReason"]) if (e[k] !== undefined) r[k] = e[k];
    if (e.type === "tool-call") r.input = String(e.input ?? "").slice(0, 200);
    if (e.type === "tool-result") r.resultSha8 = sha8(JSON.stringify(e.result ?? null)), r.exitCode = e.result?.exitCode ?? null;
    if (e.type === "text-delta") r.delta = e.delta;
    if (e.usage) r.usage = e.usage;
    if (e.totalUsage) r.totalUsage = e.totalUsage;
    events.push(r);
    if (e.type === "tool-call" && /helper\.js/.test(r.input ?? "")) helperCallIds.add(e.toolCallId);
    if (e.type === "tool-result" && helperCallIds.has(e.toolCallId) && diagSandbox) {
      for (const delay of [300, 3000]) setTimeout(() => run(diagSandbox, "sh /opt/reprove-proof/procs.sh; echo '--- helper.log'; cat /tmp/helper.log 2>&1 | head -5", { sudo: true }).then((x) => { (record.helperDiagnostics ??= []).push({ delayMs: delay, generation, turn, out: x.stdout.split("\n") }); }).catch(() => {}), delay);
    }
    if (!["text-delta", "reasoning-delta", "raw"].includes(e.type)) process.stdout.write(`  [g${generation} t${turn} s${slice}] ${e.type}${e.toolCallId ? ` ${e.toolCallId}` : ""}${r.input ? ` ${r.input.slice(0, 90)}` : ""}\n`);
  };
}
const toolResults = (filter) => events.filter((e) => e.type === "tool-result" && filter(e));
// ADR 0020 / #132: the answer is the final agent message, not every text delta.
function finalMessage(filter) {
  const texts = new Map();
  for (const e of events.filter((e) => e.type === "text-delta" && filter(e))) texts.set(e.id, (texts.get(e.id) ?? "") + e.delta);
  return [...texts.values()].at(-1) ?? "";
}

// ---------------------------------------------------------------- store (Neon, the #114 rig's project)
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
async function storeSetup() {
  await db.query(`create table if not exists p137_slice (pass_id text, generation int, slice int, state text, observations jsonb, primary key (pass_id, slice))`);
  await db.query(`create table if not exists p137_custody (pass_id text, generation int, ciphertext bytea, primary key (pass_id, generation))`);
  await db.query(`create table if not exists p137_result (pass_id text primary key, result jsonb, stopped_by text)`);
  await db.query(`create table if not exists p137_observation (pass_id text, generation int, turn int, tool_call_id text, result_sha8 text, primary key (pass_id, generation, turn, tool_call_id))`);
}
// ADR 0032 §5 step 4: finish the aborting Slice, destroy the old token, claim the wrap-up Slice, commit gen-2.
async function custodyTransaction(passId, abortingSlice, observations) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("insert into p137_slice values ($1, 1, $2, 'aborted', $3) on conflict (pass_id, slice) do update set state = 'aborted', observations = excluded.observations", [passId, abortingSlice, JSON.stringify(observations)]);
    for (const o of observations) await c.query("insert into p137_observation values ($1, $2, $3, $4, $5) on conflict do nothing", [passId, o.generation, o.turn, o.toolCallId, o.resultSha8]);
    await c.query("delete from p137_custody where pass_id = $1 and generation = 1", [passId]);
    await c.query("insert into p137_slice values ($1, 2, $2, 'started', null)", [passId, abortingSlice + 1]);
    await c.query("insert into p137_custody values ($1, 2, $2)", [passId, randomBytes(92)]); // stands in for the sealed token
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

// ---------------------------------------------------------------- setup
async function install(sandbox, kind) {
  const { base, head } = fixture(kind);
  const files = imageFiles();
  await sandbox.writeFiles([
    ...files.map((f) => ({ path: `/tmp/reprove-codex-src/${f.path}`, content: Buffer.from(f.content) })),
    ...proofFiles.map((n) => ({ path: `/tmp/reprove-proof-src/${n}`, content: readFileSync(here(`./sandbox/${n}`)) })),
    ...Object.entries(base).map(([p, c]) => ({ path: `/tmp/fx/base/${p}`, content: Buffer.from(c) })),
    ...Object.entries(head).map(([p, c]) => ({ path: `/tmp/fx/head/${p}`, content: Buffer.from(c) })),
    { path: "/tmp/fx/narrative.json", content: Buffer.from(JSON.stringify({ authority: "none", title: kind === "long" ? "Rule context and money fixes" : "Money fixes", body: kind === "long" ? "Adds a context argument to every generated ledger rule and tidies the money helpers." : "Tidies the money helpers and adds applyDiscount." })) },
  ]);
  const r = await run(sandbox, [
    "set -e",
    "useradd -u 2000 -U -M -d /home/reviewer -s /bin/sh reviewer",
    "install -d -o reviewer -g reviewer -m 0700 /home/reviewer /home/reviewer/.codex",
    "mkdir -p /opt/reprove/codex /opt/reprove-proof /reprove/input",
    "cp -r /tmp/reprove-codex-src/. /opt/reprove/codex/ && cp -r /tmp/reprove-proof-src/. /opt/reprove-proof/",
    "cd /opt/reprove/codex",
    "pnpm install --frozen-lockfile --ignore-scripts --store-dir /opt/reprove/.pnpm-store >/tmp/pnpm.log 2>&1 || (tail -20 /tmp/pnpm.log; exit 1)",
    "chown -R root:root /opt/reprove /opt/reprove-proof",
    "chmod 555 /opt/reprove/codex/reprove-codex /opt/reprove/codex/reprove-codex-stage2 /opt/reprove-proof/*.sh",
    "install -d -o root -g root -m 0755 /opt/reprove/run /opt/reprove/run/schemas",
    `DU=$(stat -c %U /vercel); DG=$(stat -c %G /vercel)`,
    `install -d -o "$DU" -g "$DG" -m 0755 ${WORK}`,
    `install -d -o "$DU" -g "$DG" -m 0700 ${WORK}/.agent-runs`,
    `mkdir -p ${WORK}/.harness-bootstrap && ln -sfn /opt/reprove/codex ${WORK}/.harness-bootstrap/codex && chown -h "$DU:$DG" ${WORK}/.harness-bootstrap ${WORK}/.harness-bootstrap/codex`,
    "cp /tmp/fx/narrative.json /reprove/input/narrative.json && chmod 0444 /reprove/input/narrative.json",
    // Base and head commits, built as the Reviewer so the Workspace is Reviewer-owned.
    `mkdir -p ${WS} && chown reviewer:reviewer ${WS}`,
    `chmod -R a+rX /tmp/fx`,
    `setpriv --reuid=reviewer --regid=reviewer --init-groups -- env HOME=/home/reviewer sh -c 'cd ${WS} && git init -q -b main && git config user.email fx@example.com && git config user.name fixture && cp -r /tmp/fx/base/. . && git add -A && git commit -qm base && rm -rf src test tools package.json && cp -r /tmp/fx/head/. . && git add -A && git commit -qm head && git rev-parse HEAD~1 HEAD'`,
    "rm -rf /tmp/reprove-codex-src /tmp/reprove-proof-src /tmp/fx",
    "/opt/reprove/codex/node_modules/.pnpm/node_modules/.bin/codex --version",
  ].join(" && "), { sudo: true });
  if (r.exitCode !== 0) throw new Error(`install failed: ${r.stdout}\n${r.stderr}`);
  const [baseSha, headSha] = r.stdout.split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l));
  return { baseSha, headSha, codexVersion: r.stdout.split("\n").at(-1) };
}

function reviewPrompt(kind, { baseSha, headSha }, minutes) {
  const target = new Date(Date.now() + minutes * 60_000);
  return [
    `Review the pull request whose base is ${baseSha} and whose head is ${headSha}; the Workspace is checked out at the head.`,
    `Answer target: ${target.toISOString()} (UTC). Time remaining at the start of this review: ${minutes} minutes.`,
    "Project commands are not configured; infer them from the manifests if an experiment needs them.",
    "The tests talk to a helper daemon. Before running anything else, start it detached with exactly `setsid nohup node tools/helper.js >/tmp/helper.log 2>&1 </dev/null &` and leave it running.",
    ...(kind === "long" ? [`The change touches every module under src/rules (${MODULES} files) as well as src/money.js.`] : []),
  ].join("\n");
}

// ---------------------------------------------------------------- the run
async function main() {
  if (!["long", "repair"].includes(SCENARIO)) throw new Error("usage: wrapup.mjs long|repair [model] [targetTokens]");
  const name = `p137-${SCENARIO}-${Date.now().toString(36)}`;
  const passId = `pass-${name}`;
  log("run", { name, passId, scenario: SCENARIO, model: MODEL, seedBaseFiles: SCENARIO === "long" ? SEED_BASE_FILES : null, tokenSha8: TOKENS.map(sha8) });
  await storeSetup();
  const sandbox = await Sandbox.create({ ...creds, name, persistent: false, ports: [PORT], timeout: 40 * 60_000, networkPolicy: { allow: { "registry.npmjs.org": [] } } });
  const instanceId = sandbox.currentSession().sessionId;
  log("created", { instanceId, region: sandbox.region, vcpus: sandbox.vcpus });
  try {
    await pass(sandbox, name, passId, instanceId);
  } catch (e) {
    log("error", { name: e?.name, message: String(e?.message ?? e).slice(0, 800) });
  } finally {
    await sandbox.stop().catch((e) => log("stop failed", String(e)));
    await db.end().catch(() => {});
    record.events = events.map((e) => (e.type === "text-delta" ? { ...e, delta: `<${e.delta.length} chars>` } : e));
    writeFileSync(here(`./out/${name}.json`), safe(JSON.stringify(record, null, 2)));
    log("stopped", name);
  }
}

async function pass(sandbox, name, passId, instanceId) {
  const shas = await install(sandbox, SCENARIO);
  diagSandbox = sandbox;
  log("installed", shas);
  // Calibrate this host's round trip to the Sandbox API; every step below pays it.
  const r0 = now(); await run(sandbox, "true"); const r1 = now(); await run(sandbox, "true", { sudo: true });
  log("rtt", { runCommandMs: Math.round(r1 - r0), sudoRunCommandMs: Math.round(now() - r1) });
  const q0 = now(); await db.query("select 1"); log("db rtt", { selectMs: Math.round(now() - q0) });

  const g1 = harnessFor(1, instanceId);
  let { io, counters } = hostedSession(sandbox, instanceId);
  let session = await g1.h.doStart({ sessionId: passId, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all" });
  const bridge1 = await bridgePid(sandbox);
  log("gen1 started", { counters: { ...counters }, bridge: bridge1 });

  const turnOpts = { instructions: POLICY, skills: [], tools: [], responseFormat: { type: "json", schema: ANSWER_SCHEMA } };
  let ac = new AbortController();
  let slice = 1;
  let control;
  let abortingTurn;
  const cursors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = (turn) => toolResults((e) => e.turn === turn).length;
  const finished = (turn) => events.some((e) => e.turn === turn && e.type === "finish");

  // Two mid-turn suspensions and attaches of `turn`, the second with a rewound cursor, to observe replay.
  const sliceTest = async (turn, [n1, n2]) => {
    for (const [n, rewind] of [[n1, false], [n2, true]]) {
      while (results(turn) < n && !finished(turn) && control.state === "pending") await sleep(100);
      if (finished(turn) || control.state !== "pending") { log("NOTE", `slice test stopped early: finished=${finished(turn)} state=${control.state}`); return; }
      const cursor = await session.doSuspendTurn();
      await control.done.catch(() => {});
      cursors.push({ slice, lastSeenEventId: cursor.data.bridge.lastSeenEventId, threadId: cursor.data.threadId ?? null, resultsSoFar: results(turn) });
      const attachWith = rewind ? { ...cursor, data: { ...cursor.data, bridge: { ...cursor.data.bridge, lastSeenEventId: cursors[0].lastSeenEventId } } } : cursor;
      slice++;
      ({ io, counters } = hostedSession(sandbox, instanceId));
      session = await g1.h.doStart({ sessionId: passId, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all", continueFrom: attachWith });
      ac = new AbortController();
      control = track(await session.doContinueTurn({ ...turnOpts, abortSignal: ac.signal, emit: recorder(1, turn, slice) }));
      log(`attach slice ${slice}`, { rewoundTo: rewind ? cursors[0].lastSeenEventId : null, cursor: cursors.at(-1), spawnsOnAttach: counters.spawns });
    }
  };

  if (SCENARIO === "repair") {
    // Initial turn runs to its finish across three Slices; the repair turn is the one A lands in.
    control = track(await session.doPromptTurn({ ...turnOpts, prompt: reviewPrompt("repair", shas, 6), emit: recorder(1, 1, 1) }));
    await sliceTest(1, [2, 4]);
    await control.done;
    log("turn 1 finished", { finish: events.filter((e) => e.turn === 1 && e.type === "finish").map((e) => e.totalUsage ?? e.usage), toolResults: results(1), answerChars: finalMessage((e) => e.turn === 1).length });
    log("rollout after turn 1", await rollout(sandbox));
    log("procs after turn 1", await procs(sandbox));
    abortingTurn = 2;
    control = track(await session.doPromptTurn({ ...turnOpts, prompt: REPAIR_PROMPT, abortSignal: ac.signal, emit: recorder(1, 2, slice) }));
    // A lands while the repair turn is streaming: 300 ms after its first event.
    const t0 = Date.now();
    while (!events.some((e) => e.turn === 2) && Date.now() - t0 < 60_000) await sleep(25);
    await sleep(300);
    if (finished(2)) log("NOTE", "repair turn finished before A; this run did not abort mid-repair");
  } else {
    // Seed the thread under the same instructions and tools (so the thread never restarts), paced to stay
    // inside the org's tokens-per-minute limit, then let the bucket refill before the review turn.
    const { head, base } = fixture("long");
    const blobs = Object.keys(head).filter((p) => p.startsWith("src/rules/")).map((p) => `--- head ${p}\n${head[p]}`)
      .concat(Object.keys(base).filter((p) => p.startsWith("src/rules/")).slice(0, SEED_BASE_FILES).map((p) => `--- base ${p}\n${base[p]}`));
    const parts = Array.from({ length: SEEDS }, (_, k) => blobs.filter((_, i) => i % SEEDS === k).join("\n"));
    let turn = 0;
    for (const [k, text] of parts.entries()) {
      turn = k + 1;
      const s0 = Date.now();
      const c = track(await session.doPromptTurn({ instructions: POLICY, skills: [], tools: [], prompt: `Reference material for the review that follows, part ${k + 1} of ${SEEDS}: source of the ledger rule modules. Do not run anything and do not review yet. Reply with exactly OK.\n\n${text}`, emit: recorder(1, turn, slice) }));
      await c.done.catch(() => {});
      const ro = await rollout(sandbox);
      log(`seed ${turn}`, { state: c.state, error: c.error ?? null, ms: Date.now() - s0, lastInput: ro.flatMap((f) => f.tokenCounts).at(-1)?.last?.input_tokens ?? null });
      if (c.state !== "resolved") throw new Error(`seed ${turn} failed`);
      await sleep(Math.max(0, SEED_GAP_MS - (Date.now() - s0)));
    }
    log("TPM refill", `${REFILL_MS} ms`);
    await sleep(REFILL_MS);
    abortingTurn = turn + 1;
    const t0 = Date.now();
    control = track(await session.doPromptTurn({ ...turnOpts, prompt: reviewPrompt("long", shas, 25), abortSignal: ac.signal, emit: recorder(1, abortingTurn, slice) }));
    // A: once the helper is up and one more tool result arrived, or the cap, or the turn settled.
    while (Date.now() - t0 < LONG_CAP_MS && control.state === "pending" && !(helperCallIds.size > 0 && results(abortingTurn) >= LONG_ABORT_AFTER_RESULTS)) await sleep(250);
    log("review turn at A", { state: control.state, error: control.error ?? null, results: results(abortingTurn), ms: Date.now() - t0 });
  }

  // ------------------------------------------------ A
  // A planted Reviewer-uid survivor, independent of what Codex reaps: its own session, TERM and HUP ignored,
  // with a double-forked grandchild. Proves the kill does not depend on process-group or parent relations.
  const plant = await run(sandbox, "sh /opt/reprove-proof/plant.sh", { sudo: true });
  log("planted survivor", plant.stdout.split("\n"));
  log("rollout at A", await rollout(sandbox));
  const procsBeforeAbort = await procs(sandbox, bridge1.pid);
  tA = now();
  mark("A: abort");
  ac.abort();
  const abortResult = await control.done.then(() => "resolved", (e) => `${e?.name}: ${String(e?.message).slice(0, 120)}`);
  mark("turn settled", { abortResult });
  const inFlight = events.filter((e) => e.turn === abortingTurn && e.type === "tool-call").map((e) => e.toolCallId).filter((id) => !events.some((r) => r.type === "tool-result" && r.turn === abortingTurn && r.toolCallId === id));
  const procsAfterAbort = await procs(sandbox, bridge1.pid);
  mark("procs after abort");

  let state;
  try { state = await session.doStop(); } catch (e) { mark("doStop threw", { message: String(e?.message) }); throw e; }
  mark("doStop returned", { threadId: state?.data?.threadId ?? null, dataKeys: Object.keys(state?.data ?? {}) });
  const procsAfterStop = await procs(sandbox, bridge1.pid);
  mark("procs after stop");
  const q = await run(sandbox, `sh /opt/reprove-proof/quiesce.sh ${bridge1.pid}`, { sudo: true });
  mark("quiescence", { proven: q.exitCode === 0 });
  log("processes around A", { before: procsBeforeAbort, afterAbort: procsAfterAbort, afterStop: procsAfterStop, quiesce: { exitCode: q.exitCode, out: q.stdout.split("\n") } });
  if (q.exitCode !== 0) log("NOTE", "quiescence not proven: wrapup_quiescence_unproven");

  const observations = toolResults((e) => e.generation === 1).map((e) => ({ generation: 1, turn: e.turn, toolCallId: e.toolCallId, resultSha8: e.resultSha8 }));
  await custodyTransaction(passId, slice, observations);
  mark("custody transaction committed", { observations: observations.length });

  // ------------------------------------------------ generation 2
  const g2 = harnessFor(2, instanceId);
  ({ io, counters } = hostedSession(sandbox, instanceId));
  const s2 = await g2.h.doStart({ sessionId: passId, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all", resumeFrom: state });
  mark("gen2 doStart", { isResume: s2.isResume, spawns: counters.spawns, minted: g2.minted() });
  const bridge2 = await bridgePid(sandbox);
  mark("gen2 bridge found", { pid: bridge2.pid });

  // ADR 0031 §7 checks against the new idle bridge, plus the old generation's token.
  const idle = await asReviewer(sandbox, ["sh", "/opt/reprove-proof/reviewer-idle.sh", passId, ...bridge2.all]);
  const scan = JSON.parse((await run(sandbox, `node /opt/reprove-proof/scan.mjs ${bridge2.pid}`, { sudo: true })).stdout);
  const publicUrl = `${sandbox.domain(PORT).replace(/^https:/, "wss:")}/`;
  const routes = { absent: await wsProbe(publicUrl), wrong: await wsProbe(`${publicUrl}?agent_bridge_token=${randomBytes(32).toString("hex")}`), oldGeneration: await wsProbe(`${publicUrl}?agent_bridge_token=${TOKENS[0]}`) };
  mark("bridge checks done");
  log("gen2 bridge checks", {
    reviewer: kv(idle.stdout),
    scan: { tokenIsGen2: scan.tokenSha8 === sha8(TOKENS[1]), holders: scan.processes.filter((p) => p.tokenInEnviron || p.tokenInCmdline).map((p) => `${p.pid}<${p.ppid} uids=${p.uids} ${p.comm} env=${p.tokenInEnviron} cmd=${p.tokenInCmdline}`), reviewerUidHolders: scan.processes.filter((p) => p.uids.split("/").includes("2000") && (p.tokenInEnviron || p.tokenInCmdline)).length },
    publicRoute: routes,
  });

  // ------------------------------------------------ the wrap-up turn
  const wturn = abortingTurn + 1;
  const completesBefore = (await rollout(sandbox)).flatMap((f) => f.turns).filter((t) => t.kind === "task_complete").length;
  const wc = track(await s2.doPromptTurn({ ...turnOpts, prompt: WRAPUP_PROMPT_V0, emit: recorder(2, wturn, slice + 1) }));
  mark("wrap-up prompt sent");
  while (!events.some((e) => e.turn === wturn) && wc.state === "pending") await new Promise((r) => setTimeout(r, 50));
  mark("wrap-up first event");
  await wc.done.catch(() => {});
  mark(`wrap-up turn ${wc.state}`, { error: wc.error ?? null });
  let answer = finalMessage((e) => e.turn === wturn);
  if (wc.state !== "resolved") {
    // The Harness gave up (a Codex reconnect is an error frame); Codex itself may still finish the turn.
    let ro;
    for (let i = 0; i < 120; i++) {
      ro = await rollout(sandbox);
      if (ro.flatMap((f) => f.turns).filter((t) => t.kind === "task_complete").length > completesBefore) break;
      await new Promise((r) => setTimeout(r, 2500));
    }
    const done = ro.flatMap((f) => f.turns).filter((t) => t.kind === "task_complete").length > completesBefore;
    mark(done ? "wrap-up completed in the rollout" : "wrap-up never completed in the rollout", { rolloutErrors: ro.flatMap((f) => f.errors ?? []) });
    answer = done ? ro.at(-1).lastAgentMessage?.text ?? "" : "";
  }
  let parsed = null, valid = false;
  try { parsed = JSON.parse(answer); valid = ["summary", "disprovedHypothesisCount", "findings", "unfinished", "limitations"].every((k) => k in parsed); } catch {}
  mark("validated", { valid });
  if (parsed) await db.query("insert into p137_result values ($1, $2, 'deadline_reached') on conflict (pass_id) do update set result = excluded.result", [passId, JSON.stringify(parsed)]);
  await db.query("update p137_slice set state = 'finished' where pass_id = $1 and slice = $2", [passId, slice + 1]);
  mark("persisted");
  const reserveMs = Math.round(now() - tA);
  log("wrap-up answer", {
    valid,
    findings: parsed?.findings?.map((f) => ({ title: f.title, severity: f.severity, verification: f.verification, path: f.location?.path, evidence: f.evidence?.map((x) => x.command) })) ?? null,
    unfinished: parsed?.unfinished ?? null,
    limitations: parsed?.limitations ?? null,
    summary: parsed?.summary ?? answer.slice(0, 600),
    toolCallsInWrapUp: events.filter((e) => e.turn === wturn && e.type === "tool-call").map((e) => e.input),
  });

  // ------------------------------------------------ thread identity and Usage
  const endState = await s2.doStop().catch((e) => ({ error: String(e?.message) }));
  const ro = await rollout(sandbox);
  log("rollout after wrap-up", ro);
  const finishes = events.filter((e) => e.type === "finish").map((e) => ({ generation: e.generation, turn: e.turn, usage: e.usage ?? null, totalUsage: e.totalUsage ?? null }));
  log("thread identity", {
    stoppedThreadId: state?.data?.threadId ?? null,
    wrapUpEndThreadId: endState?.data?.threadId ?? endState,
    same: (state?.data?.threadId ?? "a") === (endState?.data?.threadId ?? "b"),
    rolloutFiles: ro.map((f) => ({ file: f.file, sessionIds: f.sessionIds, tokenCounts: f.tokenCounts.length, compactions: f.compactions })),
  });
  log("usage", { finishes, rolloutTokenCounts: ro.flatMap((f) => f.tokenCounts.map((t) => ({ file: f.file.slice(-45), at: t.at, last: t.last, total: t.total }))) });

  // ------------------------------------------------ toolCallId
  const byGenTurn = {};
  for (const e of events.filter((e) => e.type === "tool-call" || e.type === "tool-result")) {
    const k = `g${e.generation}t${e.turn}`;
    (byGenTurn[k] ??= []).push({ slice: e.slice, type: e.type, id: e.toolCallId, sha: e.resultSha8 ?? null, input: e.input?.slice(0, 60) });
  }
  const analysis = {};
  for (const [k, list] of Object.entries(byGenTurn)) {
    const calls = list.filter((x) => x.type === "tool-call"), results = list.filter((x) => x.type === "tool-result");
    const bySlice = (arr) => arr.reduce((a, x) => ({ ...a, [x.slice]: (a[x.slice] ?? 0) + 1 }), {});
    const resultShasById = {};
    for (const r of results) (resultShasById[r.id] ??= new Set()).add(r.sha);
    analysis[k] = {
      toolCalls: calls.length, uniqueCallIds: new Set(calls.map((c) => c.id)).size,
      toolResults: results.length, uniqueResultIds: new Set(results.map((r) => r.id)).size,
      resultsBySlice: bySlice(results),
      replayedResults: results.length - new Set(results.map((r) => r.id)).size,
      replayedIdenticalContent: Object.values(resultShasById).every((s) => s.size === 1),
      sameIdDifferentCommand: calls.filter((c, i) => calls.findIndex((d) => d.id === c.id && d.input !== c.input) !== -1 && i >= 0).length,
      ids: [...new Set(calls.map((c) => c.id))].join(","),
    };
  }
  const idSets = Object.fromEntries(Object.entries(byGenTurn).map(([k, l]) => [k, new Set(l.map((x) => x.id))]));
  const keys = Object.keys(idSets);
  const collisions = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const shared = [...idSets[keys[i]]].filter((id) => idSets[keys[j]].has(id));
    if (shared.length) collisions.push({ a: keys[i], b: keys[j], shared: shared.slice(0, 10), count: shared.length });
  }
  log("toolCallId", { perGenerationTurn: analysis, crossTurnCollisions: collisions, inFlightAtA: inFlight, cursors });
  log("reserve", { reserveMs, steps: record.timeline.filter((t) => t.sinceAbortMs !== null).map((t) => `${t.step} +${t.sinceAbortMs}ms`) });
}

if (SCENARIO === "stop") await (await Sandbox.get({ ...creds, name: MODEL_ARG })).stop();
else await main();
