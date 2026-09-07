/**
 * `POST /api/worker/runs/claim`, which is the only way work reaches a
 * self-hosted Worker.
 *
 * The Worker is always the HTTP client and the control plane always the server
 * ([ADR 0006](../../../../../../../../docs/adr/0006-worker-protocol.md)), so a
 * daemon on a laptop needs no inbound port, no NAT traversal and no
 * certificate - and Reprove never learns its address.
 *
 * Like the webhook route beside it, this file is wiring and nothing else:
 * authentication, the compatibility window, the conditional UPDATE and the
 * `RunSpec` all live in `@reprove/control-plane`, because
 * [ADR 0010](../../../../../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids this app from depending on a Postgres driver at all.
 *
 * A composition that has not succeeded answers `503` rather than `401`. A
 * Worker told its credential is bad stops and asks for an operator; a Worker
 * told the control plane is unavailable backs off and polls again, which is the
 * correct behaviour while a deployment is being repaired.
 */
import type { ControlPlane } from "@reprove/control-plane";
import { WORKER_CLAIM_STATUS } from "@reprove/control-plane";
import { controlPlane } from "@reprove/control-plane-workflow";

/** Node, not Edge: the control plane opens a Postgres connection pool. */
export const runtime = "nodejs";

/** Every claim is a conditional write; nothing about this route is cacheable. */
export const dynamic = "force-dynamic";

export const POST = async (request: Request): Promise<Response> => {
  let plane: ControlPlane;
  try {
    plane = await controlPlane();
  } catch {
    return Response.json(
      {
        status: WORKER_CLAIM_STATUS.unavailable,
        reason: "the control plane is not serving",
      },
      { status: WORKER_CLAIM_STATUS.unavailable }
    );
  }
  return await plane.handleWorkerClaim(request);
};
