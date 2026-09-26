// PROTOTYPE for #135. Loopback connections with tokens the Reviewer could guess; each must close with 1008.
import { randomBytes } from "node:crypto";
import WebSocket from "/opt/reprove/codex/node_modules/ws/wrapper.mjs";
const wrong = randomBytes(32).toString("hex");
const cases = {
  absent: "",
  empty: "?agent_bridge_token=",
  malformed: "?agent_bridge_token=abc",
  wrong: `?agent_bridge_token=${wrong}`,
  wrongUpper: `?agent_bridge_token=${wrong.toUpperCase()}`,
};
for (const [name, query] of Object.entries(cases)) {
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.argv[2] ?? 3000}/${query}`);
    let messages = 0;
    const timer = setTimeout(() => { ws.terminate(); resolve({ close: "timeout", messages }); }, 5000);
    ws.on("message", () => { messages++; });
    ws.on("close", (code) => { clearTimeout(timer); resolve({ close: code, messages }); });
    ws.on("error", (error) => { clearTimeout(timer); resolve({ close: `error:${error.code ?? error.message}`, messages }); });
  });
  console.log(`ws[${name}] close=${result.close} messages=${result.messages}`);
}
