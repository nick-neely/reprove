import { Sandbox } from "@vercel/sandbox";
import { vercelCredentials, log, ledger } from "../lib.mjs";
const creds = vercelCredentials();
const deny = { response: { statusCode: 403, body: "denied by policy", contentType: "text/plain" } };
const policy = { allow: {
  "registry.npmjs.org": [{ match: { method: ["GET", "HEAD"], path: { startsWith: "/" } }, transform: [{ headers: { "x-reprove-egress": "1" } }] }, deny],
  "api.openai.com": [{ forwardURL: "https://reprove-proto-114.vercel.app/api/proxy" }],
  "github.com": [{ transform: [{ headers: { authorization: "Basic c2VjcmV0" } }] }],
} };
const s = await Sandbox.create({ ...creds, name: `p114-readback-${Date.now().toString(36)}`, persistent: false, timeout: 120000, networkPolicy: policy });
ledger({ kind: "sandbox", name: s.name, phase: "readback" });
try {
  log("getter", s.networkPolicy);
  log("Sandbox.get getter", (await Sandbox.get({ ...creds, name: s.name })).networkPolicy);
  log("listSessions raw networkPolicy", (await s.listSessions()).sessions[0].networkPolicy);
} finally { await s.stop(); }
