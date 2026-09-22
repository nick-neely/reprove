#!/usr/bin/env node
// Throwaway. Publishes and inspects Check Runs as the App, which is the whole
// write surface ADR 0025 describes and the thing the re-run experiments act on.
import { readFile } from "node:fs/promises";
import { parse, print, requester, require_ } from "./lib.mjs";

const usage = `node check.mjs <create|update|list|suites> [options]

  create --sha <sha> --name <name> --external-id <id>
         --status queued|in_progress|completed
         [--conclusion success|failure|neutral|cancelled|timed_out|action_required|skipped|stale]
         [--title "..."] [--summary "..."] [--text "..."]
         [--title-file p] [--summary-file p] [--text-file p]
  update --id <checkRunId>  ...same options, --sha and --name optional...
  list   --sha <sha>
  suites --sha <sha>

  --dry-run  print the request instead of sending it

create and update print {id, check_suite:{id}, html_url, status, conclusion,
external_id}. Names are not unique, which E8 is about; --external-id is the
handle ADR 0022 §3 requires.`;

const OPTIONS = {
  sha: { type: "string" },
  name: { type: "string" },
  "external-id": { type: "string" },
  status: { type: "string" },
  conclusion: { type: "string" },
  title: { type: "string" },
  summary: { type: "string" },
  text: { type: "string" },
  "title-file": { type: "string" },
  "summary-file": { type: "string" },
  "text-file": { type: "string" },
  id: { type: "string" },
  "started-at": { type: "string" },
  "completed-at": { type: "string" },
};

const { command, values, dryRun } = parse(process.argv.slice(2), OPTIONS, {
  usage,
  commands: ["create", "update", "list", "suites"],
});

const api = requester({ dryRun });

async function inline(direct, file) {
  if (direct !== undefined) {
    return direct;
  }
  return file === undefined ? undefined : await readFile(file, "utf8");
}

async function body() {
  const title = await inline(values.title, values["title-file"]);
  const summary = await inline(values.summary, values["summary-file"]);
  const text = await inline(values.text, values["text-file"]);
  const payload = {};
  if (values.name !== undefined) {
    payload.name = values.name;
  }
  if (values.sha !== undefined) {
    payload.head_sha = values.sha;
  }
  if (values["external-id"] !== undefined) {
    payload.external_id = values["external-id"];
  }
  if (values.status !== undefined) {
    payload.status = values.status;
  }
  if (values.conclusion !== undefined) {
    payload.conclusion = values.conclusion;
  }
  if (values["started-at"] !== undefined) {
    payload.started_at = values["started-at"];
  }
  if (values["completed-at"] !== undefined) {
    payload.completed_at = values["completed-at"];
  }
  // GitHub requires a title and a summary whenever output is present at all.
  if (title !== undefined || summary !== undefined || text !== undefined) {
    payload.output = {
      title: title ?? "Reprove",
      summary: summary ?? "",
      ...(text === undefined ? {} : { text }),
    };
  }
  return payload;
}

function resulting(data) {
  return {
    id: data.id,
    name: data.name,
    external_id: data.external_id,
    status: data.status,
    conclusion: data.conclusion,
    head_sha: data.head_sha,
    check_suite: { id: data.check_suite?.id ?? null },
    html_url: data.html_url,
  };
}

if (command === "create") {
  require_(values, ["sha", "name", "status"], usage);
  if (values.status === "completed") {
    require_(values, ["conclusion"], usage);
  }
  const { data } = await api.request("POST /repos/{owner}/{repo}/check-runs", await body());
  if (data) {
    print(resulting(data));
  }
} else if (command === "update") {
  require_(values, ["id"], usage);
  const { data } = await api.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    { check_run_id: Number(values.id), ...await body() },
  );
  if (data) {
    print(resulting(data));
  }
} else if (command === "list") {
  require_(values, ["sha"], usage);
  const { data } = await api.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    { ref: values.sha, per_page: 100, filter: "all" },
  );
  if (data) {
    print({
      total_count: data.total_count,
      check_runs: data.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        external_id: run.external_id,
        status: run.status,
        conclusion: run.conclusion,
        check_suite_id: run.check_suite?.id ?? null,
        app_id: run.app?.id ?? null,
        app_slug: run.app?.slug ?? null,
        started_at: run.started_at,
        completed_at: run.completed_at,
        pull_requests: (run.pull_requests ?? []).map((pr) => pr.number),
        html_url: run.html_url,
      })),
    });
  }
} else {
  require_(values, ["sha"], usage);
  const { data } = await api.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-suites",
    { ref: values.sha, per_page: 100 },
  );
  if (data) {
    print({
      total_count: data.total_count,
      check_suites: data.check_suites.map((suite) => ({
        id: suite.id,
        app_id: suite.app?.id ?? null,
        app_slug: suite.app?.slug ?? null,
        status: suite.status,
        conclusion: suite.conclusion,
        latest_check_runs_count: suite.latest_check_runs_count,
        rerequestable: suite.rerequestable ?? null,
        head_sha: suite.head_sha,
        pull_requests: (suite.pull_requests ?? []).map((pr) => pr.number),
      })),
    });
  }
}
