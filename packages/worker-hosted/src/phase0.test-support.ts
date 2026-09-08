/**
 * Protocol values the tests in this package share, each parsed through
 * `@reprove/protocol`'s own schema rather than asserted into shape.
 *
 * A hand-built object cast to `RunSpec` would let a case pass against a value
 * no control plane could ever hand a Worker, which is the one thing a placement
 * test must not be able to do: everything here crosses the Worker boundary, and
 * the schema is what says so.
 */
import type {
  ClaimGrant,
  Refusal,
  Result,
  RunSpec,
} from "@reprove/protocol/v1";
import {
  claimGrantSchema,
  protocolVersion,
  refusalSchema,
  resultSchema,
  runSpecSchema,
} from "@reprove/protocol/v1";

export const RUN_ID = "run_01";
export const OWNER_ID = 1001;
export const EXECUTION_TOKEN = "an-execution-token-handed-back-by-the-claim";

/** One hosted Run, complete at creation the way ADR 0013 requires. */
export const RUN_SPEC: RunSpec = runSpecSchema.parse({
  allowHostedFallback: false,
  autonomy: "verify",
  baseSha: "a".repeat(40),
  claimableUntil: "2026-09-03T12:30:00Z",
  configDigest: "sha256:8c339f28",
  createdAt: "2026-09-03T12:00:00Z",
  harness: "codex",
  headSha: "b".repeat(40),
  installationId: "installation_01",
  model: "gpt-5.6",
  ownerId: "owner_01",
  placement: "hosted",
  provenance: "internal",
  provenanceBasis: {
    authorAssociation: "MEMBER",
    authorId: 2002,
    baseRepositoryId: 1001,
    headRepositoryId: 1001,
    matchedAssociation: true,
    matchedSameRepository: true,
    ruleVersion: 1,
  },
  pullRequestNumber: 42,
  repositoryId: "repo_01",
  resolvedConfig: {
    review: {
      autonomy: "verify",
      baseConventions: true,
      budget: 1,
      deadline: "20m",
      enabled: true,
      event: "COMMENT",
      harness: "codex",
      harnessOptions: {},
      ignore: [],
      model: "gpt-5.6",
      overrides: [],
      strategy: "standard",
      threshold: { severity: "medium", verification: "any" },
      worker: "hosted",
    },
    schemaVersion: 1,
    security: {
      allowExternalProvenance: false,
      allowHostedFallback: false,
      egress: [],
      installScripts: "deny",
      maxExposure: "account",
    },
  },
  runId: RUN_ID,
  strategy: "standard",
  trigger: "automatic",
});

/** The grant a hosted claim hands back, exactly once. */
export const CLAIM_GRANT: ClaimGrant = claimGrantSchema.parse({
  executionExpiresAt: "2026-09-03T12:10:00Z",
  executionToken: EXECUTION_TOKEN,
  protocolVersion,
  runSpec: RUN_SPEC,
});

/** The smallest Result Acceptance will take: no Findings, so no claim about review quality. */
export const RESULT: Result = resultSchema.parse({
  completeness: "complete",
  disprovedHypothesisCount: 0,
  findings: [],
  passes: [
    {
      endedAt: "2026-09-03T12:01:00Z",
      failureReason: null,
      harness: "codex",
      outcome: "completed",
      passId: "pass_01",
      pinnedModel: "gpt-5.6",
      repairTurnUsed: false,
      resolvedModel: null,
      startedAt: "2026-09-03T12:00:30Z",
      usage: { inputTokens: 1000, outputTokens: 100 },
    },
  ],
  protocolVersion,
  runId: RUN_ID,
  stoppedBy: null,
  summary: "Reviewed the change and found nothing to report.",
  usage: { inputTokens: 1000, outputTokens: 100 },
  workerBuildVersion: "0.1.0",
});

/** A decision not to execute, made before any Reviewer ran. */
export const REFUSAL: Refusal = refusalSchema.parse({
  actual: "none",
  protocolVersion,
  reason: "sandbox_refused",
  required: "every hard Sandbox property",
  runId: RUN_ID,
  workerBuildVersion: "0.1.0",
});
