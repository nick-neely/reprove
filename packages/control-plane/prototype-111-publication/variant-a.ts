/**
 * Variant A - terse.
 *
 * Information hierarchy: the verdict is one line and everything else is a single
 * facts table. Evidence never occupies vertical space; it is always behind a
 * `<details>`. The Check carries no `text` at all, so the whole terminal record
 * fits in the summary GitHub shows collapsed in the Checks list.
 */

import {
  type Annotation,
  bodyFindings,
  commentFindings,
  cost,
  driftLine,
  duration,
  loc,
  provenanced,
  type RenderedCheck,
  type RenderedComment,
  type Rendering,
  reasonAndNextStep,
  shortSha,
  suppressedFindings,
  usageLine,
} from "./common.ts";
import type { CheckSubject, Finding, Scenario, TerminalFacts } from "./types.ts";

const tag = (f: Finding) => `\`${f.severity}\` · \`${f.verification}\``;

const evidenceBlock = (f: Finding) =>
  f.evidence
    .map((e) => {
      const exit = e.exitCode === null ? "no exit code" : `exit ${e.exitCode}`;
      const trunc = e.truncated
        ? ` · truncated from ${e.originalByteLength} bytes`
        : "";
      return [
        "<details><summary>Evidence: <code>" +
          e.command.replaceAll("<", "&lt;") +
          `</code> (${exit}, ${Math.round(e.durationMs / 1000)}s${trunc})</summary>`,
        "",
        "```text",
        e.excerpt,
        "```",
        "",
        "</details>",
      ].join("\n");
    })
    .join("\n\n");

const factsTable = (facts: TerminalFacts) =>
  [
    "| | |",
    "| --- | --- |",
    `| Harness | ${provenanced(facts.harness)} |`,
    `| Model | ${provenanced(facts.model)} |`,
    `| Autonomy | ${provenanced(facts.autonomy)} |`,
    `| Deadline | ${provenanced(facts.deadline)} |`,
    `| Duration | ${duration(facts.durationMs)} |`,
    `| Usage | ${usageLine(facts.usage)} |`,
    `| Estimated cost | ${cost(facts.estimatedCostUsd)} under \`${facts.pricingRevision}\` |`,
    `| Qualification | \`${facts.qualification}\` |`,
    `| Provider drift | ${driftLine(facts)} |`,
  ].join("\n");

const verdict = (s: Scenario) => {
  const c = commentFindings(s).length;
  const b = bodyFindings(s).length;
  const sup = suppressedFindings(s).length;
  const run = s.run;
  if (run?.result?.completeness === "partial" && s.findings.length === 0) {
    return "**Reprove did not finish and made no claim.** Nothing below is a clean bill of health.";
  }
  if (s.findings.length === 0) {
    return `**Reprove found nothing.** ${run?.result?.disprovedHypothesisCount ?? 0} hypotheses were disproved by execution.`;
  }
  const counts = ["critical", "high", "medium", "low"]
    .map((sev) => ({
      sev,
      n: s.findings.filter((f) => f.severity === sev).length,
    }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.sev}`)
    .join(", ");
  const unfinished =
    run?.result?.stoppedBy === "reviewer_stopped" ? " **This review is unfinished.**" : "";
  return `**${counts}.** ${c} comment${c === 1 ? "" : "s"}, ${b} outside the diff, ${sup} not published.${unfinished}`;
};

const reviewBody = (s: Scenario): string | null => {
  if (!s.review) {
    return null;
  }
  const run = s.run;
  const out: string[] = [verdict(s)];

  const rns = reasonAndNextStep(s);
  if (rns) {
    out.push(`> ${rns.headline}. ${rns.reason}`, `> **Next:** ${rns.nextStep}`);
  }

  const outside = bodyFindings(s);
  if (outside.length > 0) {
    out.push("**Outside the diff** (GitHub cannot anchor a Comment there)");
    out.push(
      outside
        .map((f) => `- \`${loc(f)}\` ${tag(f)} - ${f.title}\n\n  ${f.body}`)
        .join("\n")
    );
  }

  const recurring = s.findings.filter((f) => f.publicationDisposition === "suppressed_dedupe");
  if (recurring.length > 0 && s.prior) {
    out.push(
      `**Already reported** (${recurring.length}, no new comment): ` +
        recurring
          .map((f) => {
            const link = s.prior?.recurring.find((r) => r.key === f.key)?.priorCommentUrl;
            return `[\`${loc(f)}\`](${link}) ${tag(f)}`;
          })
          .join(", ")
    );
  }

  const lim = run?.result?.limitations ?? [];
  if (lim.length > 0) {
    out.push(
      `**Limitations:** ` + lim.map((l) => `\`${l.kind}\` ${l.detail}`).join("; ") + "."
    );
  }

  if (run?.facts) {
    out.push(factsTable(run.facts));
  }
  out.push(
    `<sub>Run \`${run?.id.slice(0, 8)}\` · head \`${shortSha(s.pullRequest.headSha)}\` · threshold \`${s.threshold.severity}\`/\`${s.threshold.verification}\`</sub>`
  );
  return out.join("\n\n");
};

const comments = (s: Scenario): RenderedComment[] =>
  commentFindings(s).map((f) => {
    const parts = [`${tag(f)} **${f.title}**`, f.body];
    if (f.evidence.length > 0) {
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

const configCheck = (s: Scenario, c: CheckSubject): RenderedCheck => {
  const cfg = s.config;
  if (!cfg) {
    throw new Error("config scenario without a config report");
  }
  if (!cfg.valid && cfg.error) {
    return {
      externalId: c.externalId,
      name: c.name,
      title: `Invalid at line ${cfg.error.line}`,
      summary: [
        `**\`${cfg.filePath}\` line ${cfg.error.line}: ${cfg.error.message}**`,
        "",
        "Nothing here has been applied. This Check reads the head file only; the review below ran under the base branch's configuration.",
      ].join("\n"),
      text: null,
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
  const rows = cfg.effective
    .map((e) => `| \`${e.key}\` | ${e.value} | ${e.note ?? ""} |`)
    .join("\n");
  const narrowed = cfg.narrowed
    .map(
      (n) =>
        `| \`${n.key}\` | requested \`${n.requested}\` | **effective \`${n.effective}\`** | ${n.by} |`
    )
    .join("\n");
  return {
    externalId: c.externalId,
    name: c.name,
    title: "Valid; this is what would apply",
    summary: [
      "**Valid.** If this merges, the next review runs under:",
      "",
      "| key | value | |",
      "| --- | --- | --- |",
      rows,
      "",
      "| narrowed | requested | effective | by |",
      "| --- | --- | --- | --- |",
      narrowed,
      "",
      "Not applied to this pull request: a pull request cannot change the configuration used to review itself.",
    ].join("\n"),
    text: null,
    status: c.status,
    conclusion: c.conclusion,
    annotations: [],
  };
};

const noopCheck = (c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: `Nothing ran (${c.noop?.reason})`,
  summary: [
    `**Re-run received; nothing ran.** ${c.noop?.detail}.`,
    "",
    `The conclusion below is the one this Check already carried (\`${c.reassertedFrom}\`); it has been re-asserted unchanged.`,
  ].join("\n"),
  text: null,
  status: c.status,
  conclusion: c.conclusion,
  annotations: [],
});

const progressCheck = (s: Scenario, c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: c.status === "queued" ? "Queued" : "Reviewing",
  summary:
    c.status === "queued"
      ? `**Queued** for \`${shortSha(s.pullRequest.headSha)}\`. No Worker has claimed it yet.`
      : `**Reviewing** \`${shortSha(s.pullRequest.headSha)}\`. Harness \`codex\`, autonomy \`verify\`.`,
  text: null,
  status: c.status,
  conclusion: null,
  annotations: [],
});

const reviewCheck = (s: Scenario, c: CheckSubject): RenderedCheck => {
  const run = s.run;
  const rns = reasonAndNextStep(s);
  const lines: string[] = [];
  lines.push(verdict(s));
  if (rns) {
    lines.push("", `${rns.reason}`, "", `**Next:** ${rns.nextStep}`);
  }
  if (s.noReviewBecause) {
    lines.push("", `_No Review was published. ${s.noReviewBecause}_`);
  }
  if (run?.facts) {
    lines.push("", factsTable(run.facts));
  }
  lines.push("", `<sub>\`external_id: ${c.externalId}\`</sub>`);
  const title =
    rns?.headline ??
    (s.findings.length === 0 ? "No findings" : `${s.findings.length} findings`);
  return {
    externalId: c.externalId,
    name: c.name,
    title,
    summary: lines.join("\n"),
    text: null,
    status: c.status,
    conclusion: c.conclusion,
    annotations: [],
  };
};

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
  id: "A",
  name: "Terse",
  blurb:
    "One-line verdict, one facts table, Evidence collapsed. The Check carries no `text`, so everything terminal lives in the summary.",
  render,
};

export type { Annotation };
