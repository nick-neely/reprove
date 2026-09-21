/**
 * Variant C - checklist / ledger.
 *
 * Information hierarchy: nothing is prose. The Review body is an index table of
 * every Finding the Review carries, one row each, linking to its Comment. The
 * Check `text` is the full ledger: every Finding the Run made, including the ones
 * no Comment was posted for, each with the exact `publicationDisposition` that
 * explains why. Findings outside the diff are **not** in the Review body at all;
 * they are Check annotations, which anchor at any `path:line` with no
 * diff-membership requirement. That is the structural bet this variant makes and
 * the one that contradicts ADR 0007 most directly.
 */

import {
  type Annotation,
  annotationLevel,
  bodyFindings,
  commentFindings,
  cost,
  driftLine,
  duration,
  fileUrl,
  loc,
  prUrl,
  reasonAndNextStep,
  type RenderedCheck,
  type RenderedComment,
  type Rendering,
  severityRank,
  shortSha,
  usageLine,
} from "./common.ts";
import type { CheckSubject, Finding, Scenario } from "./types.ts";

const MARK: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "⬜",
};

const commentAnchor = (s: Scenario, index: number) =>
  `${prUrl(s)}#discussion_r90000000${index}`;

const sorted = (list: Finding[]) =>
  [...list].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

const dispositionWord: Record<string, string> = {
  inline_comment: "comment",
  review_body: "review body",
  suppressed_threshold: "below threshold",
  suppressed_dedupe: "already reported",
  suppressed_ignore: "ignored path",
};

const reviewBody = (s: Scenario): string | null => {
  if (!s.review) {
    return null;
  }
  const run = s.run;
  const inline = commentFindings(s);
  const out: string[] = [];

  out.push(
    `### Findings index - ${s.findings.length} made, ${inline.length} commented, ${s.findings.length - inline.length} not`
  );

  if (s.findings.length === 0) {
    out.push(
      "| | |\n| --- | --- |\n| Findings made | 0 |\n| Hypotheses disproved by execution | " +
        `${run?.result?.disprovedHypothesisCount ?? 0} |\n| Result | \`${run?.result?.completeness}\` |`
    );
  } else {
    const rows = sorted(s.findings).map((f, i) => {
      const prior = s.prior?.recurring.find((r) => r.key === f.key)?.priorCommentUrl;
      const where =
        f.publicationDisposition === "inline_comment"
          ? `[comment ${inline.indexOf(f) + 1}](${commentAnchor(s, inline.indexOf(f))})`
          : f.publicationDisposition === "review_body"
            ? "annotation, **Checks** tab"
            : f.publicationDisposition === "suppressed_dedupe" && prior
              ? `[already reported](${prior})`
              : dispositionWord[f.publicationDisposition];
      return `| ${i + 1} | ${MARK[f.severity]} ${f.severity} | \`${f.verification}\` | [\`${loc(f)}\`](${fileUrl(s, f.location.path, f.location.startLine)}) | ${f.title} | ${where} |`;
    });
    out.push(
      [
        "| # | sev | verif | location | finding | where |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n")
    );
  }

  const outside = bodyFindings(s);
  if (outside.length > 0) {
    out.push(
      `> ${outside.length} Finding${outside.length === 1 ? "" : "s"} above ${outside.length === 1 ? "is" : "are"} outside this pull request's diff. ` +
        `${outside.length === 1 ? "It is" : "They are"} annotated at ${outside.length === 1 ? "its" : "their"} exact line in the **Checks** tab rather than restated here.`
    );
  }

  if (run?.result?.stoppedBy === "reviewer_stopped") {
    out.push(
      `> ⚠️ **Unfinished.** The index above is not a whole-diff result. Not reviewed: ${run.result.unfinished}`
    );
  }

  const lim = run?.result?.limitations ?? [];
  if (lim.length > 0) {
    out.push(
      ["| limitation | detail |", "| --- | --- |", ...lim.map((l) => `| \`${l.kind}\` | ${l.detail} |`)].join(
        "\n"
      )
    );
  }

  out.push(
    `<sub>Run \`${run?.id.slice(0, 8)}\` at \`${shortSha(s.pullRequest.headSha)}\` · threshold \`${s.threshold.severity}\`/\`${s.threshold.verification}\` · ignore ${s.ignore.length === 0 ? "none" : s.ignore.map((g) => `\`${g}\``).join(" ")} · full ledger and terminal facts in the **Checks** tab</sub>`
  );
  return out.join("\n\n");
};

const comments = (s: Scenario): RenderedComment[] =>
  commentFindings(s).map((f, i) => {
    const rows = [
      "| | |",
      "| --- | --- |",
      `| severity | ${MARK[f.severity]} \`${f.severity}\` |`,
      `| verification | \`${f.verification}\` |`,
      `| location | \`${loc(f)}\` |`,
      `| disposition | \`${f.publicationDisposition}\` |`,
      `| reconciliation | \`${f.reconciliation}\` |`,
    ].join("\n");
    const evidence =
      f.evidence.length === 0
        ? "_No Evidence. This claim was reasoned, not executed._"
        : [
            "| command | exit | duration | output |",
            "| --- | --- | --- | --- |",
            ...f.evidence.map(
              (e) =>
                `| \`${e.command}\` | ${e.exitCode === null ? "none" : e.exitCode} | ${Math.round(e.durationMs / 1000)}s | ${e.truncated ? `truncated from ${e.originalByteLength}B` : `${e.originalByteLength}B`} |`
            ),
            "",
            "```text",
            f.evidence.map((e) => e.excerpt).join("\n---\n"),
            "```",
          ].join("\n");
    return {
      findingKey: f.key,
      path: f.location.path,
      line: f.location.endLine,
      startLine: f.location.startLine,
      body: [`**[${i + 1}] ${f.title}**`, rows, f.body, evidence].join("\n\n"),
    };
  });

const ledger = (s: Scenario) => {
  const rows = sorted(s.findings).map(
    (f) =>
      `| ${MARK[f.severity]} \`${f.severity}\` | \`${f.verification}\` | \`${loc(f)}\` | ${f.title} | \`${f.publicationDisposition}\` | \`${f.reconciliation}\` |`
  );
  return [
    "| sev | verif | location | finding | disposition | reconciliation |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
};

const factsLedger = (s: Scenario) => {
  const f = s.run?.facts;
  if (!f) {
    return "";
  }
  return [
    "| fact | value | provenance |",
    "| --- | --- | --- |",
    `| harness | \`${f.harness.value}\` | \`${f.harness.provenance}\` |`,
    `| model | \`${f.model.value}\` | \`${f.model.provenance}\` |`,
    `| autonomy | \`${f.autonomy.value}\` | \`${f.autonomy.provenance}\` |`,
    `| deadline | \`${f.deadline.value}\` | \`${f.deadline.provenance}\` |`,
    `| duration | ${duration(f.durationMs)} | measured |`,
    `| usage | ${usageLine(f.usage)} | aggregate |`,
    `| estimated cost | ${cost(f.estimatedCostUsd)} | \`${f.pricingRevision}\` |`,
    `| qualification | \`${f.qualification}\` | lineage |`,
    `| provider drift | ${driftLine(f)} | observed |`,
  ].join("\n");
};

const reviewCheck = (s: Scenario, c: CheckSubject): RenderedCheck => {
  const rns = reasonAndNextStep(s);
  const summary = [
    `| | |`,
    `| --- | --- |`,
    `| outcome | \`${s.run?.status ?? "none"}\` -> \`${c.conclusion}\` |`,
    `| findings | ${s.findings.length} made, ${commentFindings(s).length} commented |`,
    `| result | ${s.run?.result ? `\`${s.run.result.completeness}\`${s.run.result.stoppedBy ? ` / \`${s.run.result.stoppedBy}\`` : ""}` : "none accepted"} |`,
    `| review | ${s.review ? `published (\`${s.review.event}\`)` : "not published"} |`,
    `| external_id | \`${c.externalId}\` |`,
  ].join("\n");

  const text: string[] = [];
  if (rns) {
    text.push(`## Reason\n\n${rns.headline}.\n\n${rns.reason}\n\n**Next step:** ${rns.nextStep}`);
  }
  if (s.noReviewBecause) {
    text.push(`## No Review\n\n${s.noReviewBecause}`);
  }
  if (s.findings.length > 0) {
    text.push(`## Full Finding ledger\n\nEvery Finding this Run made, published or not.\n\n${ledger(s)}`);
  }
  if (s.prior) {
    text.push(
      "## Reconciled against the previous Run\n\n" +
        `Prior Run \`${s.prior.runId.slice(0, 8)}\`. Comments suppressed as recurring: ${s.prior.recurring.length}. ` +
        `Prior Findings with no current match: ${s.prior.gone.length}. No claim is made about whether those were fixed.`
    );
  }
  if (s.run?.facts) {
    text.push(`## Terminal facts\n\n${factsLedger(s)}`);
  }
  if (bodyFindings(s).length > 0) {
    text.push(
      `## Annotations\n\n${bodyFindings(s).length} Finding${bodyFindings(s).length === 1 ? "" : "s"} outside the diff ${bodyFindings(s).length === 1 ? "is" : "are"} annotated below at ${bodyFindings(s).length === 1 ? "its" : "their"} exact line.`
    );
  }

  const annotations: Annotation[] = bodyFindings(s).map((f) => ({
    path: f.location.path,
    start_line: f.location.startLine,
    end_line: f.location.endLine,
    annotation_level: annotationLevel(f.severity),
    title: `${f.severity} · ${f.verification} · outside the diff`,
    message: `${f.title}\n\n${f.body}`,
    raw_details: `anchoredText: ${f.anchoredText}`,
  }));

  return {
    externalId: c.externalId,
    name: c.name,
    title: `${s.run?.status ?? "no run"} · ${s.findings.length} finding${s.findings.length === 1 ? "" : "s"}`,
    summary,
    text: text.length > 0 ? text.join("\n\n") : null,
    status: c.status,
    conclusion: c.conclusion,
    annotations,
  };
};

const configCheck = (s: Scenario, c: CheckSubject): RenderedCheck => {
  const cfg = s.config;
  if (!cfg) {
    throw new Error("config scenario without a config report");
  }
  if (!cfg.valid && cfg.error) {
    return {
      externalId: c.externalId,
      name: c.name,
      title: `invalid · ${cfg.filePath}:${cfg.error.line}`,
      summary: [
        "| | |",
        "| --- | --- |",
        `| file | \`${cfg.filePath}\` at \`${shortSha(s.pullRequest.headSha)}\` |`,
        `| key | \`${cfg.error.keyPath}\` |`,
        `| line | ${cfg.error.line} |`,
        "| applied | never - this Check reads the head, it does not apply it |",
        `| external_id | \`${c.externalId}\` |`,
      ].join("\n"),
      text: `## Error\n\n${cfg.error.message}\n\n## Effect if merged\n\nEvery review on the default branch would end in a control-plane Refusal until this key is fixed or removed.`,
      status: c.status,
      conclusion: c.conclusion,
      annotations: [
        {
          path: cfg.filePath,
          start_line: cfg.error.line,
          end_line: cfg.error.line,
          annotation_level: "failure",
          title: `unknown key \`${cfg.error.keyPath}\``,
          message: cfg.error.message,
        },
      ],
    };
  }
  return {
    externalId: c.externalId,
    name: c.name,
    title: `valid · ${cfg.effective.length} keys, ${cfg.narrowed.length} narrowed`,
    summary: [
      "| | |",
      "| --- | --- |",
      `| file | \`${cfg.filePath}\` at \`${shortSha(s.pullRequest.headSha)}\` |`,
      "| verdict | valid |",
      `| narrowed | ${cfg.narrowed.length} |`,
      "| applied | never - this reports what would apply if merged |",
      `| external_id | \`${c.externalId}\` |`,
    ].join("\n"),
    text: [
      "## Would apply if merged",
      "",
      "| key | effective | source |",
      "| --- | --- | --- |",
      ...cfg.effective.map((e) => `| \`${e.key}\` | \`${e.value}\` | ${e.note ?? ""} |`),
      "",
      "## Requested versus effective",
      "",
      "| key | requested | effective | narrowed by |",
      "| --- | --- | --- | --- |",
      ...cfg.narrowed.map(
        (n) => `| \`${n.key}\` | \`${n.requested}\` | \`${n.effective}\` | ${n.by} |`
      ),
    ].join("\n"),
    status: c.status,
    conclusion: c.conclusion,
    annotations: [],
  };
};

const noopCheck = (c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: `no-op · ${c.noop?.reason}`,
  summary: [
    "| | |",
    "| --- | --- |",
    "| re-run | received |",
    "| action | none |",
    `| why | ${c.noop?.detail} |`,
    `| conclusion | \`${c.reassertedFrom}\`, re-asserted unchanged |`,
    `| external_id | \`${c.externalId}\` |`,
  ].join("\n"),
  text: null,
  status: c.status,
  conclusion: c.conclusion,
  annotations: [],
});

const progressCheck = (s: Scenario, c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: c.status === "queued" ? "queued" : "executing",
  summary: [
    "| | |",
    "| --- | --- |",
    `| run | \`${s.run?.id.slice(0, 8)}\` |`,
    `| status | \`${c.status === "queued" ? "queued" : "executing"}\` |`,
    `| head | \`${shortSha(s.pullRequest.headSha)}\` |`,
    `| findings so far | none are published before the Run ends |`,
    `| external_id | \`${c.externalId}\` |`,
  ].join("\n"),
  text: null,
  status: c.status,
  conclusion: null,
  annotations: [],
});

export const render = (s: Scenario): Rendering => ({
  review: s.review ? { event: s.review.event, body: reviewBody(s) ?? "" } : null,
  comments: comments(s),
  checks: s.checks.map((c) => {
    if (c.kind === "config") {
      return configCheck(s, c);
    }
    if (c.kind === "noop") {
      return noopCheck(c);
    }
    if (c.kind === "progress") {
      return progressCheck(s, c);
    }
    return reviewCheck(s, c);
  }),
});

export const variant = {
  id: "C",
  name: "Ledger",
  blurb:
    "The Review body is an index table of every Finding; the Check `text` is the full ledger including suppressed Findings; Findings outside the diff are Check annotations rather than review-body prose.",
  render,
};
