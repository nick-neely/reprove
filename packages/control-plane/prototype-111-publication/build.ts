/**
 * Throwaway prototype for issue #111. Run with `pnpm proto:111`.
 *
 * Writes raw markdown per variant per scenario, so a rendering can later be
 * posted to a real pull request verbatim, plus one self-contained `out/index.html`
 * that opens by double click.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS, type Rendering, type RenderedCheck } from "./common.ts";
import { scenarios } from "./fixtures.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Finding, Scenario } from "./types.ts";
import { variant as variantA } from "./variant-a.ts";
import { variant as variantB } from "./variant-b.ts";
import { variant as variantC } from "./variant-c.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");

const variants = [variantA, variantB, variantC];

const esc = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// --- GitHub write-surface honesty checks -------------------------------------

type LimitNote = { ok: boolean; text: string };

const checkLimits = (c: RenderedCheck): LimitNote[] => [
  {
    ok: c.summary.length <= LIMITS.checkSummaryChars,
    text: `summary ${c.summary.length} / ${LIMITS.checkSummaryChars} chars`,
  },
  {
    ok: (c.text?.length ?? 0) <= LIMITS.checkTextChars,
    text: `text ${c.text?.length ?? 0} / ${LIMITS.checkTextChars} chars`,
  },
  {
    ok: c.annotations.length <= LIMITS.annotationsPerRequest,
    text: `annotations ${c.annotations.length} / ${LIMITS.annotationsPerRequest} per request`,
  },
  ...c.annotations.map((a) => ({
    ok: a.title.length <= LIMITS.annotationTitleChars,
    text: `annotation title ${a.title.length} / ${LIMITS.annotationTitleChars} chars`,
  })),
];

/** A Comment must land inside a hunk, or GitHub rejects the whole review. */
const commentAnchorNote = (s: Scenario, findingKey: string, line: number): LimitNote => {
  const finding = s.findings.find((f) => f.key === findingKey);
  const hunkLines = (finding?.hunk?.lines ?? [])
    .map((l) => l.line)
    .filter((l): l is number => l !== null);
  const inside = hunkLines.includes(line);
  return {
    ok: inside,
    text: inside
      ? `anchored at line ${line}, inside the hunk`
      : `line ${line} is NOT inside any hunk - GitHub would reject this Comment`,
  };
};

// --- markdown files ----------------------------------------------------------

const writeMarkdown = (variantId: string, s: Scenario, r: Rendering) => {
  const dir = path.join(outDir, variantId, s.id);
  mkdirSync(dir, { recursive: true });

  if (r.review) {
    writeFileSync(
      path.join(dir, "review.md"),
      `<!-- event: ${r.review.event} -->\n\n${r.review.body}\n`
    );
  }
  r.comments.forEach((c, i) => {
    writeFileSync(
      path.join(dir, `comment-${i + 1}.md`),
      `<!-- ${c.path}:${c.startLine}-${c.line} -->\n\n${c.body}\n`
    );
  });
  r.checks.forEach((c, i) => {
    const name = r.checks.length === 1 ? "check.md" : `check-${i + 1}.md`;
    const annotations =
      c.annotations.length === 0
        ? ""
        : `\n\n<!-- annotations -->\n\n\`\`\`json\n${JSON.stringify(c.annotations, null, 2)}\n\`\`\`\n`;
    writeFileSync(
      path.join(dir, name),
      [
        `<!-- name: ${c.name} -->`,
        `<!-- external_id: ${c.externalId} -->`,
        `<!-- status: ${c.status} conclusion: ${c.conclusion ?? "null"} -->`,
        `<!-- title: ${c.title} -->`,
        "",
        "## summary",
        "",
        c.summary,
        "",
        "## text",
        "",
        c.text ?? "_(none)_",
        annotations,
      ].join("\n")
    );
  });
};

// --- mock GitHub surfaces ----------------------------------------------------

const CONCLUSION_ICON: Record<string, string> = {
  success: "✅",
  failure: "❌",
  timed_out: "⏱️",
  cancelled: "🚫",
  neutral: "⚪",
};

const hunkHtml = (f: Finding, anchorLine: number) => {
  if (!f.hunk) {
    return "";
  }
  const rows = f.hunk.lines
    .map((l) => {
      const cls = l.kind === "add" ? "add" : l.kind === "del" ? "del" : "ctx";
      const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      const anchored = l.line === anchorLine ? " anchored" : "";
      return `<tr class="${cls}${anchored}"><td class="ln">${l.line ?? ""}</td><td class="code">${esc(marker + l.text)}</td></tr>`;
    })
    .join("");
  return `<div class="diff"><div class="diff-head">${esc(f.location.path)}</div><div class="hunk-head">${esc(f.hunk.header)}</div><table class="hunk">${rows}</table></div>`;
};

const noteList = (notes: LimitNote[]) =>
  `<ul class="limits">${notes
    .map((n) => `<li class="${n.ok ? "ok" : "bad"}">${n.ok ? "✓" : "✗"} ${esc(n.text)}</li>`)
    .join("")}</ul>`;

const reviewSurface = (s: Scenario, r: Rendering) => {
  if (!r.review) {
    return `<div class="surface"><div class="surface-title">Review</div><div class="empty"><strong>No Review is published.</strong><br />${esc(s.noReviewBecause ?? "")}</div></div>`;
  }
  return `<div class="surface">
  <div class="surface-title">Review</div>
  <div class="gh-box">
    <div class="gh-head"><span class="avatar">R</span><strong>reprove[bot]</strong> reviewed <span class="muted">now</span> <span class="badge badge-${r.review.event.toLowerCase()}">${esc(r.review.event)}</span></div>
    <div class="markdown-body">${renderMarkdown(r.review.body)}</div>
  </div>
</div>`;
};

const commentsSurface = (s: Scenario, r: Rendering) => {
  if (r.comments.length === 0) {
    return `<div class="surface"><div class="surface-title">Comments</div><div class="empty">No Comment is posted. ${esc(
      s.findings.length === 0
        ? "The Run made no Findings."
        : "No Finding has publication_disposition = inline_comment."
    )}</div></div>`;
  }
  const items = r.comments
    .map((c) => {
      const finding = s.findings.find((f) => f.key === c.findingKey);
      const note = commentAnchorNote(s, c.findingKey, c.line);
      return `<div class="comment">
        ${finding ? hunkHtml(finding, c.line) : ""}
        <div class="gh-box comment-box">
          <div class="gh-head"><span class="avatar">R</span><strong>reprove[bot]</strong> <span class="muted">on ${esc(c.path)}:${c.startLine}${c.line === c.startLine ? "" : `-${c.line}`}</span></div>
          <div class="markdown-body">${renderMarkdown(c.body)}</div>
        </div>
        ${noteList([note])}
      </div>`;
    })
    .join("");
  return `<div class="surface"><div class="surface-title">Comments (${r.comments.length})</div>${items}</div>`;
};

const checksSurface = (r: Rendering) => {
  const items = r.checks
    .map((c) => {
      const icon =
        c.conclusion === null
          ? c.status === "queued"
            ? "🕒"
            : "🟡"
          : (CONCLUSION_ICON[c.conclusion] ?? "⚪");
      const annotations =
        c.annotations.length === 0
          ? ""
          : `<div class="annotations"><div class="ann-title">Annotations (${c.annotations.length})</div>${c.annotations
              .map(
                (a) =>
                  `<div class="ann ann-${a.annotation_level}"><code>${esc(a.path)}:${a.start_line}${a.end_line === a.start_line ? "" : `-${a.end_line}`}</code> <strong>${esc(a.title)}</strong><div class="markdown-body">${renderMarkdown(a.message)}</div></div>`
              )
              .join("")}</div>`;
      return `<div class="gh-box check">
        <div class="check-head">${icon} <strong>${esc(c.name)}</strong> <span class="muted">${esc(c.title)}</span>
          <span class="conc">${esc(c.conclusion ?? c.status)}</span>
          <span class="rerun" title="GitHub renders this button on any completed Check">Re-run</span>
        </div>
        <div class="kv"><code>external_id: ${esc(c.externalId)}</code></div>
        <div class="check-section">summary</div>
        <div class="markdown-body">${renderMarkdown(c.summary)}</div>
        ${c.text ? `<div class="check-section">text</div><div class="markdown-body">${renderMarkdown(c.text)}</div>` : '<div class="check-section">text</div><div class="empty small">none</div>'}
        ${annotations}
        ${noteList(checkLimits(c))}
      </div>`;
    })
    .join("");
  return `<div class="surface"><div class="surface-title">Check${r.checks.length === 1 ? "" : `s (${r.checks.length})`}</div>${items}
  <div class="rerun-note">Every Check above carries a native <em>Re-run</em>. A rerequest resets the check <em>suite</em> to <code>queued</code> and clears its conclusion; GitHub does not update the Check Run itself.</div>
  </div>`;
};

const stateSurface = (s: Scenario) => {
  const tables = s.state
    .map(
      (row) =>
        `<div class="state-table"><div class="state-name">${esc(row.table)}</div><table>${Object.entries(
          row.columns
        )
          .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`)
          .join("")}</table></div>`
    )
    .join("");
  const notes =
    s.notes.length === 0
      ? ""
      : `<div class="state-name">notes</div><ul class="notes">${s.notes.map((n) => `<li>${renderMarkdown(n)}</li>`).join("")}</ul>`;
  return `<div class="surface state"><div class="surface-title">State the control plane would write</div>${tables}${notes}</div>`;
};

const panel = (s: Scenario, v: (typeof variants)[number]) => {
  const r = v.render(s);
  writeMarkdown(v.id, s, r);
  return `<section class="panel" data-scenario="${s.id}" data-variant="${v.id}">
  <header class="panel-head">
    <h2>${esc(s.id)} - ${esc(s.name)}</h2>
    <p>${esc(s.blurb)}</p>
    <p class="pr">${esc(s.pullRequest.owner)}/${esc(s.pullRequest.repo)}#${s.pullRequest.number} - ${esc(s.pullRequest.title)} <code>${s.pullRequest.headSha.slice(0, 7)}</code> onto <code>${s.pullRequest.baseSha.slice(0, 7)}</code></p>
  </header>
  <div class="cols">
    <div class="col">${reviewSurface(s, r)}${commentsSurface(s, r)}</div>
    <div class="col">${checksSurface(r)}${stateSurface(s)}</div>
  </div>
</section>`;
};

// --- page --------------------------------------------------------------------

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; color:#1f2328; background:#f6f8fa; }
a { color:#0969da; text-decoration:none; } a:hover { text-decoration:underline; }
code, pre, .code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size:12px; }
#layout { display:flex; min-height:100vh; }
#side { width:250px; flex:0 0 250px; background:#fff; border-right:1px solid #d1d9e0; position:sticky; top:0; height:100vh; overflow:auto; padding:12px 0 60px; }
#side h1 { font-size:13px; margin:8px 16px 4px; text-transform:uppercase; letter-spacing:.04em; color:#59636e; }
#side p { margin:0 16px 12px; font-size:12px; color:#59636e; }
#side a { display:block; padding:7px 16px; color:#1f2328; border-left:3px solid transparent; }
#side a.active { background:#ddf4ff; border-left-color:#0969da; font-weight:600; }
#side a small { display:block; color:#59636e; font-weight:400; }
#main { flex:1; padding:20px 24px 90px; max-width:1700px; }
.panel { display:none; }
.panel.active { display:block; }
.panel-head h2 { margin:0 0 4px; font-size:20px; }
.panel-head p { margin:0 0 6px; color:#59636e; max-width:105ch; }
.panel-head .pr { font-size:12px; }
.cols { display:grid; grid-template-columns: 1fr 1fr; gap:20px; align-items:start; }
@media (max-width: 1500px) { .cols { grid-template-columns: 1fr; } }
.surface { margin-bottom:18px; }
.surface-title { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:#59636e; margin:0 0 6px; font-weight:700; }
.gh-box { background:#fff; border:1px solid #d1d9e0; border-radius:6px; margin-bottom:12px; overflow:hidden; }
.gh-head { padding:8px 12px; background:#f6f8fa; border-bottom:1px solid #d1d9e0; font-size:13px; }
.avatar { display:inline-block; width:18px; height:18px; line-height:18px; text-align:center; border-radius:50%; background:#1f2328; color:#fff; font-size:11px; margin-right:6px; vertical-align:-3px; }
.muted { color:#59636e; font-weight:400; }
.badge { display:inline-block; padding:1px 7px; border-radius:2em; font-size:11px; font-weight:600; border:1px solid; margin-left:6px; }
.badge-comment { color:#59636e; border-color:#d1d9e0; background:#f6f8fa; }
.badge-request_changes { color:#a40e26; border-color:#ffcecb; background:#ffebe9; }
.markdown-body { padding:12px 14px; }
.markdown-body > *:first-child { margin-top:0; }
.markdown-body > *:last-child { margin-bottom:0; }
.markdown-body h1,.markdown-body h2 { font-size:16px; border-bottom:1px solid #d1d9e0; padding-bottom:5px; margin:18px 0 10px; }
.markdown-body h3 { font-size:14px; margin:16px 0 8px; }
.markdown-body h4 { font-size:13px; margin:14px 0 6px; }
.markdown-body p { margin:0 0 12px; }
.markdown-body ul, .markdown-body ol { margin:0 0 12px; padding-left:22px; }
.markdown-body li { margin:3px 0; }
.markdown-body table { border-collapse:collapse; margin:0 0 12px; display:block; overflow:auto; max-width:100%; }
.markdown-body th, .markdown-body td { border:1px solid #d1d9e0; padding:5px 10px; text-align:left; vertical-align:top; }
.markdown-body th { background:#f6f8fa; }
.markdown-body tr:nth-child(2n) td { background:#f6f8fa; }
.markdown-body code { background:#eff1f3; padding:.15em .35em; border-radius:4px; }
.markdown-body pre { background:#f6f8fa; padding:10px 12px; border-radius:6px; overflow:auto; margin:0 0 12px; }
.markdown-body pre code { background:none; padding:0; }
.markdown-body blockquote { border-left:3px solid #d1d9e0; padding:0 0 0 12px; margin:0 0 12px; color:#59636e; }
.markdown-body details { border:1px solid #d1d9e0; border-radius:6px; padding:6px 10px; margin:0 0 12px; background:#f6f8fa; }
.markdown-body summary { cursor:pointer; font-size:12px; }
.markdown-body sub { font-size:11px; color:#59636e; }
.markdown-body hr { border:0; border-top:1px solid #d1d9e0; margin:14px 0; }
.diff { border:1px solid #d1d9e0; border-radius:6px 6px 0 0; border-bottom:0; background:#fff; overflow:hidden; }
.diff-head { padding:6px 12px; background:#f6f8fa; border-bottom:1px solid #d1d9e0; font-family:ui-monospace,monospace; font-size:12px; }
.hunk-head { padding:3px 12px; background:#ddf4ff; color:#0550ae; font-family:ui-monospace,monospace; font-size:11px; }
table.hunk { border-collapse:collapse; width:100%; }
table.hunk td { padding:0 8px; font-family:ui-monospace,monospace; font-size:12px; white-space:pre; }
table.hunk td.ln { width:40px; color:#59636e; text-align:right; user-select:none; background:#f6f8fa; }
table.hunk tr.add td { background:#e6ffec; } table.hunk tr.add td.ln { background:#ccffd8; }
table.hunk tr.del td { background:#ffebe9; } table.hunk tr.del td.ln { background:#ffd7d5; }
table.hunk tr.anchored td { box-shadow: inset 0 0 0 1px #bf8700; }
.comment { margin-bottom:18px; }
.comment-box { border-radius:0 0 6px 6px; margin-bottom:4px; }
.check-head { padding:9px 12px; background:#f6f8fa; border-bottom:1px solid #d1d9e0; }
.check-head .conc { float:right; font-size:11px; font-family:ui-monospace,monospace; color:#59636e; }
.rerun { float:right; margin-right:10px; font-size:11px; border:1px solid #d1d9e0; border-radius:6px; padding:1px 8px; background:#fff; color:#0969da; }
.kv { padding:5px 12px; border-bottom:1px solid #eaeef2; color:#59636e; }
.check-section { padding:5px 12px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#59636e; background:#fafbfc; border-bottom:1px solid #eaeef2; border-top:1px solid #eaeef2; }
.annotations { border-top:1px solid #eaeef2; }
.ann-title { padding:5px 12px; font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:#59636e; background:#fafbfc; }
.ann { padding:8px 12px; border-top:1px solid #eaeef2; border-left:3px solid #bf8700; }
.ann-failure { border-left-color:#cf222e; }
.ann .markdown-body { padding:4px 0 0; }
.empty { background:#fff; border:1px dashed #d1d9e0; border-radius:6px; padding:12px 14px; color:#59636e; }
.empty.small { padding:6px 12px; border:0; border-radius:0; }
ul.limits { list-style:none; margin:0 0 8px; padding:6px 12px; font-size:11px; font-family:ui-monospace,monospace; background:#fff; border:1px solid #eaeef2; border-top:0; }
ul.limits li.ok { color:#1a7f37; } ul.limits li.bad { color:#cf222e; font-weight:700; }
.rerun-note { font-size:12px; color:#59636e; padding:8px 0; }
.state { background:#fff; border:1px solid #d1d9e0; border-radius:6px; padding:12px 14px; }
.state .surface-title { margin-top:0; }
.state-name { font-family:ui-monospace,monospace; font-size:12px; color:#0550ae; margin:10px 0 4px; }
.state table { border-collapse:collapse; width:100%; margin-bottom:6px; }
.state td { border:1px solid #eaeef2; padding:4px 8px; font-size:12px; vertical-align:top; }
.state td.k { width:34%; font-family:ui-monospace,monospace; color:#59636e; }
ul.notes { margin:0; padding-left:18px; font-size:12px; color:#1f2328; }
ul.notes li { margin:6px 0; }
ul.notes p { margin:0; }
#bar { position:fixed; left:50%; transform:translateX(-50%); bottom:16px; background:#1f2328; color:#fff; border-radius:999px; padding:7px 10px; display:flex; gap:6px; align-items:center; box-shadow:0 6px 24px rgba(0,0,0,.25); z-index:10; }
#bar span.label { font-size:11px; text-transform:uppercase; letter-spacing:.06em; opacity:.6; padding:0 6px; }
#bar button { background:transparent; border:1px solid #444c56; color:#fff; border-radius:999px; padding:5px 14px; cursor:pointer; font:inherit; font-size:13px; }
#bar button.active { background:#fff; color:#1f2328; border-color:#fff; font-weight:600; }
#bar em { font-style:normal; font-size:11px; opacity:.7; max-width:520px; padding-left:8px; }
`;

const JS = `
const params = new URLSearchParams(location.search);
let variant = (params.get('variant') || 'A').toUpperCase();
let scenario = location.hash.slice(1) || ${JSON.stringify(scenarios[0].id)};
const blurbs = ${JSON.stringify(Object.fromEntries(variants.map((v) => [v.id, v.name + " - " + v.blurb])))};
function apply() {
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.dataset.variant === variant && p.dataset.scenario === scenario);
  }
  for (const a of document.querySelectorAll('#side a')) {
    a.classList.toggle('active', a.dataset.scenario === scenario);
  }
  for (const b of document.querySelectorAll('#bar button')) {
    b.classList.toggle('active', b.dataset.variant === variant);
  }
  document.getElementById('vblurb').textContent = blurbs[variant];
  const u = new URL(location.href);
  u.searchParams.set('variant', variant);
  u.hash = scenario;
  history.replaceState(null, '', u);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('#bar button');
  if (b) { variant = b.dataset.variant; apply(); return; }
  const a = e.target.closest('#side a');
  if (a) { e.preventDefault(); scenario = a.dataset.scenario; window.scrollTo(0, 0); apply(); }
});
window.addEventListener('keydown', (e) => {
  if (['a','b','c'].includes(e.key.toLowerCase()) && !e.metaKey && !e.ctrlKey) {
    variant = e.key.toUpperCase(); apply();
  }
});
apply();
`;

const build = () => {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const panels: string[] = [];
  for (const s of scenarios) {
    for (const v of variants) {
      panels.push(panel(s, v));
    }
  }

  const nav = scenarios
    .map(
      (s) =>
        `<a href="#${s.id}" data-scenario="${s.id}">${esc(s.id)} <small>${esc(s.name)}</small></a>`
    )
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Reprove #111 - how a Run looks on the pull request</title>
<style>${CSS}</style>
</head>
<body>
<div id="layout">
  <nav id="side">
    <h1>Scenarios</h1>
    <p>Throwaway prototype for issue #111. Press A, B or C to switch variant.</p>
    ${nav}
  </nav>
  <main id="main">
    ${panels.join("\n")}
  </main>
</div>
<div id="bar">
  <span class="label">variant</span>
  ${variants.map((v) => `<button data-variant="${v.id}">${v.id}</button>`).join("")}
  <em id="vblurb"></em>
</div>
<script>${JS}</script>
</body>
</html>`;

  writeFileSync(path.join(outDir, "index.html"), html);

  const failures: string[] = [];
  for (const s of scenarios) {
    for (const v of variants) {
      const r = v.render(s);
      for (const c of r.checks) {
        for (const n of checkLimits(c)) {
          if (!n.ok) {
            failures.push(`${v.id}/${s.id} check: ${n.text}`);
          }
        }
      }
      for (const c of r.comments) {
        const n = commentAnchorNote(s, c.findingKey, c.line);
        if (!n.ok) {
          failures.push(`${v.id}/${s.id} comment: ${n.text}`);
        }
      }
    }
  }

  process.stdout.write(
    `wrote ${scenarios.length} scenarios x ${variants.length} variants to ${outDir}\n`
  );
  if (failures.length > 0) {
    process.stdout.write(`GitHub limit violations:\n  ${failures.join("\n  ")}\n`);
  } else {
    process.stdout.write("no GitHub write-surface limit violations\n");
  }
};

build();
