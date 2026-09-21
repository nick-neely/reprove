/** Throwaway prototype for issue #111. Formatting shared by all three variants. */

import type { CheckSubject, Finding, Scenario, TerminalFacts, Usage } from "./types.ts";

export type Annotation = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
  raw_details?: string;
};

export type RenderedCheck = {
  externalId: string;
  name: string;
  title: string;
  summary: string;
  text: string | null;
  status: string;
  conclusion: string | null;
  annotations: Annotation[];
};

export type RenderedComment = {
  findingKey: string;
  path: string;
  line: number;
  startLine: number;
  body: string;
};

export type Rendering = {
  review: { event: string; body: string } | null;
  comments: RenderedComment[];
  checks: RenderedCheck[];
};

export const shortSha = (sha: string) => sha.slice(0, 7);

export const duration = (ms: number | null) => {
  if (ms === null) {
    return "not measured";
  }
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : `${m}m ${s}s`;
};

export const thousands = (n: number) => n.toLocaleString("en-US");

export const tokens = (n: number | null) => (n === null ? "unknown" : thousands(n));

export const cost = (usd: number | null) =>
  usd === null ? "unknown" : `$${usd.toFixed(2)}`;

/** ADR 0023 §7: unknown is never shown as zero, and completeness travels with it. */
export const usageLine = (u: Usage) => {
  const parts = [
    `in ${tokens(u.inputTokens)}`,
    `out ${tokens(u.outputTokens)}`,
    `cached ${tokens(u.cachedInputTokens)}`,
    `reasoning ${tokens(u.reasoningTokens)}`,
  ];
  return `${parts.join(" / ")} (${u.completeness})`;
};

export const provenanced = (p: { value: string; provenance: string }) =>
  `${p.value} _(${p.provenance})_`;

export const driftLine = (f: TerminalFacts) =>
  f.providerDrift === null
    ? "none"
    : `Provider resolved \`${f.providerDrift.resolved}\` for pinned \`${f.providerDrift.pinned}\``;

export const severityRank: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const annotationLevel = (severity: string): Annotation["annotation_level"] =>
  severity === "critical" || severity === "high" ? "failure" : "warning";

export const published = (f: Finding) =>
  f.publicationDisposition === "inline_comment" ||
  f.publicationDisposition === "review_body";

export const commentFindings = (s: Scenario) =>
  s.findings.filter((f) => f.publicationDisposition === "inline_comment");

export const bodyFindings = (s: Scenario) =>
  s.findings.filter((f) => f.publicationDisposition === "review_body");

export const suppressedFindings = (s: Scenario) =>
  s.findings.filter((f) => !published(f));

export const prUrl = (s: Scenario) =>
  `https://github.com/${s.pullRequest.owner}/${s.pullRequest.repo}/pull/${s.pullRequest.number}`;

export const fileUrl = (s: Scenario, path: string, line: number) =>
  `https://github.com/${s.pullRequest.owner}/${s.pullRequest.repo}/blob/${s.pullRequest.headSha}/${path}#L${line}`;

export const loc = (f: Finding) =>
  f.location.endLine > f.location.startLine
    ? `${f.location.path}:${f.location.startLine}-${f.location.endLine}`
    : `${f.location.path}:${f.location.startLine}`;

/** The one plain-words reason line every terminal non-success surface owes a reader. */
export const reasonAndNextStep = (
  s: Scenario
): { headline: string; reason: string; nextStep: string } | null => {
  if (s.refusalRecord) {
    const r = s.refusalRecord.refusal;
    return {
      headline: `Refused before any Run was created: ${r.reason}`,
      reason: `\`${r.keyPath}\` asks for something Reprove does not have. Required: ${r.required}. Found: ${r.actual}.`,
      nextStep: `Fix line ${r.fileLine} of \`.reprove.yml\` on \`${shortSha(s.pullRequest.baseSha)}\`, the base of this pull request, then re-run this Check.`,
    };
  }
  const run = s.run;
  if (!run) {
    return null;
  }
  if (run.status === "unscheduled" && run.refusals.length > 0) {
    const r = run.refusals[0];
    return {
      headline: `The Worker refused to execute: ${r.reason}`,
      reason: `Required: ${r.required}. Actual: ${r.actual}.`,
      nextStep:
        "Change `review.autonomy`, or pin a Harness that can enforce it, then re-run this Check. Nothing is retried automatically: the attempt already spent a probe turn and a Sandbox.",
    };
  }
  if (run.status === "unscheduled") {
    return {
      headline: "No Worker took this Run before the claim window closed",
      reason:
        "Nothing was dispatched and nothing was refused. No Worker was online and eligible for this Run's resolved configuration while it was claimable.",
      nextStep:
        "Bring a Worker online, then re-run this Check. Nothing was spent, so a re-run costs a full review rather than a retry.",
    };
  }
  if (run.status === "failed" && run.failure) {
    return {
      headline: `The review failed after it started: ${run.failure.reason}`,
      reason: run.failure.detail,
      nextStep: "Re-run this Check. A re-run creates a new Run at the current head and base.",
    };
  }
  if (run.result?.stoppedBy === "reviewer_stopped") {
    return {
      headline: "The Reviewer stopped before finishing its scope",
      reason: run.result.unfinished ?? "",
      nextStep:
        "Read the Findings below, then re-run this Check to review the rest. They stand on their own; what is missing is everything the Reviewer says it did not reach.",
    };
  }
  if (run.result?.stoppedBy === "budget_exhausted") {
    return {
      headline: "The review stopped when it reached its budget",
      reason: `The Run reached its configured \`budget\` after ${duration(run.facts?.durationMs ?? null)} and made no claim before it did.`,
      nextStep:
        "Raise `review.budget` in `.reprove.yml` on the base branch, or narrow the pull request, then re-run this Check.",
    };
  }
  return null;
};

export const conclusionOf = (c: CheckSubject) =>
  c.conclusion === null ? null : c.conclusion;

export const statusOf = (c: CheckSubject) => c.status;

/** GitHub's documented write-surface caps, asserted at build time. */
export const LIMITS = {
  checkSummaryChars: 65_535,
  checkTextChars: 65_535,
  annotationsPerRequest: 50,
  annotationTitleChars: 255,
  annotationMessageBytes: 64 * 1024,
};
