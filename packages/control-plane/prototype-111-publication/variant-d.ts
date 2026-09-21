/**
 * Variant D - composite, and the default.
 *
 * C's index table is the base, A's one-line verdict and single facts table are
 * the pieces kept from it, and B is gone: prose blobs cannot be read at a glance.
 *
 * Nothing on this surface is a paragraph. The Review body is a verdict line and
 * an index of every Finding it carries; `unfinished` and Limitations are
 * labelled lines, not sentences. The Check title carries the verdict, the
 * summary carries the verdict line and the facts table, and the text carries the
 * full ledger including everything that was never published.
 *
 * Emoji set, complete and closed: 🟥 🟧 🟨 ⬜ for Severity, ✅ and ❌ for the two
 * Verifications that involved executing something and for a terminal Check
 * outcome. `static` carries no mark, because nothing was run. Nothing decorative
 * and nothing alarm-style.
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
import type { CheckSubject, Finding, Scenario, TerminalFacts } from "./types.ts";

const SEV: Record<string, string> = {
  critical: "🟥",
  high: "🟧",
  medium: "🟨",
  low: "⬜",
};

/** `static` gets no mark: a check or a cross would both claim an execution. */
const VERIF: Record<string, string> = {
  verified: "✅ verified",
  inconclusive: "❌ inconclusive",
  static: "static",
};

const NOOP_TITLE: Record<string, string> = {
  stale_head: "Re-run ignored: head is stale",
  closed: "Re-run ignored: pull request is closed",
  equivalent_live_run: "Re-run ignored: an equivalent review is already running",
};

const commentAnchor = (s: Scenario, index: number) =>
  `${prUrl(s)}#discussion_r90000000${index}`;

const checksTabUrl = (s: Scenario) => `${prUrl(s)}/checks`;

const sorted = (list: Finding[]) =>
  [...list].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

const sevPhrase = (findings: Finding[]) =>
  ["critical", "high", "medium", "low"]
    .map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.sev}`)
    .join(", ");

/** A's one line, reused verbatim by the Review body, the Check title and the summary. */
const verdictLine = (s: Scenario) => {
  const run = s.run;
  const rns = reasonAndNextStep(s);
  if (s.refusalRecord || run?.status === "unscheduled" || run?.status === "failed") {
    return `**${rns?.headline ?? "The review did not run"}.**`;
  }
  if (run?.result?.completeness === "partial" && s.findings.length === 0) {
    return "**Unfinished, and no Finding was made.** This is not a clean bill of health.";
  }
  if (s.findings.length === 0) {
    return `**No findings.** ${run?.result?.disprovedHypothesisCount ?? 0} hypotheses were disproved by execution.`;
  }
  const published = s.findings.filter((f) => f.publicationDisposition !== "suppressed_threshold");
  const unfinished =
    run?.result?.stoppedBy === "reviewer_stopped" ? " **Unfinished.**" : "";
  const where = [
    `${commentFindings(s).length} commented`,
    bodyFindings(s).length > 0 ? `${bodyFindings(s).length} outside the diff` : null,
    s.prior && s.findings.some((f) => f.publicationDisposition === "suppressed_dedupe")
      ? `${s.findings.filter((f) => f.publicationDisposition === "suppressed_dedupe").length} carried over`
      : null,
  ].filter((x) => x !== null);
  return `**${sevPhrase(published)}.** ${where.join(", ")}.${unfinished}`;
};

const checkTitle = (s: Scenario) => {
  const rns = reasonAndNextStep(s);
  if (rns) {
    return rns.headline;
  }
  if (s.findings.length === 0) {
    return "No findings";
  }
  const published = s.findings.filter((f) => f.publicationDisposition !== "suppressed_threshold");
  return sevPhrase(published);
};

const factsTable = (facts: TerminalFacts) =>
  [
    "| | |",
    "| --- | --- |",
    `| Harness | \`${facts.harness.value}\` (${facts.harness.provenance}) |`,
    `| Model | \`${facts.model.value}\` (${facts.model.provenance}) |`,
    `| Autonomy | \`${facts.autonomy.value}\` (${facts.autonomy.provenance}) |`,
    `| Deadline | \`${facts.deadline.value}\` (${facts.deadline.provenance}) |`,
    `| Duration | ${duration(facts.durationMs)} |`,
    `| Usage | ${usageLine(facts.usage)} |`,
    `| Estimated cost | ${cost(facts.estimatedCostUsd)} under \`${facts.pricingRevision}\` |`,
    `| Lineage qualification | \`${facts.qualification}\` |`,
    `| Provider drift | ${driftLine(facts)} |`,
  ].join("\n");

// --- Review body -------------------------------------------------------------

const indexRow = (s: Scenario, f: Finding) => {
  const inline = commentFindings(s);
  const prior = s.prior?.recurring.find((r) => r.key === f.key)?.priorCommentUrl;
  let target = fileUrl(s, f.location.path, f.location.startLine);
  let mark = "";
  if (f.publicationDisposition === "inline_comment") {
    target = commentAnchor(s, inline.indexOf(f));
  } else if (f.publicationDisposition === "review_body") {
    target = checksTabUrl(s);
    mark = " - outside the diff";
  } else if (f.publicationDisposition === "suppressed_dedupe" && prior) {
    target = prior;
    mark = " - still open from the previous review";
  }
  return `| ${SEV[f.severity]} ${f.severity} | ${VERIF[f.verification]} | [\`${loc(f)}\`](${target}) | ${f.title}${mark} |`;
};

const reviewBody = (s: Scenario): string | null => {
  if (!s.review) {
    return null;
  }
  const run = s.run;
  const out: string[] = [verdictLine(s)];

  const indexed = s.findings.filter((f) => f.publicationDisposition !== "suppressed_threshold");
  if (indexed.length > 0) {
    out.push(
      [
        "| sev | verification | location | finding |",
        "| --- | --- | --- | --- |",
        ...sorted(indexed).map((f) => indexRow(s, f)),
      ].join("\n")
    );
  }

  if (bodyFindings(s).length > 0) {
    out.push(
      `**Outside the diff:** ${bodyFindings(s).length}. GitHub cannot anchor a Comment there, so ${bodyFindings(s).length === 1 ? "it is" : "they are"} annotated at ${bodyFindings(s).length === 1 ? "its" : "their"} exact line in the Checks tab.`
    );
  }

  if (run?.result?.stoppedBy === "reviewer_stopped" && run.result.unfinished) {
    out.push(`**Not reviewed:** ${run.result.unfinished}`);
  }

  const gone = s.prior?.gone ?? [];
  if (gone.length > 0) {
    out.push(
      [
        `**No longer reported:** ${gone.length} earlier Finding${gone.length === 1 ? "" : "s"}.`,
        "",
        "<details><summary>Which ones</summary>",
        "",
        ...gone.map((g) => `- \`${g.path}\` - ${g.title}`),
        "",
        "</details>",
      ].join("\n")
    );
  }

  const below = s.findings.filter((f) => f.publicationDisposition === "suppressed_threshold");
  if (below.length > 0) {
    out.push(
      `**Below threshold:** ${below.length} Finding${below.length === 1 ? "" : "s"} (${sevPhrase(below)}), kept out by \`threshold.severity: ${s.threshold.severity}\`. Full rows are in the Check.`
    );
  }

  const lim = run?.result?.limitations ?? [];
  for (const l of lim) {
    out.push(`**Limitation** \`${l.kind}\`: ${l.detail}`);
  }

  out.push(
    `<sub>Run \`${run?.id.slice(0, 8)}\` at \`${shortSha(s.pullRequest.headSha)}\` · threshold \`${s.threshold.severity}\`/\`${s.threshold.verification}\` · terminal facts and full ledger in the Checks tab</sub>`
  );
  return out.join("\n\n");
};

// --- Comments ----------------------------------------------------------------

const evidenceBlock = (f: Finding) =>
  f.evidence
    .map((e) => {
      const exit = e.exitCode === null ? "no exit code" : `exit ${e.exitCode}`;
      const trunc = e.truncated ? `, truncated from ${e.originalByteLength} bytes` : "";
      return [
        `<details><summary>Evidence: <code>${e.command}</code> (${exit}, ${Math.round(e.durationMs / 1000)}s${trunc})</summary>`,
        "",
        "```text",
        e.excerpt,
        "```",
        "",
        "</details>",
      ].join("\n");
    })
    .join("\n\n");

const comments = (s: Scenario): RenderedComment[] =>
  commentFindings(s).map((f) => {
    const parts = [
      `${SEV[f.severity]} **${f.severity}** · ${VERIF[f.verification]} - **${f.title}**`,
      f.body,
    ];
    if (f.evidence.length === 0) {
      parts.push("<sub>Reasoned only. Nothing was executed to prove this.</sub>");
    } else {
      parts.push(evidenceBlock(f));
    }
    return {
      findingKey: f.key,
      path: f.location.path,
      line: f.location.endLine,
      startLine: f.location.startLine,
      body: parts.join("\n\n"),
    };
  });

// --- Checks ------------------------------------------------------------------

const ledger = (s: Scenario) =>
  [
    "| sev | verification | location | finding | disposition | reconciliation |",
    "| --- | --- | --- | --- | --- | --- |",
    ...sorted(s.findings).map(
      (f) =>
        `| ${SEV[f.severity]} ${f.severity} | ${VERIF[f.verification]} | \`${loc(f)}\` | ${f.title} | \`${f.publicationDisposition}\` | \`${f.reconciliation}\` |`
    ),
  ].join("\n");

const reviewCheck = (s: Scenario, c: CheckSubject): RenderedCheck => {
  const run = s.run;
  const rns = reasonAndNextStep(s);

  const summary = [verdictLine(s)];
  if (rns) {
    summary.push(rns.reason, `**Next:** ${rns.nextStep}`);
  }
  if (s.noReviewBecause) {
    summary.push(`**No Review published.** ${s.noReviewBecause}`);
  }
  if (run?.facts) {
    summary.push(factsTable(run.facts));
  }

  const text: string[] = [];
  if (s.findings.length > 0) {
    text.push(
      `## Every Finding this Run made\n\nIncluding the ones no Comment was posted for.\n\n${ledger(s)}`
    );
  }
  if (s.prior) {
    text.push(
      [
        "## Against the previous Run",
        "",
        "| | |",
        "| --- | --- |",
        `| prior Run | \`${s.prior.runId.slice(0, 8)}\` |`,
        `| Comments suppressed as recurring | ${s.prior.recurring.length} |`,
        `| earlier Findings no longer reported | ${s.prior.gone.length} |`,
      ].join("\n")
    );
  }
  if (run?.refusals.length) {
    const r = run.refusals[0];
    text.push(
      [
        "## Refusal",
        "",
        "| | |",
        "| --- | --- |",
        `| reason | \`${r.reason}\` |`,
        `| required | ${r.required} |`,
        `| actual | ${r.actual} |`,
        `| origin | ${r.origin === "worker" ? "the Worker, after dispatch and before authorization" : "the control plane, before any Run existed"} |`,
      ].join("\n")
    );
  }
  if (s.refusalRecord) {
    const r = s.refusalRecord.refusal;
    text.push(
      [
        "## Refusal",
        "",
        "| | |",
        "| --- | --- |",
        `| reason | \`${r.reason}\` |`,
        `| key | \`${r.keyPath}\`${r.line ? ` (line ${r.line})` : ""} |`,
        `| required | ${r.required} |`,
        `| found | ${r.actual} |`,
        `| read from | \`${shortSha(s.pullRequest.baseSha)}\`, the base of this pull request |`,
      ].join("\n")
    );
  }
  const outside = bodyFindings(s);
  if (outside.length > 0) {
    text.push(
      `## Annotations\n\n${outside.length} Finding${outside.length === 1 ? "" : "s"} outside the diff, annotated below at ${outside.length === 1 ? "its" : "their"} exact line.`
    );
  }
  text.push(`<sub>\`external_id: ${c.externalId}\`</sub>`);

  const annotations: Annotation[] = outside.map((f) => ({
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
    title: checkTitle(s),
    summary: summary.join("\n\n"),
    text: text.join("\n\n"),
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
      title: `Invalid: ${cfg.error.keyPath} (line ${cfg.error.line})`,
      summary: [
        `**\`${cfg.filePath}\` would not load.** ${cfg.error.message}`,
        `**Next:** fix \`${cfg.error.keyPath}\` (line ${cfg.error.line} of \`${cfg.filePath}\`) on this branch.`,
        "This pull request is still reviewed under the base branch's configuration; a pull request cannot change the configuration used to review itself.",
      ].join("\n\n"),
      text: [
        "## Effect if merged",
        "",
        "Every review on the default branch ends in a control-plane Refusal until this key is fixed or removed.",
        "",
        `<sub>\`external_id: ${c.externalId}\`</sub>`,
      ].join("\n"),
      status: c.status,
      conclusion: c.conclusion,
      annotations: [
        {
          path: cfg.filePath,
          start_line: cfg.error.line,
          end_line: cfg.error.line,
          annotation_level: "failure",
          title: `unknown key ${cfg.error.keyPath}`,
          message: cfg.error.message,
        },
      ],
    };
  }
  return {
    externalId: c.externalId,
    name: c.name,
    title: `Valid: ${cfg.effective.length} keys, ${cfg.narrowed.length} narrowed`,
    summary: [
      `**\`${cfg.filePath}\` would load.** This reports what would apply if merged, and is never applied to this pull request.`,
      ...cfg.narrowed.map(
        (n) =>
          `**\`${n.key}\`:** requested \`${n.requested}\`, effective \`${n.effective}\` (${n.by}).`
      ),
    ].join("\n\n"),
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
      "",
      `<sub>\`external_id: ${c.externalId}\`</sub>`,
    ].join("\n"),
    status: c.status,
    conclusion: c.conclusion,
    annotations: [],
  };
};

const NOOP_NEXT: Record<string, string> = {
  stale_head: "Re-run the Check on the current head, or push again.",
  closed: "Reopen the pull request, then re-run.",
  equivalent_live_run:
    "Wait for the live review to finish; re-running after it ends creates a fresh review.",
};

const noopCheck = (c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: NOOP_TITLE[c.noop?.reason ?? ""] ?? "Re-run ignored",
  summary: [
    `**Nothing ran:** ${c.noop?.detail}. **Next:** ${NOOP_NEXT[c.noop?.reason ?? ""] ?? "re-run once the cause is gone."}`,
    `The conclusion is the one this Check already carried (\`${c.reassertedFrom}\`), re-asserted unchanged.`,
    `<sub>\`external_id: ${c.externalId}\`</sub>`,
  ].join("\n\n"),
  text: null,
  status: c.status,
  conclusion: c.conclusion,
  annotations: [],
});

const progressCheck = (s: Scenario, c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: c.status === "queued" ? "Queued" : "Reviewing",
  summary: [
    c.status === "queued"
      ? `**Queued** for \`${shortSha(s.pullRequest.headSha)}\`. A Run that is created or claimed reports \`queued\`; nothing has been spent.`
      : `**Reviewing** \`${shortSha(s.pullRequest.headSha)}\`. The Run is \`executing\`, which the hosted pass writes as its own first step.`,
    `<sub>\`external_id: ${c.externalId}\`</sub>`,
  ].join("\n\n"),
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
  id: "D",
  name: "Composite",
  blurb:
    "C's index table with A's verdict line and facts table, no prose. Out-of-diff Findings are annotations; the Check title carries the verdict; the Check text carries the full ledger.",
  render,
};
