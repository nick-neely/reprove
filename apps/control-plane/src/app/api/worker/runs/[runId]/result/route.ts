/**
 * `POST /api/worker/runs/:runId/result`, which is where a Worker's Result
 * meets the boundary that decides whether it counts.
 *
 * The Worker is always the HTTP client and the control plane always the server
 * ([ADR 0006](../../../../../../../../../docs/adr/0006-worker-protocol.md)), so
 * this is an outbound request from the Worker like every other message in the
 * protocol. What makes it different from the claim beside it is that
 * Acceptance is the **stale-result boundary**: a Run that is terminal or
 * superseded rejects a later Result however the Worker behaves, so a Worker
 * that ignores a cancel, loses its network, or returns from a partition
 * holding a Run that was declared lost twenty minutes earlier cannot change
 * that Run's outcome.
 *
 * Like the routes beside it, this file is wiring and nothing else: the
 * ordering, the compatibility window, the schema validation, the conditional
 * UPDATE and the Findings all live in `@reprove/control-plane`, because
 * [ADR 0010](../../../../../../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids this app from depending on a Postgres driver at all.
 *
 * A composition that has not succeeded answers `503` rather than `401`. A
 * Worker told its credential is bad stops and asks for an operator; a Worker
 * told the control plane is unavailable holds its Result and submits again,
 * which is the correct behaviour while a deployment is being repaired.
 */
import type { ControlPlane } from "@reprove/control-plane";
import { WORKER_RESULT_STATUS } from "@reprove/control-plane";
import { controlPlane } from "@reprove/control-plane-workflow";

/** Node, not Edge: the control plane opens a Postgres connection pool. */
export const runtime = "nodejs";

/** Every submission is a conditional write; nothing here is cacheable. */
export const dynamic = "force-dynamic";

export const POST = async (
  request: Request,
  context: { params: Promise<{ runId: string }> }
): Promise<Response> => {
  let plane: ControlPlane;
  try {
    plane = await controlPlane();
  } catch {
    return Response.json(
      {
        status: WORKER_RESULT_STATUS.unavailable,
        reason: "the control plane is not serving",
      },
      { status: WORKER_RESULT_STATUS.unavailable }
    );
  }
  const { runId } = await context.params;
  return await plane.handleWorkerResult(request, runId);
};
