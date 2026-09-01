import { z } from "zod";

/**
 * The integer a Worker advertises for this compatibility family (ADR 0006).
 * It is independent of the package version: `@reprove/protocol@2.7.0` does not
 * mean `protocolVersion = 2`.
 */
export const protocolVersion = 1 as const;

/**
 * Placeholder wire envelope. The v1 contract - Result, Finding, Evidence,
 * progress events, Refusal, enrollment, claim, lease, cancellation - arrives
 * with its own issue. Wire shapes stay plain JSON.
 */
export const envelopeSchema = z.object({
  protocolVersion: z.literal(protocolVersion),
});

export type Envelope = z.infer<typeof envelopeSchema>;
