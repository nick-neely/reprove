// PROTOTYPE for #114. Starts one hosted Pass.
import { start } from "workflow/api";
import { passWorkflow } from "../../../workflows/pass.js";
export async function POST(request) {
  if (request.headers.get("x-proto-secret") !== process.env.PROTO_SECRET) return new Response("no", { status: 401 });
  const body = await request.json();
  const input = {
    passId: body.passId ?? `p114-${Date.now().toString(36)}`,
    model: body.model ?? "gpt-6-luna", sliceMs: body.sliceMs ?? 40_000, deadlineMinutes: body.deadlineMinutes ?? 15,
    probe: body.probe ?? true, killAfterSlice1: body.killAfterSlice1 ?? false, mode: body.mode, baseSha: body.baseSha, headSha: body.headSha, effort: body.effort,
  };
  const run = await start(passWorkflow, [input]);
  return Response.json({ runId: run.runId, input });
}
