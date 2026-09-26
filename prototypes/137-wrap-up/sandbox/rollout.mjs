// PROTOTYPE for #137. Host-side, as root: what Codex recorded in its rollout files for the Reviewer.
// Prints thread ids, per-response token_count usage, turn boundaries, errors and the last agent message.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const root = "/home/reviewer/.codex/sessions";
const files = [];
const walk = (d) => { let es = []; try { es = readdirSync(d); } catch { return; } for (const e of es) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e.startsWith("rollout-")) files.push(p); } };
walk(root);
const out = [];
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const r = { file: f.split("/").pop(), bytes: statSync(f).size, lines: lines.length, sessionIds: [], tokenCounts: [], turns: [], compactions: 0, contextWindow: null };
  for (const l of lines) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const p = j.payload ?? {};
    if (j.type === "session_meta") r.sessionIds.push(p.id ?? p.meta?.id);
    if (j.type === "compacted" || p.type === "context_compacted") r.compactions++;
    if (j.type === "turn_context") r.turns.push({ at: j.timestamp, kind: "turn_context" });
    if (p.type === "task_started" || p.type === "turn_started") r.turns.push({ at: j.timestamp, kind: p.type });
    if (p.type === "task_complete" || p.type === "turn_complete" || p.type === "turn_aborted") r.turns.push({ at: j.timestamp, kind: p.type });
    if (p.type === "agent_message" && typeof p.message === "string") r.lastAgentMessage = { at: j.timestamp, text: p.message.slice(0, 20000) };
    if (j.type === "response_item" && p.type === "message" && p.role === "assistant") {
      const text = (p.content ?? []).map((c) => c.text ?? "").join("");
      if (text) r.lastAgentMessage = { at: j.timestamp, text: text.slice(0, 20000) };
    }
    if (p.type === "error" || p.type === "stream_error") r.errors = [...(r.errors ?? []), { at: j.timestamp, type: p.type, message: String(p.message ?? "").slice(0, 200) }];
    if (p.type === "token_count" && p.info) {
      r.contextWindow = p.info.model_context_window ?? r.contextWindow;
      r.tokenCounts.push({ at: j.timestamp, last: p.info.last_token_usage, total: p.info.total_token_usage });
    }
  }
  out.push(r);
}
console.log(JSON.stringify(out));
