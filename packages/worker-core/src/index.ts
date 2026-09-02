import { packageName as adapters } from "@reprove/adapters";
import { protocolVersion } from "@reprove/protocol/v1";
import { packageName as sandboxContainer } from "@reprove/sandbox-container";

export const packageName = "@reprove/worker-core" as const;

/**
 * Shell. Exercising all three permitted edges through their package exports
 * makes ADR 0010's matrix row a compiled fact rather than a declaration.
 */
export const composedFrom = {
  adapters,
  protocolVersion,
  sandboxContainer,
} as const;
