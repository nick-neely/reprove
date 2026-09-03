import { z } from "zod";

/**
 * The integer a Worker advertises for this compatibility family (ADR 0006).
 * It is independent of the package version.
 */
export const protocolVersion = 1 as const;

export const protocolLimits = {
  resultBytes: 256 * 1024,
  summaryChars: 8000,
  findings: 100,
  findingBodyChars: 4000,
  evidencePerFinding: 10,
  evidenceExcerptChars: 2000,
  anchoredTextChars: 512,
  patchChars: 8000,
  resolvedConfigBytes: 128 * 1024,
  ignoreGlobs: 256,
  overrides: 64,
  overridePaths: 64,
  egressHosts: 64,
  globChars: 512,
  commandChars: 2048,
} as const;

const shaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u, "must be a full 40-character SHA");
const instantSchema = z.string().min(1);

export const harnessSchema = z.enum(["codex", "claude-code", "opencode"]);
export const autonomySchema = z.enum(["inspect", "verify", "fix"]);
export const strategySchema = z.enum(["standard"]);
export const provenanceSchema = z.enum(["internal", "external"]);
export const placementSchema = z.enum(["self_hosted", "hosted"]);
export const exposureSchema = z.enum(["none", "scoped", "account"]);
export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export const verificationSchema = z.enum([
  "verified",
  "inconclusive",
  "static",
]);

const boundedJsonSchema = <Schema extends z.ZodType>(
  label: string,
  maximumBytes: number,
  schema: Schema
) =>
  z.preprocess((input, context) => {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(input ?? null), "utf-8");
      if (bytes > maximumBytes) {
        context.addIssue({
          code: "custom",
          message: `${label} exceeds ${maximumBytes} bytes`,
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: `${label} must be serializable as plain JSON`,
      });
    }

    return input;
  }, schema);

const globSchema = z.string().min(1).max(protocolLimits.globChars);
const commandSchema = z.string().min(1).max(protocolLimits.commandChars);

export const configThresholdSchema = z
  .object({
    severity: severitySchema.default("medium"),
    verification: z.enum(["any", "verified"]).default("any"),
  })
  .strict();

export const pathLocalPolicySchema = z
  .object({
    threshold: configThresholdSchema.partial().optional(),
    ignore: z.array(globSchema).max(protocolLimits.ignoreGlobs).optional(),
  })
  .strict();

export const configOverrideSchema = pathLocalPolicySchema
  .extend({
    paths: z.array(globSchema).min(1).max(protocolLimits.overridePaths),
  })
  .strict();

export const projectCommandsSchema = z
  .object({
    install: commandSchema.optional(),
    build: commandSchema.optional(),
    test: commandSchema.optional(),
    typecheck: commandSchema.optional(),
  })
  .strict();

export const harnessOptionsSchema = z
  .object({
    codex: z.object({}).strict().optional(),
    claudeCode: z.object({}).strict().optional(),
    openCode: z.object({}).strict().optional(),
  })
  .strict();

export const resolvedReviewConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    worker: z.enum(["self-hosted", "hosted"]).optional(),
    harness: harnessSchema.optional(),
    model: z.string().min(1).max(128).optional(),
    strategy: strategySchema.default("standard"),
    autonomy: autonomySchema.optional(),
    budget: z.number().positive().finite().optional(),
    deadline: z
      .string()
      .regex(/^\d+[smh]$/u)
      .optional(),
    event: z.enum(["COMMENT", "REQUEST_CHANGES"]).default("COMMENT"),
    threshold: configThresholdSchema.default({
      severity: "medium",
      verification: "any",
    }),
    ignore: z.array(globSchema).max(protocolLimits.ignoreGlobs).default([]),
    commands: projectCommandsSchema.optional(),
    baseConventions: z.boolean().default(true),
    harnessOptions: harnessOptionsSchema.default({}),
    overrides: z
      .array(configOverrideSchema)
      .max(protocolLimits.overrides)
      .default([]),
  })
  .strict();

export const resolvedSecurityConfigSchema = z
  .object({
    maxExposure: exposureSchema.default("account"),
    allowExternalProvenance: z.boolean().default(false),
    installScripts: z.enum(["deny", "allow"]).default("deny"),
    allowHostedFallback: z.boolean().default(false),
    egress: z
      .array(z.string().min(1).max(253))
      .max(protocolLimits.egressHosts)
      .default([]),
  })
  .strict();

const resolvedConfigPayloadSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    review: resolvedReviewConfigSchema,
    security: resolvedSecurityConfigSchema,
  })
  .strict();

/** The normalized configuration snapshot that governed this Run. */
export const resolvedConfigSchema = boundedJsonSchema(
  "resolvedConfig",
  protocolLimits.resolvedConfigBytes,
  resolvedConfigPayloadSchema
);

export const evidenceSchema = z.object({
  command: z.string().min(1).max(1000),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  excerpt: z.string().max(protocolLimits.evidenceExcerptChars),
  truncated: z.boolean(),
  originalByteLength: z.number().int().nonnegative(),
});

export const locationSchema = z
  .object({
    path: z.string().min(1).max(1024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine(({ endLine, startLine }) => endLine >= startLine, {
    message: "endLine must not precede startLine",
    path: ["endLine"],
  });

export const patchSchema = locationSchema.safeExtend({
  replacement: z.string().max(protocolLimits.patchChars),
});

export const findingSchema = z
  .object({
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(protocolLimits.findingBodyChars),
    severity: severitySchema,
    verification: verificationSchema,
    location: locationSchema,
    anchoredText: z.string().max(protocolLimits.anchoredTextChars),
    evidence: z.array(evidenceSchema).max(protocolLimits.evidencePerFinding),
    patch: patchSchema.optional(),
  })
  .refine(
    ({ evidence, verification }) =>
      verification !== "verified" || evidence.length > 0,
    {
      message: "verification=verified requires at least one Evidence",
      path: ["evidence"],
    }
  )
  .refine(
    ({ evidence, verification }) =>
      verification !== "static" || evidence.length === 0,
    {
      message: "verification=static cannot carry Evidence",
      path: ["evidence"],
    }
  );

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});

export const passRecordSchema = z.object({
  passId: z.string().min(1),
  harness: harnessSchema,
  pinnedModel: z.string().min(1),
  resolvedModel: z.string().min(1).nullable(),
  startedAt: instantSchema,
  endedAt: instantSchema,
  outcome: z.enum(["completed", "failed"]),
  failureReason: z.string().min(1).nullable(),
  repairTurnUsed: z.boolean(),
  usage: usageSchema,
});

const resultPayloadSchema = z
  .object({
    runId: z.string().min(1),
    completeness: z.enum(["complete", "partial"]),
    stoppedBy: z
      .enum(["budget_exhausted", "cancelled", "superseded"])
      .nullable(),
    summary: z.string().min(1).max(protocolLimits.summaryChars),
    disprovedHypothesisCount: z.number().int().nonnegative(),
    findings: z.array(findingSchema).max(protocolLimits.findings),
    passes: z.array(passRecordSchema).min(1),
    usage: usageSchema,
    protocolVersion: z.literal(protocolVersion),
    workerBuildVersion: z.string().min(1),
  })
  .refine(
    ({ completeness, stoppedBy }) =>
      (completeness === "partial") === (stoppedBy !== null),
    {
      message:
        "stoppedBy is required for a partial Result and forbidden otherwise",
      path: ["stoppedBy"],
    }
  );

/**
 * One atomic Result payload. The preprocessing check counts unknown additive
 * fields too, before Zod intentionally strips them for forward compatibility.
 */
export const resultSchema = boundedJsonSchema(
  "Result",
  protocolLimits.resultBytes,
  resultPayloadSchema
);

/** Fixed when the control plane creates a Run and sent unchanged to a Worker. */
export const runSpecSchema = z.object({
  runId: z.string().min(1),
  ownerId: z.string().min(1),
  repositoryId: z.string().min(1),
  installationId: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
  provenance: provenanceSchema,
  provenanceBasis: z.object({
    ruleVersion: z.number().int().positive(),
    baseRepositoryId: z.number().int().positive(),
    headRepositoryId: z.number().int().positive().nullable(),
    authorAssociation: z.string().min(1),
    authorId: z.number().int().positive(),
    matchedSameRepository: z.boolean(),
    matchedAssociation: z.boolean(),
  }),
  trigger: z.enum(["automatic", "manual"]),
  placement: placementSchema,
  allowHostedFallback: z.boolean(),
  harness: harnessSchema,
  model: z.string().min(1),
  strategy: strategySchema,
  autonomy: autonomySchema,
  resolvedConfig: resolvedConfigSchema,
  configDigest: z.string().min(1),
  claimableUntil: instantSchema,
  createdAt: instantSchema,
});

/** A Worker's pre-execution decision that it cannot serve the offered Run. */
export const refusalSchema = z.object({
  runId: z.string().min(1),
  reason: z.string().min(1),
  required: z.string().min(1).nullable(),
  actual: z.string().min(1).nullable(),
  protocolVersion: z.literal(protocolVersion),
  workerBuildVersion: z.string().min(1),
});

/** The complete set of protocol v1 payload schemas crossing the Worker seam. */
export const protocolSchemas = {
  runSpec: runSpecSchema,
  result: resultSchema,
  refusal: refusalSchema,
} as const;

export type Evidence = z.infer<typeof evidenceSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type PassRecord = z.infer<typeof passRecordSchema>;
export type Refusal = z.infer<typeof refusalSchema>;
export type ResolvedConfig = z.infer<typeof resolvedConfigSchema>;
export type Result = z.infer<typeof resultSchema>;
export type RunSpec = z.infer<typeof runSpecSchema>;
export type Usage = z.infer<typeof usageSchema>;
