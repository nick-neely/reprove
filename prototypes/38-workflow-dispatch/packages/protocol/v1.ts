// @proto38/protocol/v1 - the wire contract, zod only.
// Phase 0 exports exactly RunSpec, Result and Refusal (#32). No claim, lease,
// progress or cancellation message exists yet; those are control-plane state
// until an execution path needs them on the wire.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const RunSpecSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runId: z.string(),
  ownerId: z.number().int(),
  repositoryId: z.number().int(),
  pullRequestNumber: z.number().int(),
  baseSha: z.string(),
  headSha: z.string(),
  provenance: z.enum(['internal', 'external']),
  harness: z.enum(['codex', 'claude-code', 'opencode']),
  model: z.string(),
  strategy: z.literal('standard'),
  autonomy: z.enum(['inspect', 'verify', 'fix']),
  placement: z.enum(['hosted', 'self-hosted']),
  resolvedConfig: z.object({
    schemaVersion: z.literal(1),
    thresholdSeverity: z.enum(['critical', 'high', 'medium', 'low']),
    ignore: z.array(z.string()).max(64),
  }),
  configDigest: z.string(),
  claimableUntil: z.string(),
});
export type RunSpec = z.infer<typeof RunSpecSchema>;

export const FindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  verification: z.enum(['verified', 'inconclusive', 'static']),
  title: z.string().max(200),
});

export const ResultSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    runId: z.string(),
    completeness: z.enum(['complete', 'partial']),
    stoppedBy: z.enum(['budget', 'cancelled']).nullish(),
    summary: z.string().max(4000),
    findings: z.array(FindingSchema).max(200),
    workerBuildVersion: z.string(),
  })
  .superRefine((v, ctx) => {
    const partial = v.completeness === 'partial';
    if (partial && !v.stoppedBy)
      ctx.addIssue({ code: 'custom', message: 'partial Result requires stoppedBy' });
    if (!partial && v.stoppedBy)
      ctx.addIssue({ code: 'custom', message: 'complete Result forbids stoppedBy' });
  });
export type Result = z.infer<typeof ResultSchema>;

export const RefusalSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runId: z.string(),
  reason: z.string().max(64),
  requirement: z.string().max(64),
  required: z.string().max(64).nullable(),
  actual: z.string().max(64).nullable(),
  workerBuildVersion: z.string(),
});
export type Refusal = z.infer<typeof RefusalSchema>;

/** ADR 0006: the raw byte bound is checked before semantic parsing. */
export const MAX_RESULT_BYTES = 256 * 1024;
