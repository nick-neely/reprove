#!/usr/bin/env node
// Throwaway. Forwards a smee channel into this process and records every
// delivery twice: one flat JSON line in deliveries.jsonl to read with jq, and
// the untouched payload in payloads/<delivery>.json so nothing is lost.
//
//   node listen.mjs [--port 3111]
//
// Runs until killed.
import { createServer } from "node:http";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, readConfig } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LINES = join(HERE, "deliveries.jsonl");
const PAYLOADS = join(HERE, "payloads");

const usage = `node listen.mjs [--port <port>]

Connects to config.smeeUrl and appends one JSON line per delivery to
deliveries.jsonl, with the full payload in payloads/<delivery>.json.`;

const { values } = parse(
  process.argv.slice(2),
  { port: { type: "string" } },
  { usage, allowEmpty: true },
);

const port = Number(values.port ?? 3111);

// Only the fields the experiment matrix records. Everything else stays in the
// sibling payload file.
function project(headers, payload) {
  const pick = (source, keys) => {
    if (!source) {
      return null;
    }
    const out = {};
    for (const key of keys) {
      out[key] = source[key] ?? null;
    }
    return out;
  };
  const checkRun = payload.check_run;
  const checkSuite = payload.check_suite ?? checkRun?.check_suite;
  const pullRequest = payload.pull_request;
  return {
    receivedAt: new Date().toISOString(),
    event: headers["x-github-event"] ?? null,
    delivery: headers["x-github-delivery"] ?? null,
    action: payload.action ?? null,
    check_run: checkRun
      ? {
          ...pick(checkRun, [
            "id",
            "name",
            "external_id",
            "status",
            "conclusion",
            "head_sha",
          ]),
          check_suite: pick(checkRun.check_suite, ["id"]),
          app: pick(checkRun.app, ["id"]),
          // Not a handle per ADR 0022 §3, recorded because E9 is about exactly
          // what it does contain.
          pull_requests: (checkRun.pull_requests ?? []).map((pr) => ({
            number: pr.number,
            head_sha: pr.head?.sha ?? null,
            base_ref: pr.base?.ref ?? null,
          })),
        }
      : null,
    check_suite: payload.check_suite
      ? {
          ...pick(payload.check_suite, [
            "id",
            "status",
            "conclusion",
            "head_sha",
            "rerequestable",
            "latest_check_runs_count",
          ]),
          app: pick(payload.check_suite.app, ["id"]),
          pull_requests: (payload.check_suite.pull_requests ?? []).map((pr) => ({
            number: pr.number,
            head_sha: pr.head?.sha ?? null,
          })),
        }
      : checkSuite
        ? { id: checkSuite.id ?? null }
        : null,
    pull_request: pullRequest
      ? {
          number: pullRequest.number ?? null,
          state: pullRequest.state ?? null,
          draft: pullRequest.draft ?? null,
          head: { sha: pullRequest.head?.sha ?? null },
        }
      : null,
    requester: checkRun?.requested_action ?? payload.sender?.login ?? null,
    sender: pick(payload.sender, ["login", "type"]),
  };
}

async function record(headers, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = { unparseable: body.slice(0, 2000) };
  }
  const line = project(headers, payload);
  const delivery = line.delivery ?? `no-delivery-id-${Date.now()}`;
  await writeFile(
    join(PAYLOADS, `${delivery}.json`),
    `${JSON.stringify({ headers, payload }, null, 2)}\n`,
  );
  await appendFile(LINES, `${JSON.stringify(line)}\n`);
  process.stdout.write(
    `${line.receivedAt} ${line.event}${line.action ? `.${line.action}` : ""} ` +
      `delivery=${delivery}` +
      `${line.check_run ? ` check_run=${line.check_run.id} name=${JSON.stringify(line.check_run.name)} status=${line.check_run.status} conclusion=${line.check_run.conclusion} suite=${line.check_run.check_suite?.id}` : ""}` +
      `${payload.check_suite ? ` suite=${line.check_suite.id} status=${line.check_suite.status} conclusion=${line.check_suite.conclusion} rerequestable=${line.check_suite.rerequestable}` : ""}` +
      `${line.sender ? ` sender=${line.sender.login}` : ""}\n`,
  );
}

const config = await readConfig();
if (!config.smeeUrl) {
  process.stderr.write("config.json is missing \"smeeUrl\".\n");
  process.exit(1);
}
await mkdir(PAYLOADS, { recursive: true });

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    record(request.headers, Buffer.concat(chunks).toString("utf8")).catch((error) => {
      process.stderr.write(`record failed: ${error.stack}\n`);
    });
    response.writeHead(200).end("ok");
  });
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const { default: SmeeClient } = await import("smee-client");
const client = new SmeeClient({
  source: config.smeeUrl,
  target: `http://127.0.0.1:${port}/`,
  logger: console,
});
client.start();

process.stdout.write(
  `Listening. ${config.smeeUrl} -> http://127.0.0.1:${port}/ -> ${LINES}\nCtrl-C to stop.\n`,
);
