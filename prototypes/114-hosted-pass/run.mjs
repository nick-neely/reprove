// PROTOTYPE for #114. Start a hosted Pass on the deployment and poll until it ends.
// node run.mjs '{"probe":true,"killAfterSlice1":false,"sliceMs":40000}'
import { writeFileSync } from "node:fs";
import { loadEnv, sleep } from "./lib.mjs";
loadEnv();
const BASE = "https://reprove-proto-114.vercel.app";
const H = { "x-proto-secret": process.env.PROTO_SECRET, "content-type": "application/json" };
const body = JSON.parse(process.argv[2] ?? "{}");
const t0 = Date.now();
const started = await (await fetch(`${BASE}/api/start`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
console.log("started", started);
const pass = started.input.passId;
let last = "";
for (;;) {
  await sleep(10_000);
  const s = await (await fetch(`${BASE}/api/status?pass=${pass}&run=${started.runId}`, { headers: H })).json();
  const line = JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), run: s.run?.status, pass: s.pass?.[0]?.status, slices: s.slices?.map((x) => `${x.n}:${x.kind}:${x.state}`), admissions: s.admissions?.length, sandboxes: s.sandboxes?.map((x) => `${x.name}:${x.state}`) });
  if (line !== last) console.log(line), (last = line);
  if (["completed", "failed", "cancelled"].includes(s.run?.status) || (Date.now() - t0) > 25 * 60_000) {
    writeFileSync(new URL(`./out/run-${pass}.json`, import.meta.url), JSON.stringify(s, null, 2));
    console.log("final written", `out/run-${pass}.json`, "wall s", Math.round((Date.now() - t0) / 1000));
    break;
  }
}
