// PROTOTYPE for #114. Everything the database knows about one Pass.
import { getRun } from "workflow/api";
import { q } from "../../../lib/db.js";
export async function GET(request) {
  if (request.headers.get("x-proto-secret") !== process.env.PROTO_SECRET) return new Response("no", { status: 401 });
  const u = new URL(request.url);
  const pass = u.searchParams.get("pass");
  const out = {};
  for (const [k, sql] of Object.entries({
    pass: "select * from pass where id = $1",
    sandboxes: "select * from sandbox_record where pass_id = $1",
    bindings: "select name, kind, sandbox_id, request_count, revoked, rejections, placeholder is not null as has_placeholder from binding where pass_id = $1",
    admissions: "select a.* from admission a join binding b on b.name = a.binding where b.pass_id = $1 order by a.id",
    observations: "select o.* from observation o join binding b on b.name = o.binding where b.pass_id = $1",
    slices: "select pass_id, n, kind, state, cursor is not null as has_cursor, outcome, facts, started_at, ended_at from slice where pass_id = $1 order by n",
  })) out[k] = (await q(sql, [pass])).rows;
  const runId = u.searchParams.get("run");
  if (runId) { const run = getRun(runId); out.run = { status: await run.status, ...(await run.status) === "completed" ? { returnValue: await run.returnValue } : {} }; }
  return Response.json(out);
}
