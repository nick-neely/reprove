// PROTOTYPE for #135. Throwaway, never merged.
// Proves (or disproves) that the ADR 0031 launch path keeps the Codex bridge token away from the
// Reviewer on a real Vercel Sandbox, on the target Codex 0.156.1 pin with Harness 1.0.104.
//
//   node prove.mjs            one full run; writes out/<name>.json
//   node prove.mjs stop <name>
//
// The Provider credential is a firewall header transform (the #114 b0 scaffold), not the ADR 0021
// proxy: the question here is the bridge token, and the transform keeps the real key out of the VM.
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCodex } from "@ai-sdk/harness-codex";
import { Sandbox } from "@vercel/sandbox";
import WebSocket from "ws";

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
if (!creds.token || !creds.teamId || !creds.projectId || !OPENAI_API_KEY) throw new Error(`missing credentials in ${CONFIG}`);

const WORK = "/vercel/sandbox";
const WS = `${WORK}/ws`;
const MODEL = "gpt-6-sol";
const PORT = 3000;
const here = (p) => new URL(p, import.meta.url);

// ---------------------------------------------------------------- the Pass's bridge token (ADR 0031 §1)
const TOKEN = randomBytes(32).toString("hex");
const tokenSha8 = createHash("sha256").update(TOKEN).digest("hex").slice(0, 8);

/** Every artifact goes through here; a token- or key-bearing write is a hard failure. */
const safe = (text) => {
  if (text.includes(TOKEN) || text.includes(OPENAI_API_KEY) || /sk-[A-Za-z0-9_-]{20,}/u.test(text)) {
    throw new Error("refusing to write a secret-bearing artifact");
  }
  return text;
};
const record = {};
const log = (label, value) => {
  record[label] = value;
  process.stdout.write(safe(`\n[${new Date().toISOString()}] ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`));
};

// ---------------------------------------------------------------- image files (ADR 0031 §5, §6)
const exactlyOnce = (text, from, to, what) => {
  if (text.split(from).length !== 2) throw new Error(`bridge patch: expected one match for ${what}`);
  return text.replace(from, to);
};
function imageFiles() {
  const files = JSON.parse(readFileSync(here("./codex-image-0.156.1.json"), "utf8"));
  const out = [];
  for (const f of files) {
    if (f.path === "reprove-codex") continue; // replaced by the two-stage wrapper below
    if (f.path !== "bridge.mjs") { out.push(f); continue; }
    let c = f.content;
    // ADR 0031 §6: refuse to bind on a malformed token, compare in constant time.
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
const proofFiles = ["reviewer-idle.sh", "ws-probe.mjs", "scan.mjs", "tool-check.sh", "bridge-refusal.sh"].map((name) => ({
  path: `/opt/reprove-proof/${name}`,
  content: readFileSync(here(`./sandbox/${name}`), "utf8"),
}));

// ---------------------------------------------------------------- helpers
const cmdIds = [];
async function run(sandbox, script, { sudo = false, env } = {}) {
  const r = await sandbox.runCommand({ cmd: "sh", args: ["-c", script], sudo, env });
  cmdIds.push(r.cmdId);
  return { exitCode: r.exitCode, stdout: (await r.stdout()).trim(), stderr: (await r.stderr()).trim() };
}
/** Runs a script as the Reviewer uid, entered from root with no_new_privs, as the wrapper does. */
const asReviewer = (sandbox, args) =>
  sandbox
    .runCommand({ cmd: "setpriv", args: ["--reuid=reviewer", "--regid=reviewer", "--init-groups", "--no-new-privs", "--", ...args], sudo: true })
    .then(async (r) => { cmdIds.push(r.cmdId); return { exitCode: r.exitCode, stdout: (await r.stdout()).trim(), stderr: (await r.stderr()).trim() }; });
const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));

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

/** The Sandbox's command history, read raw (not through the SDK's schema), searched for the token. */
async function historyCheck(instanceId) {
  const api = (path) =>
    fetch(`https://vercel.com/api${path}${path.includes("?") ? "&" : "?"}teamId=${creds.teamId}`, { headers: { authorization: `Bearer ${creds.token}` } })
      .then(async (r) => ({ status: r.status, text: await r.text() }));
  const perCommand = [];
  for (const id of cmdIds) {
    const { status, text } = await api(`/v2/sandboxes/sessions/${instanceId}/cmd/${id}`);
    let keys = null;
    try { const j = JSON.parse(text); keys = Object.keys(j.command ?? j); } catch {}
    perCommand.push({ id, status, tokenPresent: text.includes(TOKEN), keys, hasEnvField: /"env"\s*:/u.test(text) });
  }
  const list = await api(`/v2/sandboxes/sessions/${instanceId}/cmd`);
  return {
    commandsChecked: perCommand.length,
    anyTokenPresent: perCommand.some((c) => c.tokenPresent) || list.text.includes(TOKEN),
    anyEnvField: perCommand.some((c) => c.hasEnvField),
    recordKeys: [...new Set(perCommand.flatMap((c) => c.keys ?? []))],
    statuses: [...new Set(perCommand.map((c) => c.status))],
    bridgeCommand: perCommand.find((c) => c.id === bridgeCmdId) ?? null,
    listEndpoint: { status: list.status, tokenPresent: list.text.includes(TOKEN), bytes: list.text.length },
  };
}

// ---------------------------------------------------------------- the session (ADR 0031 §2, §4)
let bridgeCmdId;
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
    id: instanceId, // ADR 0031 §2: the recorded instance id, not the name
    description: "Reprove #135 prototype Vercel Sandbox",
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
      cmdIds.push(done.cmdId);
      return { exitCode: done.exitCode ?? -1, stdout: await done.stdout(), stderr: await done.stderr() };
    },
    spawn: async ({ command, workingDirectory, env }) => {
      counters.spawns++;
      if (!/\/bridge\.mjs'? --workdir /u.test(command)) throw new Error(`unexpected spawn: ${command.slice(0, 80)}`);
      // ADR 0031 §4: the bridge is launched with runCommand({ sudo: true, env }), never a SandboxUser handle.
      const cmd = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], cwd: workingDirectory ?? WORK, env, sudo: true, detached: true });
      bridgeCmdId = cmd.cmdId;
      cmdIds.push(cmd.cmdId);
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

// ---------------------------------------------------------------- the run
async function main() {
  const name = `p135-${Date.now().toString(36)}`;
  const passId = `pass-${name}`;
  log("run", { name, passId, model: MODEL, tokenSha8, tokenLength: TOKEN.length });

  const sandbox = await Sandbox.create({
    ...creds, name, persistent: false, ports: [PORT], timeout: 20 * 60_000,
    networkPolicy: { allow: { "registry.npmjs.org": [] } },
  });
  const instanceId = sandbox.currentSession().sessionId;
  log("created", { instanceId, domain: sandbox.domain(PORT) });
  try {
    await prove(sandbox, name, passId, instanceId);
  } finally {
    await sandbox.stop().catch((e) => log("stop failed", String(e)));
    log("stopped", name);
    writeFileSync(here(`./out/${name}.json`), safe(JSON.stringify(record, null, 2)));
  }
}

async function prove(sandbox, name, passId, instanceId) {
  log("image facts", await run(sandbox, [
    "echo default_user=$(id -un):$(id -gn) uid=$(id -u)",
    "cat /etc/os-release | grep -E '^(ID|VERSION_ID)='",
    "echo node=$(node --version) setpriv=$(command -v setpriv) pnpm=$(command -v pnpm)",
    "stat -c '%U:%G %u:%g %a %n' /vercel /usr/local/bin $(command -v node)",
    "getent passwd 2000 || echo uid2000=free",
  ].join("; ")));

  // Install the image as root: pinned bootstrap, patched bridge, two-stage wrapper, the Reviewer user.
  const files = imageFiles();
  await sandbox.writeFiles([
    ...files.map((f) => ({ path: `/tmp/reprove-codex-src/${f.path}`, content: Buffer.from(f.content) })),
    ...proofFiles.map((f) => ({ path: `/tmp/reprove-proof-src/${f.path.split("/").pop()}`, content: Buffer.from(f.content) })),
    { path: `/tmp/ws-src/app.js`, content: Buffer.from("export const add = (a, b) => a - b;\n") },
  ]);
  const install = await run(sandbox, [
    "set -e",
    "useradd -u 2000 -U -M -d /home/reviewer -s /bin/sh reviewer",
    "install -d -o reviewer -g reviewer -m 0700 /home/reviewer /home/reviewer/.codex",
    "mkdir -p /opt/reprove/codex /opt/reprove-proof",
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
    `mkdir -p ${WS} && cp /tmp/ws-src/app.js ${WS}/ && chown -R reviewer:reviewer ${WS}`,
    "rm -rf /tmp/reprove-codex-src /tmp/reprove-proof-src /tmp/ws-src",
    "/opt/reprove/codex/node_modules/.pnpm/node_modules/.bin/codex --version",
    `stat -c '%U:%G %a %n' ${WORK}/.agent-runs ${WS} /home/reviewer /home/reviewer/.codex /opt/reprove/codex/reprove-codex /opt/reprove/codex/bridge.mjs`,
  ].join(" && "), { sudo: true });
  log("install", install);
  if (install.exitCode !== 0) throw new Error("install failed");

  log("reviewer baseline", await asReviewer(sandbox, ["sh", "-c", "id; sudo -n true 2>&1; echo sudo_exit=$?"]));
  // no_new_privs alone makes sudo fail, so check sudoers separately: the Reviewer must have no rule at all.
  log("reviewer sudoers", await run(sandbox, "sudo -l -U reviewer 2>&1; echo '--- sudoers.d'; for f in /etc/sudoers.d/*; do echo \"$f: $(grep -v '^#' \"$f\" | tr '\\n' ' ')\"; done", { sudo: true }));

  // ADR 0031 §6: the patched bridge refuses a missing or malformed token before binding.
  log("bridge refusal", (await run(sandbox, "sh /opt/reprove-proof/bridge-refusal.sh", { sudo: true })).stdout.split("\n"));

  // ADR 0031 §2: the session id is the recorded instance id, stable across reattach by name.
  const again = await Sandbox.get({ ...creds, name });
  log("session identity", { recorded: instanceId, reattachedByName: again.currentSession().sessionId, stable: again.currentSession().sessionId === instanceId });

  // doStart launches the Pass's bridge; mintBridgeToken returns the already-committed token.
  let minted = 0;
  const harness = createCodex({
    model: MODEL,
    reasoningEffort: "low",
    auth: { OPENAI_API_KEY },
    webSearch: false,
    codexConfig: { project_doc_max_bytes: 0, "skills.include_instructions": false },
    mintBridgeToken: (sandboxId) => {
      if (sandboxId !== instanceId) throw new Error("mintBridgeToken: not the recorded instance");
      if (minted++ > 0) throw new Error("mintBridgeToken: a continuing Slice spawns nothing");
      return TOKEN;
    },
  });
  const { io, counters } = hostedSession(again, instanceId);
  const session = await harness.doStart({ sessionId: passId, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all" });
  log("doStart", { isResume: session.isResume, counters: { ...counters }, minted });

  // Find the bridge (a named process), then run every §7 check against it while idle.
  const pids = await run(sandbox, "for p in $(pgrep -f '^(sh -c )?node [^ ]*/bridge[.]mjs.? --workdir'); do echo \"$p $(cat /proc/$p/comm) uid=$(awk '/^Uid/{print $2}' /proc/$p/status) ppid=$(awk '/^PPid/{print $2}' /proc/$p/status)\"; done", { sudo: true });
  const procs = pids.stdout.split("\n").filter(Boolean).map((l) => l.split(" "));
  const bridgePid = procs.find((p) => p[1] === "node" || p[1] === "MainThread")?.[0] ?? procs.at(-1)?.[0];
  log("bridge processes", { lines: procs.map((p) => p.join(" ")), bridgePid });

  const idle = await asReviewer(sandbox, ["sh", "/opt/reprove-proof/reviewer-idle.sh", passId, ...procs.map((p) => p[0])]);
  log("reviewer checks (idle bridge)", { exitCode: idle.exitCode, facts: kv(idle.stdout), raw: idle.stdout.split("\n"), stderr: idle.stderr });

  const scanIdle = JSON.parse((await run(sandbox, `node /opt/reprove-proof/scan.mjs ${bridgePid}`, { sudo: true })).stdout);
  log("host scan (idle bridge)", summarizeScan(scanIdle));

  const publicUrl = `${sandbox.domain(PORT).replace(/^https:/, "wss:")}/`;
  log("public route (idle bridge)", {
    absent: await wsProbe(publicUrl),
    empty: await wsProbe(`${publicUrl}?agent_bridge_token=`),
    wrong: await wsProbe(`${publicUrl}?agent_bridge_token=${randomBytes(32).toString("hex")}`),
  });

  // doPromptTurn: one real Codex tool call reports the Reviewer's view after the wrapper.
  const events = [];
  let text = "";
  const control = await session.doPromptTurn({
    prompt: "Run exactly this one shell command, once, and nothing else: `sh /opt/reprove-proof/tool-check.sh`. Then answer with the JSON schema, putting the command's complete standard output in `output`.",
    skills: [],
    tools: [],
    responseFormat: { type: "json", schema: { type: "object", additionalProperties: false, required: ["output"], properties: { output: { type: "string" } } } },
    emit: (e) => {
      events.push({ type: e.type, toolName: e.toolName, usage: e.usage ?? e.totalUsage });
      if (e.type === "text-delta") text += e.delta;
    },
  });
  // While the tool call sleeps, scan host-side so the live Codex process is in the table.
  let scanTurn = null;
  for (let i = 0; i < 240 && !scanTurn; i++) {
    const seen = await run(sandbox, "test -f /tmp/p135-tool-check.txt && echo yes || echo no", { sudo: true });
    if (seen.stdout === "yes") scanTurn = JSON.parse((await run(sandbox, `node /opt/reprove-proof/scan.mjs ${bridgePid}`, { sudo: true })).stdout);
    else await new Promise((r) => setTimeout(r, 500));
  }
  const result = await control.done;
  log("turn", {
    finish: result ?? null,
    eventTypes: events.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] ?? 0) + 1 }), {}),
    toolNames: [...new Set(events.map((e) => e.toolName).filter(Boolean))],
    usage: events.filter((e) => e.usage).map((e) => e.usage),
    answerChars: text.length,
  });
  log("host scan (during the tool call)", scanTurn ? summarizeScan(scanTurn) : "tool check never ran");
  const toolFile = await run(sandbox, "cat /tmp/p135-tool-check.txt", { sudo: true });
  log("tool call view (from the Reviewer's tool command)", { facts: kv(toolFile.stdout), raw: toolFile.stdout.split("\n") });

  // The ubuntu file API reads back what the root bridge wrote inside the 0700 .agent-runs.
  const dir = `${WORK}/.agent-runs/${passId}/bridge`;
  const meta = await again.readFileToBuffer({ path: `${dir}/bridge-meta.json` }).catch((e) => ({ error: String(e) }));
  const eventLog = await again.readFileToBuffer({ path: `${dir}/event-log.ndjson` }).catch((e) => ({ error: String(e) }));
  log("file API readback", {
    bridgeMeta: Buffer.isBuffer(meta) ? { bytes: meta.length, state: JSON.parse(meta.toString()).state ?? null, keys: Object.keys(JSON.parse(meta.toString())) } : meta,
    eventLog: Buffer.isBuffer(eventLog) ? { bytes: eventLog.length, lines: eventLog.toString().trim().split("\n").length } : eventLog,
    tokenInEitherFile: [meta, eventLog].some((b) => Buffer.isBuffer(b) && b.toString().includes(TOKEN)),
    ownership: (await run(sandbox, `stat -c '%U:%G %a %n' ${WORK}/.agent-runs ${WORK}/.agent-runs/${passId} ${dir} ${dir}/*`, { sudo: true })).stdout.split("\n"),
  });

  // Positive control: the correct token over the public route is accepted, so the 1008s above mean refusal.
  log("public route control (correct token)", await wsProbe(`${publicUrl}?agent_bridge_token=${TOKEN}`));

  log("command history", await historyCheck(instanceId));
}

function summarizeScan(scan) {
  const interesting = scan.processes.filter((p) => p.tokenInCmdline || p.tokenInEnviron || /node|codex|setpriv|sh|reprove/u.test(p.comm));
  return {
    tokenMatchesHost: scan.tokenSha8 === tokenSha8,
    tokenLength: scan.tokenLength,
    processesScanned: scan.processes.length,
    tokenInAnyCmdline: scan.processes.filter((p) => p.tokenInCmdline).map((p) => `${p.pid} ${p.comm}`),
    tokenInEnviron: scan.processes.filter((p) => p.tokenInEnviron).map((p) => `${p.pid} ${p.comm} uid=${p.uid}`),
    nonRootWithToken: scan.processes.filter((p) => p.uid !== 0 && (p.tokenInEnviron || p.tokenInCmdline)).length,
    tree: interesting.map((p) => `${p.pid}<${p.ppid} uid=${p.uid} uids(r/e/s/fs)=${p.uids} nnp=${p.noNewPrivs} ${p.comm} | ${p.argv} | bridgeVars=${p.bridgeVarNames?.join(",") ?? "?"}`),
  };
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "stop") await (await Sandbox.get({ ...creds, name: arg })).stop();
else await main();
