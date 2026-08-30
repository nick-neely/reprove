/**
 * THROWAWAY PROTOTYPE - wayfinder ticket #13 ("Shape Run, Result, and Finding").
 *
 * This is not shipped code and is not a package. It exists so the shapes can be
 * argued about concretely instead of in prose. Run `npm start` to drive it.
 *
 * Vocabulary is CONTEXT.md's. Constraints inherited from:
 *   ADR 0002 - severity / verification / no confidence
 *   ADR 0004 - Sandbox boundary, Isolation, Exposure, Provenance
 *   ADR 0005 - Adapter boundary, per-Pass bundle, Evidence reconciliation
 *   ADR 0006 - worker protocol, bounded Result, non-complete Result
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Bounds. ADR 0006 fixes that Result is "strictly size-bounded" and that an
// oversized submission is REJECTED rather than upgraded into a streaming
// protocol. The exact numbers are implementation policy; the enforcement is not.
// ---------------------------------------------------------------------------

export const LIMITS = {
  resultBytes: 256 * 1024,
  summaryChars: 8_000,
  findings: 100,
  findingBodyChars: 4_000,
  evidencePerFinding: 10,
  evidenceExcerptChars: 2_000,
  anchoredTextChars: 2_000,
  patchChars: 8_000,
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const Sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-char SHA");
const Instant = z.string(); // ISO-8601; a real schema would use z.iso.datetime()

export const Harness = z.enum(["codex", "claude-code", "opencode"]);
export const Autonomy = z.enum(["inspect", "verify", "fix"]);
export const Strategy = z.enum(["standard"]); // the rest are out of this map's scope
export const Provenance = z.enum(["internal", "external"]);
export const Isolation = z.enum(["microvm", "container-rootless", "container"]);
export const Exposure = z.enum(["none", "scoped", "account"]);
export const Severity = z.enum(["critical", "high", "medium", "low"]);
export const Verification = z.enum(["verified", "inconclusive", "static"]);

/** Where the Worker that executes this Run lives. Not a "mode" - CONTEXT.md bans the word. */
export const Placement = z.enum(["self_hosted", "hosted"]);

/**
 * PROPOSAL (open): Route is recorded on the Run for audit, even though ADR 0005
 * keeps it out of the Adapter's public identity. Without it, "why was Exposure
 * `account`?" is unanswerable after the fact.
 */
export const Route = z.enum(["brokered", "native"]);

// ---------------------------------------------------------------------------
// Evidence
//
// ADR 0005: the Reviewer's structured Evidence is a CLAIM; the Adapter's
// observed tool-call record is what that claim is validated against; only the
// reconciled product is thereafter "Evidence". So there are two types, and only
// the second one crosses the worker protocol.
// ---------------------------------------------------------------------------

/** Adapter-internal. Emitted by the Reviewer inside the Sandbox. Attacker-controlled. */
export const ClaimedEvidence = z.object({
  command: z.string().min(1).max(1_000),
  exitCode: z.number().int().nullable(),
  excerpt: z.string().max(LIMITS.evidenceExcerptChars),
});

/** Post-reconciliation, Worker-side, outside the Sandbox. This is what crosses. */
export const Evidence = z.object({
  command: z.string().min(1).max(1_000),
  /** null means the command never exited (killed by budget or Sandbox teardown). */
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  excerpt: z.string().max(LIMITS.evidenceExcerptChars),
  /** ADR 0006: bulk stdout never crosses, so truncation is a first-class fact. */
  truncated: z.boolean(),
  originalByteLength: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

/**
 * Exactly one location (#2). Line numbers are meaningful only against `headSha`,
 * which the Result carries; a Finding does not chase a moving line.
 */
export const Location = z
  .object({
    path: z.string().min(1).max(1_024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((l) => l.endLine >= l.startLine, {
    message: "endLine must not precede startLine",
  });

/** Reserved shape only. Write-back behaviour is out of this map's scope. */
export const Patch = z.object({
  path: z.string().min(1).max(1_024),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  replacement: z.string().max(LIMITS.patchChars),
});

export const Finding = z
  .object({
    title: z.string().min(1).max(160),
    body: z.string().min(1).max(LIMITS.findingBodyChars),
    severity: Severity,
    verification: Verification,
    location: Location,
    /**
     * PROPOSAL (open): the source text the claim is about, as read at headSha.
     * This is the reconciliation key's input - see fingerprint() below. It rides
     * across the protocol so the CONTROL PLANE computes the fingerprint, which
     * means the algorithm can change without shipping every self-hosted Worker a
     * new build. Bounded, and a Comment would quote this code anyway.
     */
    anchoredText: z.string().max(LIMITS.anchoredTextChars),
    evidence: z.array(Evidence).max(LIMITS.evidencePerFinding),
    patch: Patch.optional(),
  })
  // ADR 0002: "No Evidence, no `verified`" - made unreachable in the schema.
  .refine((f) => f.verification !== "verified" || f.evidence.length > 0, {
    message: "verification=verified requires at least one Evidence",
    path: ["evidence"],
  })
  // `static` means reasoned only. Evidence on a static Finding is a contradiction.
  .refine((f) => f.verification !== "static" || f.evidence.length === 0, {
    message: "verification=static cannot carry Evidence",
    path: ["evidence"],
  });

export type Finding = z.infer<typeof Finding>;

// ---------------------------------------------------------------------------
// Result
//
// CONTEXT.md: "the normalized payload a Run returns ... absorbed into the Run
// once accepted. It is what crosses the Worker boundary, not something that
// outlives the crossing." So Result has no table of its own - see README.
// ---------------------------------------------------------------------------

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});

/** One harness invocation. ADR 0005: a Pass yields an internal bundle, not a Result. */
export const PassRecord = z.object({
  passId: z.string(),
  harness: Harness,
  /** The Model the control plane pinned. The Adapter never substitutes it. */
  pinnedModel: z.string(),
  /** Null where the Harness does not report it (Codex). ADR 0005. */
  resolvedModel: z.string().nullable(),
  startedAt: Instant,
  endedAt: Instant,
  outcome: z.enum(["completed", "failed"]),
  failureReason: z.string().nullable(),
  /** A bounded repair turn ran inside this same Pass and Sandbox. */
  repairTurnUsed: z.boolean(),
  usage: Usage,
});

/**
 * ADR 0006 handed #13 the requirement that Result have "a transportable
 * non-complete form".
 *
 * PROPOSAL: ONE schema with a `completeness` discriminator, not a second type.
 * Acceptance is explicitly one code path ("one schema, one validation, one
 * dedupe"), and a parallel PartialResult type forks it.
 */
export const Result = z
  .object({
    runId: z.string(),
    completeness: z.enum(["complete", "partial"]),
    /** Required exactly when completeness is `partial`. */
    stoppedBy: z
      .enum(["budget_exhausted", "cancelled", "superseded"])
      .nullable(),
    summary: z.string().min(1).max(LIMITS.summaryChars),
    /**
     * ADR 0002: the Review summary reports disproved hypotheses in aggregate and
     * never enumerates them, so this is a count and not a list, by design.
     */
    disprovedHypothesisCount: z.number().int().nonnegative(),
    findings: z.array(Finding).max(LIMITS.findings),
    passes: z.array(PassRecord).min(1),
    usage: Usage,
    protocolVersion: z.number().int().positive(),
    workerBuildVersion: z.string(),
  })
  .refine((r) => (r.completeness === "partial") === (r.stoppedBy !== null), {
    message: "stoppedBy is required for a partial Result and forbidden otherwise",
    path: ["stoppedBy"],
  });

export type Result = z.infer<typeof Result>;

/**
 * ADR 0006's bound is what makes "no bulk data crosses" enforceable at the edge
 * rather than resting on the Worker's good behaviour.
 */
export function acceptResultPayload(raw: unknown):
  | { ok: true; value: Result }
  | { ok: false; reason: string } {
  const bytes = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
  if (bytes > LIMITS.resultBytes) {
    return {
      ok: false,
      reason: `oversized Result: ${bytes}B > ${LIMITS.resultBytes}B - rejected, not truncated`,
    };
  }
  const parsed = Result.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: z.prettifyError(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Run
//
// Split three ways so "stable identity vs mutable state" is visible in the type
// rather than asserted in a comment.
// ---------------------------------------------------------------------------

/** Fixed at creation. Never rewritten. Carries no reference to a webhook delivery. */
export const RunSpec = z.object({
  runId: z.string(),
  ownerId: z.string(),
  repositoryId: z.string(),
  /** The grant used. An Owner survives this being removed and re-added. */
  installationId: z.string(),

  pullRequestNumber: z.number().int().positive(),
  baseSha: Sha,
  headSha: Sha,

  /** Computed from the pull request (ADR 0003), not configured. */
  provenance: Provenance,
  /** Kept so the classification is explainable later without refetching the PR. */
  provenanceBasis: z.object({
    sameRepositoryBranch: z.boolean(),
    authorAssociation: z.string(),
  }),

  placement: Placement,
  /** ADR 0006: never implicit. Read from the base ref. */
  hostedFallbackAllowed: z.boolean(),

  harness: Harness,
  model: z.string(),
  strategy: Strategy,
  autonomy: Autonomy,

  /** The base-ref configuration this Run resolved, so a later edit cannot rewrite history. */
  configDigest: z.string(),

  claimableUntil: Instant,
  createdAt: Instant,
});

/** Filled once, at claim. Immutable thereafter. ADR 0006 requires these recorded for audit. */
export const RunResolution = z.object({
  /** Null for a hosted Worker, which holds no durable identity (ADR 0006). */
  workerId: z.string().nullable(),
  route: Route,
  isolation: Isolation,
  exposure: Exposure,
  protocolVersion: z.number().int().positive(),
  workerBuildVersion: z.string(),
  claimedAt: Instant,
});

export const RefusalRecord = z.object({
  workerId: z.string(),
  reason: z.string(),
  required: z.string().nullable(),
  actual: z.string().nullable(),
  at: Instant,
});

export const RunStatus = z.enum([
  "queued", // claimable, no Worker holds it
  "claimed", // a Worker holds a Lease; dispatch happened
  "executing", // at least one Pass started
  "completed", // a terminal Result was accepted (complete OR partial)
  "unscheduled", // claimableUntil expired; never dispatched. Carries Refusals.
  "failed", // began executing, no acceptable Result
  "superseded", // a newer Run exists for this pull request
  "cancelled",
]);

/**
 * PROPOSAL (open): publication is NOT a Run status.
 *
 * ADR 0002 requires that changing a Threshold never costs a Run. If `published`
 * were a state, re-publishing an existing Result under a new Threshold would
 * have to move the Run backwards. So the Review is a record hanging off the Run,
 * absent until GitHub accepts it, and replaceable.
 */
export const ReviewRecord = z.object({
  githubReviewId: z.number().int().positive(),
  event: z.enum(["COMMENT", "REQUEST_CHANGES"]),
  submittedAt: Instant,
  /** Findings suppressed by Threshold or by dedupe against an earlier Run. */
  suppressedFindingCount: z.number().int().nonnegative(),
});

export const RunState = z.object({
  status: RunStatus,
  leaseExpiresAt: Instant.nullable(),
  refusals: z.array(RefusalRecord),
  failureReason: z
    .enum(["worker_lost", "pass_failure", "result_rejected", "budget_exhausted"])
    .nullable(),
  startedAt: Instant.nullable(),
  endedAt: Instant.nullable(),
  /** Absorbed here on acceptance. It does not outlive the crossing as its own entity. */
  result: Result.nullable(),
  review: ReviewRecord.nullable(),
});

export const Run = z.object({
  spec: RunSpec,
  resolution: RunResolution.nullable(),
  state: RunState,
});

export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------------------
// Reconciliation across Runs (PRD §32)
//
// A new push is a new Run and prior Findings do not carry. The question is only
// how a Finding is RECOGNISED as the same one.
// ---------------------------------------------------------------------------

/**
 * PROPOSAL: the key is the anchored SOURCE, never the line number and never the
 * model-written title.
 *
 * - Line numbers move on every unrelated edit above them, so keying on them
 *   reports every Finding as new after any push.
 * - Titles are model prose and are not stable across two Runs of the same
 *   Reviewer, let alone across Harnesses.
 * - The anchored source is the thing the claim is ABOUT. If it changed, the
 *   claim is stale by definition and re-asserting it is the correct behaviour.
 */
export function fingerprint(f: Finding): string {
  const normalized = f.anchoredText
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${f.location.path}::${f.severity}::${hash(normalized)}`;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * PROPOSAL: `resolved` and `not_reproduced` are different facts and collapsing
 * them is the mistake worth avoiding.
 *
 * An agentic Reviewer is nondeterministic. A Finding vanishing from Run N is
 * NOT evidence it was fixed. Only a Finding whose anchored region actually
 * changed between the two head SHAs earned `resolved`.
 */
export const Disposition = z.enum([
  "new", // not present in the prior accepted Run
  "recurring", // same fingerprint as the prior Run - Comment suppressed, Finding still recorded
  "resolved", // gone, and the region it anchored to changed
  "not_reproduced", // gone, and nothing it anchored to changed
]);

export type Reconciliation = {
  fingerprint: string;
  disposition: z.infer<typeof Disposition>;
  title: string;
};

export function reconcile(
  prior: Finding[],
  current: Finding[],
  changedPaths: ReadonlySet<string>,
): Reconciliation[] {
  const priorByFp = new Map(prior.map((f) => [fingerprint(f), f]));
  const out: Reconciliation[] = [];

  for (const f of current) {
    const fp = fingerprint(f);
    out.push({
      fingerprint: fp,
      title: f.title,
      disposition: priorByFp.has(fp) ? "recurring" : "new",
    });
  }

  const currentFps = new Set(current.map(fingerprint));
  for (const [fp, f] of priorByFp) {
    if (currentFps.has(fp)) continue;
    out.push({
      fingerprint: fp,
      title: f.title,
      disposition: changedPaths.has(f.location.path)
        ? "resolved"
        : "not_reproduced",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Comment projection
//
// CONTEXT.md: a Comment is a projection of at most one Finding. A Reviewer reads
// the whole Workspace, so it can make a claim about a file the diff never
// touched - and GitHub cannot line-anchor a review comment there.
// ---------------------------------------------------------------------------

export type CommentPlan =
  | { kind: "anchored"; path: string; line: number; findingTitle: string }
  | { kind: "summary_only"; findingTitle: string; because: string }
  | { kind: "suppressed"; findingTitle: string; because: string };

export function planComments(
  result: Result,
  recon: Reconciliation[],
  diffPaths: ReadonlySet<string>,
  threshold: z.infer<typeof Severity>,
): CommentPlan[] {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const byFp = new Map(recon.map((r) => [r.fingerprint, r]));

  return result.findings.map((f): CommentPlan => {
    if (rank[f.severity] > rank[threshold]) {
      return {
        kind: "suppressed",
        findingTitle: f.title,
        because: `severity ${f.severity} is below the ${threshold} Threshold`,
      };
    }
    if (byFp.get(fingerprint(f))?.disposition === "recurring") {
      return {
        kind: "suppressed",
        findingTitle: f.title,
        because: "already posted on an earlier Run for this pull request",
      };
    }
    if (!diffPaths.has(f.location.path)) {
      return {
        kind: "summary_only",
        findingTitle: f.title,
        because: `${f.location.path} is not in the diff, so GitHub cannot anchor a review comment`,
      };
    }
    return {
      kind: "anchored",
      path: f.location.path,
      line: f.location.endLine,
      findingTitle: f.title,
    };
  });
}

// ---------------------------------------------------------------------------
// Cross-field rules that belong to the Run, not the Result
// ---------------------------------------------------------------------------

export function acceptForRun(
  run: Run,
  result: Result,
): { ok: true } | { ok: false; reason: string } {
  // ADR 0006: at most one accepted terminal Result for the current Run state.
  if (["completed", "failed", "superseded", "cancelled"].includes(run.state.status)) {
    return {
      ok: false,
      reason: `Run is already terminal (${run.state.status}) - a late Result cannot change its outcome`,
    };
  }
  // A Patch is reserved for `fix` autonomy. A Reviewer that emits one anyway is
  // claiming a permission it was not granted.
  if (run.spec.autonomy !== "fix" && result.findings.some((f) => f.patch)) {
    return {
      ok: false,
      reason: `Finding carries a Patch under autonomy=${run.spec.autonomy}`,
    };
  }
  // ADR 0005: the Model is pinned and never substituted.
  const drifted = result.passes.find(
    (p) => p.resolvedModel !== null && p.resolvedModel !== run.spec.model,
  );
  if (drifted) {
    return {
      ok: false,
      reason: `Model drift: pinned ${run.spec.model}, Harness resolved ${drifted.resolvedModel}`,
    };
  }
  return { ok: true };
}

/**
 * PROPOSAL (the sharpest open question in this ticket): a PARTIAL Result with
 * zero Findings must never publish as a clean review.
 *
 * ADR 0005 already refuses to let a malformed Pass become an empty Result,
 * because "empty means review completed with no Findings and malformed means
 * review failed". A budget-exhausted Run with nothing found is the same
 * confusion one level up.
 */
export function publicationDecision(result: Result): {
  publishReview: boolean;
  check: "success" | "neutral" | "failure";
  note: string;
} {
  if (result.completeness === "complete") {
    return {
      publishReview: true,
      check: result.findings.length === 0 ? "success" : "neutral",
      note: "complete Result - the Reviewer finished",
    };
  }
  if (result.findings.length === 0) {
    return {
      publishReview: false,
      check: "failure",
      note: `partial Result (${result.stoppedBy}) with no Findings - publishing this would assert a clean bill of health the Reviewer never gave`,
    };
  }
  return {
    publishReview: true,
    check: "neutral",
    note: `partial Result (${result.stoppedBy}) - Findings publish, and the summary must say the review did not finish`,
  };
}
