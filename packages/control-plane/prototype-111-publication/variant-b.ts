/**
 * Variant B - narrative.
 *
 * Information hierarchy: prose first. The Reviewer's own summary is the opening
 * paragraph and everything operational is written as sentences, not as fields.
 * Evidence is inline and always visible, because a claim's proof is the point
 * and hiding it behind a disclosure makes it optional reading. The bounded
 * terminal facts are a single footer line, deliberately the least prominent
 * thing on the surface. The Check keeps its prose in `text` and uses `summary`
 * for the two sentences a reader sees collapsed.
 */

import {
  bodyFindings,
  commentFindings,
  cost,
  driftLine,
  duration,
  loc,
  reasonAndNextStep,
  type RenderedCheck,
  type RenderedComment,
  type Rendering,
  shortSha,
  suppressedFindings,
  usageLine,
} from "./common.ts";
import type { CheckSubject, Finding, Scenario, TerminalFacts } from "./types.ts";

const englishList = (items: string[]) => {
  if (items.length === 0) {
    return "nothing";
  }
  if (items.length === 1) {
    return items[0];
  }
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
};

const factsFooter = (facts: TerminalFacts) => {
  const drift =
    facts.providerDrift === null ? "" : ` The Provider served ${facts.providerDrift.resolved}.`;
  return (
    `<sub>${facts.harness.value} (${facts.harness.provenance}) driving ${facts.model.value} ` +
    `(${facts.model.provenance}) at autonomy ${facts.autonomy.value} (${facts.autonomy.provenance}), ` +
    `deadline ${facts.deadline.value} (${facts.deadline.provenance}), for ${duration(facts.durationMs)}. ` +
    `Usage ${usageLine(facts.usage)}, estimated ${cost(facts.estimatedCostUsd)} under ${facts.pricingRevision}, ` +
    `whose lineage is ${facts.qualification}.${drift}</sub>`
  );
};

const severityPhrase = (s: Scenario) => {
  const bySeverity = ["critical", "high", "medium", "low"]
    .map((sev) => ({ sev, n: s.findings.filter((f) => f.severity === sev).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.sev}`);
  return englishList(bySeverity);
};

const reviewBody = (s: Scenario): string | null => {
  if (!s.review) {
    return null;
  }
  const run = s.run;
  const out: string[] = [];

  if (run?.result) {
    out.push(run.result.summary);
  }

  if (s.findings.length === 0) {
    out.push(
      `I made no claims. ${run?.result?.disprovedHypothesisCount ?? 0} hypotheses were ` +
        "raised and each was disproved by running something, so none of them became a Finding. " +
        "That is a clean review, not an empty one."
    );
  } else {
    const c = commentFindings(s).length;
    out.push(
      `I am reporting ${severityPhrase(s)}. ` +
        (c > 0
          ? `${c} of them ${c === 1 ? "is" : "are"} left as ${c === 1 ? "a comment" : "comments"} on the lines ${c === 1 ? "it" : "they"} concern.`
          : "None of them sits on a line of this diff.")
    );
  }

  if (run?.result?.stoppedBy === "reviewer_stopped" && run.result.unfinished) {
    out.push(
      `**I did not finish.** ${run.result.unfinished} Treat everything above as partial: ` +
        "the absence of a Finding in the part I skipped means nothing at all."
    );
  }

  const outside = bodyFindings(s);
  for (const f of outside) {
    out.push(
      `**${f.title}** - this one is in \`${loc(f)}\`, which this pull request does not touch, ` +
        `so GitHub has nowhere to anchor a comment and it has to live here instead. ` +
        `I rated it ${f.severity} and reached it ${f.verification === "static" ? "by reading only" : `by ${f.verification} execution`}. ` +
        f.body
    );
  }

  const recurring = s.findings.filter((f) => f.publicationDisposition === "suppressed_dedupe");
  for (const f of recurring) {
    const link = s.prior?.recurring.find((r) => r.key === f.key)?.priorCommentUrl;
    out.push(
      `I found **${f.title}** again at \`${loc(f)}\`. I raised it on the previous Run and ` +
        `[the comment is still there](${link}), so I have not posted a second one. It is not fixed.`
    );
  }

  const lim = run?.result?.limitations ?? [];
  for (const l of lim) {
    out.push(
      `One thing about the environment rather than the code: ${l.detail}. That is recorded as ` +
        `a \`${l.kind}\` Limitation. It did not by itself leave the review unfinished.`
    );
  }

  const sup = suppressedFindings(s).filter(
    (f) => f.publicationDisposition === "suppressed_threshold"
  );
  if (sup.length > 0) {
    out.push(
      `${sup.length} further ${sup.length === 1 ? "Finding sits" : "Findings sit"} below this repository's ` +
        `threshold of \`${s.threshold.severity}\` and ${sup.length === 1 ? "is" : "are"} kept out of this review. ` +
        "Lowering the threshold shows them without needing another run."
    );
  }

  if (run?.facts) {
    out.push(factsFooter(run.facts));
  }
  return out.join("\n\n");
};

const evidenceProse = (f: Finding) =>
  f.evidence
    .map((e) => {
      const outcome =
        e.exitCode === null
          ? `It never returned an exit code; I stopped it after ${Math.round(e.durationMs / 1000)}s, which is why this is inconclusive rather than verified.`
          : `It exited ${e.exitCode} after ${Math.round(e.durationMs / 1000)}s.`;
      const trunc = e.truncated
        ? ` I have kept the relevant part of ${e.originalByteLength} bytes of output.`
        : "";
      return [`I ran:\n\n\`\`\`console\n$ ${e.command}\n\`\`\`\n\n${outcome}${trunc}`, "```text", e.excerpt, "```"].join(
        "\n"
      );
    })
    .join("\n\n");

const comments = (s: Scenario): RenderedComment[] =>
  commentFindings(s).map((f) => {
    const standing =
      f.verification === "verified"
        ? "I proved this by running something; the output is below."
        : f.verification === "inconclusive"
          ? "I tried to settle this by running something and it did not settle."
          : "I reached this by reading the code. Nothing was executed to prove it.";
    const parts = [`**${f.title}**`, f.body, standing];
    if (f.evidence.length > 0) {
      parts.push(evidenceProse(f));
    }
    parts.push(
      `<sub>${f.severity} · ${f.verification} · ${loc(f)}</sub>`
    );
    return {
      findingKey: f.key,
      path: f.location.path,
      line: f.location.endLine,
      startLine: f.location.startLine,
      body: parts.join("\n\n"),
    };
  });

const reviewCheck = (s: Scenario, c: CheckSubject): RenderedCheck => {
  const run = s.run;
  const rns = reasonAndNextStep(s);
  const summaryParts: string[] = [];
  const textParts: string[] = [];

  if (rns) {
    summaryParts.push(`${rns.headline}.`, rns.reason, `**What to do:** ${rns.nextStep}`);
  } else if (s.findings.length === 0) {
    summaryParts.push(
      `The review finished. It made no claims, and disproved ${run?.result?.disprovedHypothesisCount ?? 0} hypotheses by running something.`
    );
  } else {
    summaryParts.push(
      `The review finished and reported ${severityPhrase(s)}. Findings are on the pull request, not here: this Check reports whether the review ran, not what it thought.`
    );
  }

  if (s.noReviewBecause) {
    summaryParts.push(`No Review was published. ${s.noReviewBecause}`);
  }

  if (run?.facts) {
    const f = run.facts;
    textParts.push(
      `## What ran\n\nA ${f.harness.value} Harness, ${f.harness.provenance === "configured" ? "named in `.reprove.yml`" : "the product default"}, ` +
        `driving ${f.model.value} (${f.model.provenance}) at autonomy ${f.autonomy.value} (${f.autonomy.provenance}). ` +
        `Its deadline was ${f.deadline.value} (${f.deadline.provenance}) and it ran for ${duration(f.durationMs)}.`
    );
    textParts.push(
      `## What it cost\n\nUsage was ${usageLine(f.usage)}. ` +
        (f.estimatedCostUsd === null
          ? `The cost is **unknown**, not zero: \`${f.pricingRevision}\` does not price this Model, and reporting an unpriced run as $0.00 would be a lie about spend.`
          : `At \`${f.pricingRevision}\` that is an estimated ${cost(f.estimatedCostUsd)}.`) +
        (f.usage.completeness === "complete"
          ? ""
          : ` The aggregate is \`${f.usage.completeness}\`, so the real figure is at least this and possibly more.`)
    );
    textParts.push(
      `## Provenance\n\nThis lineage's qualification status is \`${f.qualification}\`, which means it has never passed the adversarial gate. ` +
        `Provider drift: ${driftLine(f)}.`
    );
  }

  if (run?.refusals.length) {
    const r = run.refusals[0];
    textParts.push(
      `## The refusal\n\nThe Worker was dispatched and stopped before it was authorized to execute. It required ${r.required}, ` +
        `and found ${r.actual}. It named the requirement rather than quietly doing something narrower, which is the point of a Refusal. ` +
        "Nothing is re-offered automatically: the attempt already spent a probe turn and a Sandbox."
    );
  }

  return {
    externalId: c.externalId,
    name: c.name,
    title: rns?.headline ?? (s.findings.length === 0 ? "Finished, no findings" : "Finished"),
    summary: summaryParts.join("\n\n"),
    text: textParts.length > 0 ? `${textParts.join("\n\n")}\n\n<sub>external_id \`${c.externalId}\`</sub>` : null,
    status: c.status,
    conclusion: c.conclusion,
    annotations: [],
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
      title: "This file would not load",
      summary:
        `\`${cfg.filePath}\` on this branch has an unknown key at line ${cfg.error.line}: \`${cfg.error.keyPath}\`. ` +
        "Unknown keys are rejected rather than ignored, so if this merged, every review on the default branch would refuse until it is fixed.",
      text:
        `## What is wrong\n\n${cfg.error.message}\n\n` +
        "## What it does not affect\n\nThis pull request is still being reviewed, under the configuration on the base branch. " +
        "A pull request cannot change the configuration used to review itself, so a broken file here never silently reviews itself under its own new rules.\n\n" +
        `<sub>external_id \`${c.externalId}\`</sub>`,
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
  const prose = cfg.effective
    .map((e) => `${e.key} would be ${e.value} (${e.note})`)
    .join("; ");
  const narrowed = cfg.narrowed
    .map(
      (n) =>
        `You asked for \`${n.key}: ${n.requested}\`, and the effective value would be \`${n.effective}\`, capped by ${n.by}. ` +
        "That is a narrowing rather than a refusal: it moves toward the safe position, so the file is accepted and the cap is reported."
    )
    .join("\n\n");
  return {
    externalId: c.externalId,
    name: c.name,
    title: "This file would load",
    summary:
      `\`${cfg.filePath}\` on this branch parses and every value it names is supported. ` +
      "Merging it changes how the next review runs, not this one.",
    text: `## What would apply\n\n${prose}.\n\n## Narrowed values\n\n${narrowed}\n\n<sub>external_id \`${c.externalId}\`</sub>`,
    status: c.status,
    conclusion: c.conclusion,
    annotations: [],
  };
};

const noopCheck = (c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: "Nothing ran",
  summary:
    `You asked for a re-run and I did not run one, because ${c.noop?.detail}. ` +
    `The conclusion you see is the old one, re-asserted so that the button does not appear to do nothing.`,
  text: null,
  status: c.status,
  conclusion: c.conclusion,
  annotations: [],
});

const progressCheck = (s: Scenario, c: CheckSubject): RenderedCheck => ({
  externalId: c.externalId,
  name: c.name,
  title: c.status === "queued" ? "Waiting for a Worker" : "Reviewing now",
  summary:
    c.status === "queued"
      ? `A review of \`${shortSha(s.pullRequest.headSha)}\` has been created and is waiting for a Worker to take it. Nothing has been spent.`
      : `A Worker is reviewing \`${shortSha(s.pullRequest.headSha)}\` now. Findings will arrive as a review on the pull request; this Check will say whether it finished.`,
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
  id: "B",
  name: "Narrative",
  blurb:
    "Prose summary first, Evidence inline and always visible, facts as one footer line. The Check puts its explanation in `text` and keeps `summary` to two sentences.",
  render,
};
