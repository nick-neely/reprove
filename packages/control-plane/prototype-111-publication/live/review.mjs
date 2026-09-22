#!/usr/bin/env node
// Throwaway. Posts one Review as the App with line-anchored Comments, so the
// markdown the paper prototype already wrote under out/D/ can be posted
// verbatim and looked at in GitHub's own renderer.
import { readFile } from "node:fs/promises";
import { parse, print, requester, require_ } from "./lib.mjs";

const usage = `node review.mjs --number <n> --sha <sha> --body-file <path>
                  [--event COMMENT|APPROVE|REQUEST_CHANGES]
                  [--comment <path>:<line>:<body-file> ...]
                  [--dry-run]

Every body comes from a file, so out/D/<scenario>/review.md and comment-N.md
post unchanged. --comment repeats. Each comment anchors with side RIGHT at
<line> of <path>; a line outside the diff is rejected by GitHub, which is the
difference between a Review comment and a Check annotation.

Prints {reviewId, state, html_url, comments:[{id, path, line, html_url}]}.`;

const { values, dryRun } = parse(
  process.argv.slice(2),
  {
    number: { type: "string" },
    sha: { type: "string" },
    "body-file": { type: "string" },
    event: { type: "string" },
    comment: { type: "string", multiple: true },
  },
  { usage },
);

require_(values, ["number", "sha", "body-file"], usage);

const api = requester({ dryRun });
const pull_number = Number(values.number);

const comments = [];
for (const spec of values.comment ?? []) {
  // path:line:body-file, split from the left twice so a body path may contain
  // colons.
  const first = spec.indexOf(":");
  const second = spec.indexOf(":", first + 1);
  if (first < 1 || second < 0) {
    process.stderr.write(`--comment "${spec}" is not <path>:<line>:<body-file>.\n`);
    process.exit(1);
  }
  const path = spec.slice(0, first);
  const line = Number(spec.slice(first + 1, second));
  const bodyFile = spec.slice(second + 1);
  if (!Number.isInteger(line)) {
    process.stderr.write(`--comment "${spec}" has a non-integer line.\n`);
    process.exit(1);
  }
  comments.push({
    path,
    line,
    side: "RIGHT",
    body: await readFile(bodyFile, "utf8"),
  });
}

const { data: review } = await api.request(
  "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  {
    pull_number,
    commit_id: values.sha,
    event: values.event ?? "COMMENT",
    body: await readFile(values["body-file"], "utf8"),
    comments,
  },
);

if (!review) {
  process.exit(0);
}

const { data: posted } = await api.request(
  "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
  { pull_number, per_page: 100 },
);

print({
  reviewId: review.id,
  state: review.state,
  html_url: review.html_url,
  comments: (posted ?? [])
    .filter((comment) => comment.pull_request_review_id === review.id)
    .map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      html_url: comment.html_url,
    })),
});
