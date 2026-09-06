/**
 * `POST /api/github/webhook`, which is the App's single hook URL.
 *
 * This file is route wiring, which is all
 * [ADR 0010](../../../../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * leaves the app: the handler, the signature check, the envelope and the commit
 * all live in `@reprove/control-plane`, and the composition over the
 * environment lives in `@reprove/control-plane-workflow`, because
 * [ADR 0014](../../../../../../../docs/adr/0014-workflow-orchestration-seam.md)
 * gives that package all step configuration and a step cannot be configured by
 * the route that composed the deployment. The matrix in
 * `tools/verify-workspace.mjs` is what stops any of it accumulating here - this
 * app cannot import a Postgres driver, so there is no arrangement in which it
 * assembles a client of its own.
 *
 * The control plane the route reaches is composed **once per process**, on
 * first use, and a composition that throws is not memoized as a failure:
 * `controlPlane()` documents both. Until it succeeds every delivery gets a
 * non-2xx, which is ADR 0013's answer - the delivery stays manually
 * redeliverable rather than being acknowledged by a process that cannot store
 * it.
 *
 * What the composition hands a committed delivery to is the durable spine:
 * `start()` on the ingress workflow, whose step retry is ADR 0013's re-drive.
 * That is why this file says nothing about a kick - the route answers `200`
 * once the envelope is committed, and what happens next is the orchestration
 * package's.
 */
import type { ControlPlane } from "@reprove/control-plane";
import { WEBHOOK_STATUS } from "@reprove/control-plane";
import { controlPlane } from "@reprove/control-plane-workflow";

/** Node, not Edge: the control plane opens a Postgres connection pool. */
export const runtime = "nodejs";

/** Every delivery is a fresh write; nothing about this route is cacheable. */
export const dynamic = "force-dynamic";

export const POST = async (request: Request): Promise<Response> => {
  let plane: ControlPlane;
  try {
    plane = await controlPlane();
  } catch {
    // A composition that could not prove its tenant boundary, or a missing
    // secret. Nothing is acknowledged, so the delivery stays redeliverable -
    // which is ADR 0013's answer for a control plane that cannot store what it
    // was sent.
    return Response.json(
      {
        status: WEBHOOK_STATUS.notCommitted,
        reason: "the control plane is not serving",
      },
      { status: WEBHOOK_STATUS.notCommitted }
    );
  }
  return await plane.handleGitHubWebhook(request);
};
