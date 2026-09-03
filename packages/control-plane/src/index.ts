import { protocolVersion } from "@reprove/protocol/v1";

export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";

export * from "./db/index.js";

export const packageName = "@reprove/control-plane" as const;

/**
 * Shell. The control plane validates every Worker submission against the same
 * authoritative schema the Worker emits with, because a hostile or buggy Worker
 * can skip its own code and POST arbitrary bytes (ADR 0010).
 */
export const accepts = {
  protocolVersion,
} as const;
