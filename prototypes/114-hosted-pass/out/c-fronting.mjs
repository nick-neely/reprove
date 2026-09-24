import { Sandbox } from "@vercel/sandbox";
import { vercelCredentials, log, ledger } from "../lib.mjs";
const creds = vercelCredentials();
const deny = { response: { statusCode: 403, body: "denied by policy", contentType: "text/plain" } };
const B = { allow: { "registry.npmjs.org": [{ match: { method: ["GET", "HEAD"] }, transform: [{ headers: { "x-reprove-egress": "1" } }] }, deny] } };
const plain = { allow: { "registry.npmjs.org": [] } };
const s = await Sandbox.create({ ...creds, name: `p114-fronting-${Date.now().toString(36)}`, persistent: false, timeout: 300000, networkPolicy: B });
ledger({ kind: "sandbox", name: s.name, phase: "fronting" });
const sh = async (l, c) => { const r = await s.runCommand({ cmd: "sh", args: ["-c", c] }); log(l, (await r.output("both")).trim().slice(0, 400)); };
const probes = async (tag) => {
  // Cloudflare-fronted registry: ask for another Cloudflare-hosted site through the allowed SNI.
  await sh(`${tag}: Host=example.com via registry SNI`, "curl -s -m 15 -o /tmp/b -w 'http=%{http_code}\\n' https://registry.npmjs.org/ -H 'Host: example.com'; head -c 120 /tmp/b; echo");
  await sh(`${tag}: Host=www.cloudflare.com via registry SNI`, "curl -s -m 15 -o /tmp/b -w 'http=%{http_code}\\n' https://registry.npmjs.org/ -H 'Host: www.cloudflare.com'; head -c 120 /tmp/b; echo");
  await sh(`${tag}: SNI=example.com to a registry IP`, "ip=$(getent ahostsv4 registry.npmjs.org | head -1 | cut -d' ' -f1); curl -s -m 15 -o /dev/null -w 'http=%{http_code} exit=' --resolve example.com:443:$ip https://example.com/; echo $?");
};
try { await probes("B firewall-native"); await s.update({ networkPolicy: plain }); await probes("plain allow"); } finally { await s.stop(); }
