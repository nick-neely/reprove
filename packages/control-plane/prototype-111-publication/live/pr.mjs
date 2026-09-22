#!/usr/bin/env node
// Throwaway. Makes and moves the pull requests the experiments need, entirely
// through the git data API as the installation, so no local clone of the
// fixture repository and no user credential is involved.
import { parse, print, requester, require_ } from "./lib.mjs";

const usage = `node pr.mjs <open|close|push|open-same-sha> [options]

  open           --branch exp/<name> --file <path> --line <n> --text "<replacement line>"
                 [--base main] [--draft] [--title "..."] [--body "..."]
  close          --number <n>
  push           --number <n> [--file <path>]      one more trivial commit on the head branch
  open-same-sha  --from <existing-branch> --branch exp/<name> [--base main]

  --dry-run  print the requests instead of sending them

open prints {number, headSha, url}. push prints {number, branch, headSha}.
open-same-sha creates the new ref at the existing branch's SHA, so two pull
requests share one head SHA - the E9 shape.`;

const OPTIONS = {
  branch: { type: "string" },
  file: { type: "string" },
  line: { type: "string" },
  text: { type: "string" },
  base: { type: "string" },
  draft: { type: "boolean" },
  title: { type: "string" },
  body: { type: "string" },
  number: { type: "string" },
  from: { type: "string" },
};

const { command, values, dryRun } = parse(process.argv.slice(2), OPTIONS, {
  usage,
  commands: ["open", "close", "push", "open-same-sha"],
});

const api = requester({ dryRun });
const base = values.base ?? "main";

// Dry run returns {data: null} from every call, so the chained git data calls
// cannot continue. Printing the plan and stopping is the honest behaviour.
function stopIfDry(step) {
  if (dryRun) {
    process.stdout.write(
      `# dry run stops here: ${step} needs the previous response.\n`,
    );
    process.exit(0);
  }
}

async function refSha(ref) {
  const { data } = await api.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    ref: `heads/${ref}`,
  });
  return data?.object?.sha;
}

async function fileContent(path, ref) {
  const { data } = await api.request("GET /repos/{owner}/{repo}/contents/{path}", {
    path,
    ref,
  });
  return Buffer.from(data.content, data.encoding).toString("utf8");
}

async function commitOnto({ parentSha, path, content, message }) {
  const { data: blob } = await api.request("POST /repos/{owner}/{repo}/git/blobs", {
    content: Buffer.from(content, "utf8").toString("base64"),
    encoding: "base64",
  });
  const { data: parent } = await api.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { commit_sha: parentSha },
  );
  const { data: tree } = await api.request("POST /repos/{owner}/{repo}/git/trees", {
    base_tree: parent.tree.sha,
    tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const { data: commit } = await api.request("POST /repos/{owner}/{repo}/git/commits", {
    message,
    tree: tree.sha,
    parents: [parentSha],
  });
  return commit.sha;
}

if (command === "open") {
  require_(values, ["branch", "file", "line", "text"], usage);
  const line = Number(values.line);
  const baseSha = await refSha(base);
  stopIfDry("reading the file to edit");
  const original = await fileContent(values.file, base);
  const lines = original.split("\n");
  if (line < 1 || line > lines.length) {
    process.stderr.write(
      `--line ${line} is outside ${values.file}, which has ${lines.length} lines.\n`,
    );
    process.exit(1);
  }
  lines[line - 1] = values.text;
  const commitSha = await commitOnto({
    parentSha: baseSha,
    path: values.file,
    content: lines.join("\n"),
    message: `Experiment change on ${values.file}:${line}`,
  });
  await api.request("POST /repos/{owner}/{repo}/git/refs", {
    ref: `refs/heads/${values.branch}`,
    sha: commitSha,
  });
  const { data: pull } = await api.request("POST /repos/{owner}/{repo}/pulls", {
    title: values.title ?? `proto-111: ${values.branch}`,
    head: values.branch,
    base,
    draft: values.draft === true,
    body: values.body ?? "Throwaway pull request for the issue #111 live experiments.",
  });
  print({ number: pull.number, headSha: pull.head.sha, url: pull.html_url, draft: pull.draft });
} else if (command === "close") {
  require_(values, ["number"], usage);
  const { data } = await api.request(
    "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    { pull_number: Number(values.number), state: "closed" },
  );
  if (data) {
    print({ number: data.number, state: data.state, headSha: data.head.sha });
  }
} else if (command === "push") {
  require_(values, ["number"], usage);
  const { data: pull } = await api.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { pull_number: Number(values.number) },
  );
  stopIfDry("committing onto the head branch");
  const path = values.file ?? "proto-111-touch.txt";
  let existing = "";
  try {
    existing = await fileContent(path, pull.head.ref);
  } catch {
    existing = "";
  }
  const stamp = new Date().toISOString();
  const commitSha = await commitOnto({
    parentSha: pull.head.sha,
    path,
    content: `${existing}${stamp}\n`,
    message: `Trivial commit to move the head (${stamp})`,
  });
  await api.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    ref: `heads/${pull.head.ref}`,
    sha: commitSha,
  });
  print({ number: pull.number, branch: pull.head.ref, headSha: commitSha, previousSha: pull.head.sha });
} else {
  require_(values, ["from", "branch"], usage);
  const sha = await refSha(values.from);
  stopIfDry("creating the second ref at that SHA");
  await api.request("POST /repos/{owner}/{repo}/git/refs", {
    ref: `refs/heads/${values.branch}`,
    sha,
  });
  const { data: pull } = await api.request("POST /repos/{owner}/{repo}/pulls", {
    title: values.title ?? `proto-111: ${values.branch} (same SHA as ${values.from})`,
    head: values.branch,
    base,
    draft: values.draft === true,
    body: values.body ?? `Second pull request whose head is ${sha}, shared with ${values.from}.`,
  });
  print({ number: pull.number, headSha: pull.head.sha, url: pull.html_url, sharedWith: values.from });
}
