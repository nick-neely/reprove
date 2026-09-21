/**
 * Throwaway prototype for issue #111. Shapes mirror the real field names in
 * `packages/protocol/src/v1/index.ts` and `packages/control-plane/src/db/schema.ts`
 * so the renderings stay honest, but nothing here imports them: this folder is
 * deleted with the branch and must not join the package graph.
 */

export type Severity = "critical" | "high" | "medium" | "low";
export type Verification = "verified" | "inconclusive" | "static";

/** ADR 0011 §7 extends ADR 0008's list with `suppressed_ignore`. */
export type PublicationDisposition =
  | "inline_comment"
  | "review_body"
  | "suppressed_threshold"
  | "suppressed_dedupe"
  | "suppressed_ignore";

/** ADR 0007: the current side of Reconciliation. */
export type Reconciliation = "new" | "recurring";

/** ADR 0007: the prior side, internal, never user-facing prose. */
export type PriorReconciliation = "anchor_changed" | "not_reproduced";

export type Evidence = {
  command: string;
  exitCode: number | null;
  durationMs: number;
  excerpt: string;
  truncated: boolean;
  originalByteLength: number;
};

export type Location = {
  path: string;
  startLine: number;
  endLine: number;
};

/** A fake diff hunk, so a Comment can be shown where GitHub would anchor it. */
export type Hunk = {
  header: string;
  lines: { kind: "add" | "del" | "ctx"; line: number | null; text: string }[];
};

export type Finding = {
  /** Prototype-local handle, used for cross-references in the renderings. */
  key: string;
  title: string;
  body: string;
  severity: Severity;
  verification: Verification;
  location: Location;
  anchoredText: string;
  evidence: Evidence[];
  patch?: { replacement: string } & Location;
  /** Whether GitHub can line-anchor it: inside a hunk of the pull request diff. */
  inDiff: boolean;
  hunk?: Hunk;
  publicationDisposition: PublicationDisposition;
  reconciliation: Reconciliation;
  /** Set when a prior Run published a Comment this one would repeat. */
  suppressedAgainstRunId?: string;
};

export type Limitation = {
  kind: "dependency_unavailable" | "service_unavailable" | "scope_limit";
  detail: string;
};

/**
 * ADR 0023 §7: the Run's Usage is an aggregate with a completeness. `unknown` is
 * never shown as zero.
 */
export type Usage = {
  completeness: "complete" | "incomplete" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
};

export type Provenanced<T> = { value: T; provenance: "configured" | "default" };

/** ADR 0019 §7 plus ADR 0018's Drift vocabulary, as shown on a terminal Check. */
export type TerminalFacts = {
  harness: Provenanced<string>;
  model: Provenanced<string>;
  autonomy: Provenanced<string>;
  deadline: Provenanced<string>;
  durationMs: number | null;
  usage: Usage;
  estimatedCostUsd: number | null;
  pricingRevision: string;
  /** ADR 0018: `current | stale | failed | invalid | unqualified`. */
  qualification: string;
  /** Non-null when the Provider resolved a different Model than the pinned one. */
  providerDrift: { pinned: string; resolved: string } | null;
};

export type Threshold = { severity: Severity; verification: "any" | "verified" };

export type Refusal = {
  origin: "worker" | "control_plane";
  reason: string;
  required: string | null;
  actual: string | null;
  /** Control-plane Refusals only (ADR 0019 §4). */
  keyPath?: string;
  /**
   * Optional, because `keyPath` is what the `refusal` record stores. A line
   * number exists only where the loader still holds the parse, so the next step
   * names it only when the fixture has one.
   */
  line?: number;
};

export type RunStatus =
  | "queued"
  | "claimed"
  | "executing"
  | "completed"
  | "incomplete"
  | "failed"
  | "superseded"
  | "cancelled"
  | "unscheduled";

export type CheckConclusion =
  | "success"
  | "failure"
  | "timed_out"
  | "cancelled"
  | "neutral"
  | null;

export type CheckStatus = "queued" | "in_progress" | "completed";

/** What a variant is asked to render one Check from. */
export type CheckSubject = {
  /** Which Check name this is: the review Check or the separate config Check. */
  name: "Reprove" | "Reprove config";
  kind: "review" | "config" | "noop" | "progress";
  externalId: string;
  status: CheckStatus;
  conclusion: CheckConclusion;
  /** Present on a visible no-op: the conclusion being re-asserted (ADR 0022 §5). */
  reassertedFrom?: string;
  noop?: { reason: "stale_head" | "closed" | "equivalent_live_run"; detail: string };
};

export type ConfigReport = {
  /**
   * The config validation record this Check publishes from: Owner-scoped, keyed
   * on repository, pull request and head SHA, holding the outcome and either
   * the resolved values or the error. It is the third subject a `publication`
   * row can have, beside a Run and a `refusal` record.
   */
  recordId: string;
  valid: boolean;
  /** Resolved `review:` values that would apply if merged. */
  effective: { key: string; value: string; note?: string }[];
  /** Requested-versus-effective for narrowed `security:` values. */
  narrowed: { key: string; requested: string; effective: string; by: string }[];
  error?: { keyPath: string; line: number; message: string };
  filePath: string;
};

export type PullRequest = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
};

export type StateRow = { table: string; columns: Record<string, string> };

export type Scenario = {
  id: string;
  name: string;
  blurb: string;
  pullRequest: PullRequest;
  run: {
    id: string;
    status: RunStatus;
    trigger: "automatic" | "manual";
    /** Absent when the Run never produced a Result. */
    result?: {
      completeness: "complete" | "partial";
      stoppedBy:
        | "budget_exhausted"
        | "cancelled"
        | "superseded"
        | "reviewer_stopped"
        | null;
      summary: string;
      disprovedHypothesisCount: number;
      /** ADR 0020 §5, not yet in the protocol schema. */
      unfinished: string | null;
      limitations: Limitation[];
    };
    failure?: { reason: string; detail: string };
    refusals: Refusal[];
    facts: TerminalFacts | null;
  } | null;
  /** A control-plane Refusal record, which exists instead of a Run (ADR 0019 §4). */
  refusalRecord?: { id: string; refusal: Refusal } | null;
  findings: Finding[];
  threshold: Threshold;
  ignore: string[];
  /** The Review this scenario publishes, if any. */
  review: { event: "COMMENT" | "REQUEST_CHANGES" } | null;
  /** Why no Review is published, when there is none. */
  noReviewBecause?: string;
  checks: CheckSubject[];
  config?: ConfigReport;
  /** Prior-Run facts a second Run needs (S9). */
  prior?: {
    runId: string;
    recurring: { key: string; priorCommentUrl: string }[];
    gone: { title: string; path: string; prior: PriorReconciliation }[];
  };
  /** What the control plane would write. Explicit, not derived, so it is arguable. */
  state: StateRow[];
  /** Facts a human needs beside the renderings but that no surface carries. */
  notes: string[];
};
