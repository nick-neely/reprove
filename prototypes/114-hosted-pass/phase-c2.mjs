// PROTOTYPE for #114. Phase C follow-ups: pip after the trailing-slash fix, a non-Vercel unreachable
// forwardURL, and firewall-native method enforcement with `response` rules (SDK 3.5.0) instead of a proxy.
import pg from "pg";
import { Sandbox } from "@vercel/sandbox";
import { ledger, log, vercelCredentials } from "./lib.mjs";
const creds = vercelCredentials();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace("sslmode=require", "sslmode=verify-full") });
await db.connect();
const EGRESS = "https://reprove-proto-114.vercel.app/api/egress";
const name = `p114-egress2-${Date.now().toString(36)}`;
const sandbox = await Sandbox.create({ ...creds, name, persistent: false, timeout: 15 * 60_000,
  networkPolicy: { allow: { "pypi.org": [{ forwardURL: EGRESS }], "files.pythonhosted.org": [{ forwardURL: EGRESS }] } } });
ledger({ kind: "sandbox", name, phase: "c2" });
await db.query("insert into egress_auth (name, sandbox_id) values ($1, $2)", [name, sandbox.currentSession().sessionId]);
const sh = async (label, command) => { const t0 = Date.now(); const r = await sandbox.runCommand({ cmd: "sh", args: ["-c", command] }); const out = (await r.output("both")).trim(); log(label, { ms: Date.now() - t0, exitCode: r.exitCode, out: out.slice(-600) }); return Date.now() - t0; };
try {
  await sh("pip download via egress after the fix", "python3 -m pip download --no-deps -q -d /tmp/pip requests 2>&1 | tail -2; ls /tmp/pip");
  log("pip requests", (await db.query("select host, left(path, 70) path, status, location from egress_log where name = $1 order by id", [name])).rows);
  for (const target of ["https://p114-unreachable.invalid/x", "https://10.255.255.1/x", "http://reprove-proto-114.vercel.app/api/egress"]) {
    try { await sandbox.update({ networkPolicy: { allow: { "registry.npmjs.org": [{ forwardURL: target }] } } });
      await sh(`forwardURL ${target}`, "curl -s -m 30 -o /tmp/o -w 'status=%{http_code}\\n' https://registry.npmjs.org/is-number; echo exit=$?; head -c 160 /tmp/o; echo");
    } catch (e) { log(`forwardURL ${target}: update rejected`, e.message.slice(0, 300)); }
  }
  // Firewall-native: GET/HEAD allowed straight through, everything else answered 403 by the firewall itself.
  const native = (h) => [{ match: { method: ["GET", "HEAD"] } }, { response: { statusCode: 403, body: "denied by policy", contentType: "text/plain" } }];
  const t0 = Date.now();
  try {
    await sandbox.update({ networkPolicy: { allow: { "registry.npmjs.org": native() } } });
    log("policy accepted; read back", (await Sandbox.get({ ...creds, name })).networkPolicy);
  } catch (e) { log("response-rule policy rejected", e.message.slice(0, 400)); }
  log("update ms", Date.now() - t0);
  await sh("GET allowed by a match-only rule?", "curl -s -o /dev/null -w '%{http_code}\\n' https://registry.npmjs.org/is-number");
  await sh("POST answered by the firewall's response rule?", "curl -s -w ' %{http_code}\\n' -X POST https://registry.npmjs.org/-/v1/login -d '{}'");
  await sh("npm install under firewall-native method rules", "mkdir -p /tmp/n && cd /tmp/n && npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts --cache /tmp/cache-n typescript@5 eslint@9 vitest@3 2>&1 | tail -2");
} finally {
  await db.query("update egress_auth set revoked = true where name = $1", [name]);
  await sandbox.stop().catch(() => {}); await db.end();
}
