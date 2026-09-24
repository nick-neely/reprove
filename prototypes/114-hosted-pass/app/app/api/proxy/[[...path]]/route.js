// PROTOTYPE for #114. The broker: ADR 0021 §4-§6 behind an unconditional forwardURL.
import { defineSandboxProxy } from "@vercel/sandbox/proxy";
import { decodeJwt } from "jose";
import { q, tx } from "../../../../lib/db.js";

export const runtime = "nodejs";
export const maxDuration = 800;
const UPSTREAM_CEILING_MS = 5 * 60_000;
const BODY_CAP = 4 * 1024 * 1024;

const deny = (status, reason) => new Response(JSON.stringify({ error: reason }), { status, headers: { "content-type": "application/json" } });

async function reject(binding, reason, meta) {
  if (binding) await q("update binding set rejections = rejections || $2::jsonb where name = $1", [binding, JSON.stringify([{ at: new Date(), reason }])]);
  else console.log(JSON.stringify({ proxyRejectNoBinding: reason, meta }));
  return deny(403, reason);
}

async function handle(request, meta, rawClaims) {
  const url = new URL(request.url);
  const t0 = Date.now();
  // Admission: one serialized transaction on the Binding row.
  const verdict = await tx(async (c) => {
    const { rows: [b] } = await c.query("select b.*, p.status as pass_status, p.deadline from binding b join pass p on p.id = b.pass_id where b.name = $1 for update of b", [meta.sandboxName]);
    if (!b) return { reason: "unknown_binding" };
    const fail = (reason) => ({ reason, binding: b.name });
    if (meta.teamId !== process.env.PROTO_TEAM_ID || meta.projectId !== process.env.PROTO_PROJECT_ID) return fail("foreign_project");
    if (b.sandbox_id !== meta.sandboxId) return fail("sandbox_id_mismatch");
    if (b.revoked) return fail("revoked");
    if (b.pass_status !== "executing" || new Date(b.deadline) < new Date()) return fail("pass_not_live");
    if (url.origin !== b.origin) return fail("origin");
    const rule = b.rules.find((r) => r.method === request.method && url.pathname.startsWith(r.pathPrefix));
    if (!rule) return fail("method_path");
    if (!b.placeholder || request.headers.get("authorization") !== `Bearer ${b.placeholder}`) return fail("placeholder");
    if (b.request_count >= b.request_cap) return fail("request_cap");
    const { rows: [{ n }] } = await c.query("select count(*)::int n from admission where binding = $1 and released_at is null and expires_at > now()", [b.name]);
    if (n >= b.concurrency_cap) return fail("concurrency_cap");
    await c.query("update binding set request_count = request_count + 1 where name = $1", [b.name]);
    const { rows: [a] } = await c.query(
      "insert into admission (binding, expires_at, method, path, claims) values ($1, now() + $2 * interval '1 millisecond', $3, $4, $5) returning id",
      [b.name, UPSTREAM_CEILING_MS, request.method, url.pathname, JSON.stringify(rawClaims)]);
    return { ok: true, binding: b, admission: a.id };
  });
  if (!verdict.ok) return reject(verdict.binding, verdict.reason, meta);
  const { binding, admission } = verdict;

  let body = request.body;
  let bytes = 0;
  if (request.body) {
    const buf = new Uint8Array(await new Response(request.body).arrayBuffer());
    bytes = buf.byteLength;
    if (bytes > BODY_CAP) return release(admission, "body_cap", deny(413, "body_cap"));
    body = buf;
    // A probe Binding inspects and persists before forwarding; failure to persist rejects.
    if (binding.kind === "probe") {
      const seen = new TextDecoder().decode(buf).includes(binding.canary);
      try { await q("insert into observation (binding, bytes, canary_seen) values ($1, $2, $3)", [binding.name, bytes, seen]); }
      catch { return release(admission, "observation_failed", deny(503, "observation_failed")); }
      if (seen) return release(admission, "canary", deny(403, "canary"));
    }
  }
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${process.env.OPENAI_API_KEY}`);
  headers.delete("host"); headers.delete("content-length");
  const abort = AbortSignal.timeout(UPSTREAM_CEILING_MS);
  let upstream;
  try {
    upstream = await fetch(url, { method: request.method, headers, body, signal: abort, redirect: "manual" });
  } catch (e) {
    return release(admission, `upstream_error:${e.name}`, deny(502, "upstream_error"));
  }
  await q("update admission set req_bytes = $2, status = $3, upstream_ms = $4 where id = $1", [admission, bytes, upstream.status, Date.now() - t0]);
  // Release when the response body finishes, is cancelled or errors - not when we return.
  let released = false;
  const done = (reason) => { if (!released) { released = true; q("update admission set released_at = now(), release_reason = $2 where id = $1", [admission, reason]).catch(() => {}); } };
  const stream = upstream.body?.pipeThrough(new TransformStream({ flush() { done("complete"); } }));
  const reader = stream?.getReader();
  const out = reader ? new ReadableStream({
    async pull(ctrl) { try { const { done: d, value } = await reader.read(); if (d) { ctrl.close(); done("complete"); } else ctrl.enqueue(value); } catch (e) { done("error"); ctrl.error(e); } },
    cancel() { done("cancelled"); reader.cancel().catch(() => {}); },
  }) : null;
  if (!out) done("no_body");
  const h = new Headers(upstream.headers); h.delete("content-encoding"); h.delete("content-length");
  return new Response(out, { status: upstream.status, headers: h });
}

async function release(admission, reason, response) {
  await q("update admission set released_at = now(), release_reason = $2 where id = $1", [admission, reason]);
  return response;
}

const invalid = (request, error) => { console.log(JSON.stringify({ proxyInvalid: error.message })); return deny(403, "invalid_token"); };

async function entry(request) {
  // Record the raw claims (never the token) so the prototype can report what the token names.
  let claims = null;
  try { const token = request.headers.get("vercel-sandbox-oidc-token"); claims = token ? decodeJwt(token) : null; } catch {}
  return defineSandboxProxy((req, meta) => handle(req, meta, claims), invalid)(request);
}
export { entry as GET, entry as POST, entry as PUT, entry as DELETE, entry as PATCH, entry as HEAD };
