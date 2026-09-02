import { protocolVersion } from "@reprove/protocol/v1";
import { composedFrom } from "@reprove/worker-core";

export const packageName = "@reprove/worker" as const;

/** Shell. The self-hosted lifecycle speaks exactly one protocol version. */
export const speaks = {
  protocolVersion,
  workerCore: composedFrom,
} as const;
