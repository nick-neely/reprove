// PROTOTYPE for #114. Firewall-native method enforcement (SDK 3.5.0 `response` rules), no proxy in the byte path.
import { Sandbox } from "@vercel/sandbox";
import { ledger, log, vercelCredentials } from "./lib.mjs";
const creds = vercelCredentials();
const name = `p114-native-${Date.now().toString(36)}`;
const deny = { response: { statusCode: 403, body: "denied by policy", contentType: "text/plain" } };
const policies = {
  A_denyListMethods: { allow: { "registry.npmjs.org": [{ match: { method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"] }, ...deny }] } },
  B_claimGetThenDeny: { allow: { "registry.npmjs.org": [{ match: { method: ["GET", "HEAD"] }, transform: [{ headers: { "x-reprove-egress": "1" } }] }, deny] } },
};
const sandbox = await Sandbox.create({ ...creds, name, persistent: false, timeout: 15 * 60_000, networkPolicy: "deny-all" });
ledger({ kind: "sandbox", name, phase: "c3" });
const sh = async (label, command) => { const t0 = Date.now(); const r = await sandbox.runCommand({ cmd: "sh", args: ["-c", command] }); const out = (await r.output("both")).trim(); log(label, { ms: Date.now() - t0, exitCode: r.exitCode, out: out.slice(-300) }); };
try {
  for (const [label, policy] of Object.entries(policies)) {
    try { await sandbox.update({ networkPolicy: policy }); } catch (e) { log(`${label} rejected`, e.message.slice(0, 300)); continue; }
    log(`${label} read back`, (await Sandbox.get({ ...creds, name })).networkPolicy);
    await sh(`${label}: GET`, "curl -s -m 20 -o /dev/null -w '%{http_code}\\n' https://registry.npmjs.org/is-number");
    await sh(`${label}: POST`, "curl -s -m 20 -w ' %{http_code}\\n' -X POST https://registry.npmjs.org/-/v1/login -d '{}'");
    await sh(`${label}: custom method FOO`, "curl -s -m 20 -w ' %{http_code}\\n' -X FOO https://registry.npmjs.org/is-number");
    await sh(`${label}: npm install`, `d=/tmp/${label} && mkdir -p $d && cd $d && npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts --cache $d-cache typescript@5 eslint@9 vitest@3 2>&1 | tail -1`);
  }
} finally { await sandbox.stop().catch(() => {}); }
