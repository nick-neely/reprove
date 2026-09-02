import { protocolVersion } from "@reprove/protocol/v1";
import { composedFrom } from "@reprove/worker-core";

export const packageName = "@reprove/worker-hosted" as const;

/**
 * Shell. The hosted lifecycle is doubly coupled - to the harness SDK through
 * `@reprove/worker-core`, and to Workflow's Vercel World - which is why it is
 * its own package and not a module inside the control plane (ADR 0010).
 */
export const drives = {
  protocolVersion,
  workerCore: composedFrom,
} as const;
