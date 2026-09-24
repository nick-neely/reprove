// PROTOTYPE for #114. ADR 0027's egress route: separate from the Provider route, never injects
// credentials, GET/HEAD only plus POST to git-upload-pack, never follows redirects, pins DNS.
import { defineSandboxProxy } from "@vercel/sandbox/proxy";
import { lookup } from "node:dns/promises";
import { Agent, fetch as ufetch } from "undici";
import { q } from "../../../../lib/db.js";

export const runtime = "nodejs";
export const maxDuration = 800;
const HOSTS = new Set(["registry.npmjs.org", "github.com", "codeload.github.com", "pypi.org", "files.pythonhosted.org", "objects.githubusercontent.com"]);
const DROP = ["authorization", "cookie", "proxy-authorization", "host", "content-length", "connection"];

async function handle(request, meta, raw) {
  const t0 = Date.now();
  const url = new URL(request.url);
  const row = { name: meta.sandboxName, host: url.hostname, method: request.method, path: url.pathname.slice(0, 300), host_header: raw.hostHeader, fwd_headers: raw.fwd };
  const done = async (verdict, extra = {}) => { await q(
    "insert into egress_log (name, host, method, path, verdict, status, location, req_bytes, resp_bytes, ms, pinned_ip, host_header, fwd_headers) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [row.name, row.host, row.method, row.path, verdict, extra.status ?? null, extra.location ?? null, extra.reqBytes ?? null, extra.respBytes ?? null, Date.now() - t0, extra.ip ?? null, row.host_header, row.fwd_headers]).catch(() => {}); };
  if (meta.teamId !== process.env.PROTO_TEAM_ID || meta.projectId !== process.env.PROTO_PROJECT_ID) { await done("foreign_project"); return new Response("denied", { status: 403 }); }
  const { rows: [a] } = await q("select * from egress_auth where name = $1", [meta.sandboxName]);
  if (!a || a.revoked || a.sandbox_id !== meta.sandboxId) { await done("no_authorization"); return new Response("denied", { status: 403 }); }
  if (!HOSTS.has(url.hostname) || url.protocol !== "https:" || (url.port && url.port !== "443")) { await done("host"); return new Response("denied", { status: 403 }); }
  const upload = request.method === "POST" && url.hostname === "github.com" && url.pathname.endsWith("/git-upload-pack");
  if (!["GET", "HEAD"].includes(request.method) && !upload) { await done("method"); return new Response("denied", { status: 403 }); }
  let body, reqBytes = 0;
  if (upload) { const b = new Uint8Array(await request.arrayBuffer()); reqBytes = b.byteLength; body = b; }
  const headers = new Headers(request.headers);
  for (const h of DROP) headers.delete(h);
  // Pin: resolve once, connect to that address, keep SNI and Host as the name.
  const { address } = await lookup(url.hostname, { family: 4 });
  const agent = new Agent({ connect: { lookup: (_h, _o, cb) => cb(null, [{ address, family: 4 }]), servername: url.hostname } });
  let upstream;
  try {
    upstream = await ufetch(url, { method: request.method, headers, body, redirect: "manual", dispatcher: agent, signal: AbortSignal.timeout(120_000) });
  } catch (e) { await done(`upstream_error:${e.cause?.code ?? e.name}`, { ip: address, reqBytes }); return new Response("upstream error", { status: 502 }); }
  const location = upstream.headers.get("location");
  let respBytes = 0;
  const counted = upstream.body ? upstream.body.pipeThrough(new TransformStream({
    transform(chunk, c) { respBytes += chunk.byteLength; c.enqueue(chunk); },
    flush() { done("allowed", { status: upstream.status, location, reqBytes, respBytes, ip: address }); },
  })) : (done("allowed", { status: upstream.status, location, reqBytes, respBytes: 0, ip: address }), null);
  const h = new Headers(upstream.headers); h.delete("content-encoding"); h.delete("content-length"); h.delete("transfer-encoding");
  return new Response(counted, { status: upstream.status, headers: h });
}

async function entry(request) {
  // What the firewall forwards: the Host our Function sees, and the vercel-forwarded-* values.
  const fwd = [...request.headers.entries()].filter(([k]) => k.startsWith("vercel-forwarded")).map(([k, v]) => `${k}=${v}`).join(";");
  const raw = { hostHeader: request.headers.get("host"), fwd: `${fwd};auth=${request.headers.has("authorization") ? "present" : "absent"}` };
  return defineSandboxProxy((req, meta) => handle(req, meta, raw))(request);
}
export { entry as GET, entry as POST, entry as HEAD, entry as PUT, entry as DELETE, entry as PATCH };
