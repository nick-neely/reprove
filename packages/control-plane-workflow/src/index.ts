import { packageName as controlPlane } from "@reprove/control-plane";
import { protocolVersion } from "@reprove/protocol/v1";

export const packageName = "@reprove/control-plane-workflow" as const;

/**
 * Shell. A `'use step'` function compiles into a bundle whose module graph is
 * fixed at build time, so the layer that defines steps is the only layer that
 * can configure them - which is why this package exists (ADR 0014).
 */
export const orchestrates = {
  controlPlane,
  protocolVersion,
} as const;
