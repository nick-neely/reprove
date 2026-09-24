// PROTOTYPE for #114. ADR 0020 §6: can a fresh doPromptTurn follow an aborted turn on the same thread?
import { Sandbox } from "@vercel/sandbox";
import { createCodex } from "@ai-sdk/harness-codex";
import { ledger, log, vercelCredentials } from "./lib.mjs";
import { vercelSession } from "./vercel-session.mjs";
const creds = vercelCredentials();
const WORK = "/vercel/sandbox", WS = `${WORK}/ws`;
const name = `p114-abort-${Date.now().toString(36)}`;
const sandbox = await Sandbox.create({ ...creds, name, persistent: false, ports: [3000], timeout: 10 * 60_000, networkPolicy: { allow: { "registry.npmjs.org": [] } } });
ledger({ kind: "sandbox", name, phase: "abort" });
try {
  const recipe = await createCodex().getBootstrap();
  await sandbox.writeFiles(recipe.files.map((f) => ({ path: `${WORK}/${f.path}`, content: Buffer.from(f.content) })));
  for (const c of recipe.commands) await sandbox.runCommand({ cmd: "sh", args: ["-c", c.command], cwd: `${WORK}/${recipe.bootstrapDir}` });
  await sandbox.runCommand({ cmd: "sh", args: ["-c", `mkdir -p ${WS} && cd ${WS} && git init -q && echo 'secret-word: PERIWINKLE-7' > note.txt`] });
  const { io } = vercelSession(sandbox, { workDir: WORK, onRequestTransformations: async (entries) => {
    const allow = {}; for (const e of entries) (allow[e.match.host] ??= []).push({ match: { path: e.match.path, headers: e.match.headers }, transform: [{ headers: e.transform.headers }] });
    await sandbox.update({ networkPolicy: { allow } });
  } });
  const h = createCodex({ model: "gpt-6-luna", reasoningEffort: "low", auth: { OPENAI_API_KEY: process.env.OPENAI_API_KEY }, webSearch: false, codexConfig: { project_doc_max_bytes: 0 } });
  const session = await h.doStart({ sessionId: name, sandboxSession: io, sessionWorkDir: WS, permissionMode: "allow-all" });
  const events1 = [];
  const ac = new AbortController();
  const c1 = await session.doPromptTurn({ prompt: "Run `cat note.txt`, then run `sleep 60 && echo done`, then summarise.", skills: [], tools: [], abortSignal: ac.signal,
    emit: (e) => { events1.push(e.type); if (e.type === "tool-result") setTimeout(() => ac.abort(), 1500); } });
  const r1 = await c1.done.then((v) => ({ ok: v ?? null }), (e) => ({ error: `${e.name}: ${e.message}`.slice(0, 200) }));
  log("turn 1 (aborted)", { r1, events: events1.join(",") });
  const ask = async (sess, label) => {
    let text = ""; const events2 = []; let usage; const t0 = Date.now();
    try {
      const c2 = await sess.doPromptTurn({ prompt: "Without running any command: what secret word did the file you read earlier contain? Answer with just the word, or UNKNOWN.", skills: [], tools: [],
        emit: (e) => { events2.push(e.type); if (e.type === "text-delta") text += e.delta; if (e.type === "finish") usage = e.totalUsage; } });
      await c2.done;
      log(label, { ms: Date.now() - t0, text, contextIntact: text.includes("PERIWINKLE-7"), events: events2.join(","), usage });
      return true;
    } catch (e) { log(`${label} threw`, `${e.name}: ${e.message}`.slice(0, 300)); return false; }
  };
  await new Promise((r) => setTimeout(r, 3000));
  if (!(await ask(session, "same session after 3s"))) {
    const state = await session.doStop().catch((e) => { log("doStop threw", e.message); return null; });
    log("doStop state", state && { type: state.type, dataKeys: Object.keys(state.data ?? {}), threadId: state.data?.threadId });
    if (state) {
      const { io: io2, counters } = vercelSession(sandbox, { workDir: WORK, onRequestTransformations: async () => {} });
      const s2 = await h.doStart({ sessionId: name, sandboxSession: io2, sessionWorkDir: WS, permissionMode: "allow-all", resumeFrom: state });
      await ask(s2, "resumeFrom session");
      log("resume spawns", counters);
    }
  }
} finally { await sandbox.stop(); }
