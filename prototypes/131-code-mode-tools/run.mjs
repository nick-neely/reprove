// One live run of one configuration through the real Codex Adapter:
// a fresh instruction probe (ADR 0009 canaries) in its own Sandbox, then a
// Pass in a second Sandbox that must `cat` a planted nonce and `echo` another.
// The only substitution is a recording wrapper around the platform fetch at the
// Adapter's documented Provider HTTP boundary; the real key is added by the
// host proxy before that point and is never written anywhere.
//
// usage: node run.mjs <A|B|C> <run-number>
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  createCliRuntime,
  createDockerProvider,
} from "@reprove/sandbox-container";
import { CODEX_SANDBOX_PROFILE, sandboxRequestFor } from "@reprove/worker-core";

import { OUT, VARIANTS } from "./variants.mjs";

const execute = promisify(execFile);

export const CONFIGS = {
  A: { model: "gpt-6-sol", cli: "0.156.1" },
  B: { model: "gpt-5.6-sol", cli: "0.153.4" },
  C: { model: "gpt-6-sol", cli: "0.153.4" },
  // Ablation, not a product path: A plus the Responses Lite header the CLI sends
  // but the host proxy's FORWARDED_HEADERS allowlist drops.
  D: { model: "gpt-6-sol", cli: "0.156.1", liteHeader: true },
};
// USD per token. gpt-5.6-sol is absent from the repo; the brief's assumed price.
const PRICES = {
  "gpt-6-sol": { input: 2e-6, cached: 0.2e-6, output: 10e-6 },
  "gpt-5.6-sol": { input: 4e-6, cached: 0.4e-6, output: 20e-6 },
};
const CAP = 3;
const STOP_AT = 2.6; // headroom: one multi-request Pass must fit under the cap

const [configName, runNumber] = process.argv.slice(2);
const config = CONFIGS[configName];
if (!config || !/^\d+$/u.test(runNumber ?? "")) {
  throw new Error("usage: node run.mjs <A|B|C> <run-number>");
}
const variant = VARIANTS[config.cli];
const { createCodexAdapter, probeCodexInstructions, CODEX_PROBE_FILES, CODEX_CLI_VERSION } =
  await import(variant.adapters);
if (CODEX_CLI_VERSION !== config.cli) {
  throw new Error("Adapter build does not match the configuration");
}

const KEY = /^OPENAI_API_KEY=(.+)$/mu
  .exec(readFileSync(`${process.env.HOME}/.config/reprove-proto-114/env`, "utf-8"))?.[1]
  ?.trim()
  .replace(/^["']|["']$/gu, "");
if (!KEY) {
  throw new Error("no OPENAI_API_KEY in the #114 rig env");
}

const runDir = path.join(OUT, `${configName}-r${runNumber}`);
mkdirSync(path.join(runDir, "bodies"), { recursive: true });
const ledgerPath = path.join(OUT, "ledger.jsonl");

/** Every artifact goes through here; a key-bearing write is a hard failure. */
const safe = (text) => {
  if (text.includes(KEY) || /sk-[A-Za-z0-9_-]{20,}/u.test(text)) {
    throw new Error("refusing to write a credential-bearing artifact");
  }
  return text;
};
const write = (file, text) => writeFileSync(path.join(runDir, file), safe(text));
const append = (file, value) =>
  appendFileSync(file, safe(`${JSON.stringify(value)}\n`));

const spent = () => {
  let total = 0;
  try {
    for (const line of readFileSync(ledgerPath, "utf-8").split("\n")) {
      if (line) {
        total += JSON.parse(line).costUsd;
      }
    }
  } catch {
    /* no ledger yet */
  }
  return total;
};

const summarizeTools = (tools) =>
  Array.isArray(tools)
    ? tools.map((tool) =>
        tool.type === "namespace" || tool.tools
          ? `${tool.type}:${tool.name}[${(tool.tools ?? []).map((inner) => inner.name).join(",")}]`
          : `${tool.type}:${tool.name ?? ""}`
      )
    : tools;

const summarizeBody = (body) => ({
  keys: Object.keys(body),
  model: body.model,
  stream: body.stream,
  store: body.store,
  service_tier: body.service_tier,
  parallel_tool_calls: body.parallel_tool_calls,
  tool_choice: body.tool_choice,
  reasoning: body.reasoning,
  text: body.text && {
    verbosity: body.text.verbosity,
    format: body.text.format?.type,
    formatName: body.text.format?.name,
  },
  instructionsChars: typeof body.instructions === "string" ? body.instructions.length : body.instructions,
  tools: summarizeTools(body.tools),
  input: Array.isArray(body.input)
    ? body.input.map((item) => {
        const entry = { type: item.type, role: item.role, name: item.name, namespace: item.namespace };
        if (item.type === "additional_tools" || item.tools) {
          entry.tools = summarizeTools(item.tools);
        }
        return entry;
      })
    : typeof body.input,
});

const parseSse = (text) => {
  const events = [];
  for (const block of text.split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      events.push({ type: "unparsed", raw: data.slice(0, 200) });
    }
  }
  return events;
};

const clip = (value, limit = 600) =>
  typeof value === "string" && value.length > limit ? `${value.slice(0, limit)}...[${value.length}]` : value;

let requestIndex = 0;
/** Records the request the proxy forwards, and the Provider's reply. */
const recordingFetch = (phase) => async (request) => {
  const total = spent();
  if (total >= STOP_AT) {
    throw new Error(`spend ${total.toFixed(4)} reached the stop line`);
  }
  requestIndex += 1;
  const index = requestIndex;
  const bodyText = await request.clone().text();
  const body = JSON.parse(bodyText);
  write(`bodies/${phase}-${index}.request.json`, JSON.stringify(body, null, 1));
  const headers = {};
  for (const [name, value] of request.headers) {
    headers[name] = name === "authorization" ? `Bearer <${value.length - 7} chars, redacted>` : clip(value, 300);
  }
  let upstream = request;
  if (config.liteHeader) {
    const injected = new Headers(request.headers);
    injected.set("x-openai-internal-codex-responses-lite", "true");
    upstream = new Request(request, { headers: injected });
    headers["x-openai-internal-codex-responses-lite"] = "true (injected by ablation)";
  }
  const started = Date.now();
  let response;
  let failure;
  try {
    response = await fetch(upstream);
  } catch (error) {
    failure = String(error?.cause ?? error);
  }
  const text = response ? await response.text() : "";
  const durationMs = Date.now() - started;
  const record = {
    phase,
    index,
    at: new Date(started).toISOString(),
    durationMs,
    url: request.url,
    method: request.method,
    requestHeaders: headers,
    requestBytes: bodyText.length,
    request: summarizeBody(body),
    status: response?.status ?? null,
    fetchError: failure ?? null,
    contentType: response?.headers.get("content-type") ?? null,
    responseHeaders: response
      ? Object.fromEntries(
          [...response.headers].filter(([name]) =>
            /^(x-request-id|openai-model|openai-processing-ms|x-codex|x-openai|x-ratelimit-remaining-tokens)/u.test(name)
          )
        )
      : null,
  };
  if (response && record.contentType?.includes("event-stream")) {
    write(`bodies/${phase}-${index}.response.sse`, text);
    const events = parseSse(text);
    const counts = {};
    for (const event of events) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    }
    record.eventCounts = counts;
    record.outputItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map(({ item }) => ({
        type: item.type,
        name: item.name,
        namespace: item.namespace,
        status: item.status,
        phase: item.phase,
        input: clip(item.input),
        arguments: clip(item.arguments),
        text: clip(item.content?.map((part) => part.text ?? "").join("")),
      }));
    const terminal = events.findLast((event) =>
      ["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)
    );
    record.terminal = terminal && {
      type: terminal.type,
      status: terminal.response?.status,
      model: terminal.response?.model,
      serviceTier: terminal.response?.service_tier,
      error: terminal.response?.error ?? terminal.error ?? (terminal.type === "error" ? terminal : undefined),
      incomplete: terminal.response?.incomplete_details,
    };
    const usage = terminal?.response?.usage;
    if (usage) {
      const price = PRICES[config.model];
      const cached = usage.input_tokens_details?.cached_tokens ?? 0;
      const costUsd =
        (usage.input_tokens - cached) * price.input + cached * price.cached + usage.output_tokens * price.output;
      record.usage = { ...usage, costUsd };
      append(ledgerPath, {
        at: record.at,
        run: `${configName}-r${runNumber}`,
        phase,
        index,
        model: config.model,
        inputTokens: usage.input_tokens,
        cachedInputTokens: cached,
        outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        costUsd,
      });
    }
  } else if (response) {
    record.errorBody = clip(text, 2000);
  }
  append(path.join(runDir, "requests.jsonl"), record);
  if (spent() > CAP) {
    throw new Error("spend cap exceeded");
  }
  if (failure) {
    throw new Error(failure);
  }
  return new Response(text, { status: response.status, headers: response.headers });
};

const docker = async (sandbox, script, input, user = "0:0") => {
  const { stdout } = await execute(
    "docker",
    ["exec", "--user", user, sandbox.id, "node", "-e", script, ...(input === undefined ? [] : [input])],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout;
};

const plant = (sandbox, files) =>
  docker(
    sandbox,
    "const fs=require('node:fs'),path=require('node:path');for(const [p,v] of Object.entries(JSON.parse(process.argv[1]))){const t=path.join('/reprove/workspace',p);fs.mkdirSync(path.dirname(t),{recursive:true});fs.writeFileSync(t,v,{mode:0o444})}",
    JSON.stringify(files)
  );

// The runtime and home belong to the Reviewer; root has no DAC override there.
const READER = "1000:1000";

/** Copy the CLI rollout and bridge state out of the Sandbox before teardown. */
const collect = async (sandbox, prefix) => {
  const listing = await docker(
    sandbox,
    `const fs=require('node:fs'),path=require('node:path');const out={};
const walk=(d,depth)=>{let e;try{e=fs.readdirSync(d,{withFileTypes:true})}catch{return}
for(const x of e){const p=path.join(d,x.name);if(x.isSymbolicLink()){out[p]='-> '+fs.readlinkSync(p);continue}
if(x.isDirectory()){if(depth<8&&x.name!=='node_modules')walk(p,depth+1);continue}
const s=fs.statSync(p);out[p]=s.size;}};
walk('/reprove/home',0);walk('/reprove/runtime',0);walk('/tmp',0);process.stdout.write(JSON.stringify(out));`,
    undefined,
    READER
  );
  const files = JSON.parse(listing);
  write(`${prefix}-files.json`, JSON.stringify(files, null, 1));
  for (const [file, size] of Object.entries(files)) {
    if (
      typeof size === "number" &&
      size < 4 * 1024 * 1024 &&
      (/\/sessions\/.*\.jsonl$/u.test(file) || /\.agent-runs\//u.test(file) || /\.(log|jsonl)$/u.test(file))
    ) {
      const content = await docker(
        sandbox,
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))",
        file,
        READER
      );
      write(`${prefix}-${file.replaceAll("/", "_")}`, content);
    }
  }
};

const provider = createDockerProvider({ runtime: createCliRuntime({ name: "docker" }) });
const profile = { ...CODEX_SANDBOX_PROFILE, image: variant.image };
const authentication = { kind: "api-key", provider: "openai", key: KEY };
const reasoningEffort = "medium";
const result = {
  config: configName,
  run: Number(runNumber),
  model: config.model,
  cli: config.cli,
  image: variant.image,
  reasoningEffort,
  startedAt: new Date().toISOString(),
};

// 1. Instruction probe, as docs/codex-adapter.md prescribes: its own Sandbox.
let proof;
{
  const sandbox = await provider.launch(sandboxRequestFor("codex", profile));
  try {
    await plant(sandbox, Object.fromEntries(CODEX_PROBE_FILES.map((file) => [file.path, file.content])));
    await sandbox.access.protect(
      "/reprove/input/narrative.json",
      new TextEncoder().encode('{"authority":"none","title":"probe"}')
    );
    const started = Date.now();
    proof = await probeCodexInstructions({
      model: config.model,
      reasoningEffort,
      authentication,
      sandbox,
      signal: AbortSignal.timeout(240_000),
      fetch: recordingFetch("probe"),
    });
    result.probe = { satisfied: proof.satisfied, durationMs: Date.now() - started };
    await collect(sandbox, "probe");
  } finally {
    result.probeTeardown = await sandbox.teardown();
  }
}

// 2. The Pass: real Adapter, real proxy, real Provider.
if (proof.satisfied) {
  const fileNonce = `n1-${randomBytes(8).toString("hex")}`;
  const echoNonce = `n2-${randomBytes(8).toString("hex")}`;
  result.nonces = { file: fileNonce, echo: echoNonce };
  const sandbox = await provider.launch(sandboxRequestFor("codex", profile));
  const progress = [];
  try {
    await plant(sandbox, { "nonce.txt": `${fileNonce}\n` });
    await sandbox.access.protect(
      "/reprove/input/narrative.json",
      new TextEncoder().encode('{"authority":"none","title":"tool check"}')
    );
    const adapter = createCodexAdapter({
      model: config.model,
      reasoningEffort,
      authentication,
      timeoutMs: 240_000,
      instructionProbe: () => Promise.resolve(proof),
      fetch: recordingFetch("pass"),
    });
    const started = Date.now();
    const output = await adapter.pass({
      runId: `issue-131-${configName}-${runNumber}`,
      passId: crypto.randomUUID(),
      model: config.model,
      reasoningEffort,
      autonomy: "verify",
      sandbox,
      signal: AbortSignal.timeout(270_000),
      onProgress: (event) => progress.push({ at: Date.now() - started, ...event }),
      check: () => null,
      instructions: {
        policy: [
          "This is a tool connectivity check, not a code review.",
          "Use your shell tool to run exactly these two commands, separately:",
          "1. cat /reprove/workspace/nonce.txt",
          `2. echo ${echoNonce}`,
          'Then return the required JSON with "findings": [] and "disprovedHypothesisCount": 0, and set "summary" to exactly "file=<stdout of command 1, trimmed> echo=<stdout of command 2, trimmed>".',
          "Never guess a value. If you could not run a command, write NO_TOOL for its value.",
        ].join("\n"),
        conventions: [],
        narrativePath: "/reprove/input/narrative.json",
      },
    });
    result.pass = {
      durationMs: Date.now() - started,
      outcome: output.outcome,
      failureReason: output.failureReason,
      repairTurnUsed: output.repairTurnUsed,
      summary: output.summary,
      observed: output.observed,
      usage: output.usage,
      progress,
    };
    result.verdict = {
      summaryHasFileNonce: output.summary.includes(fileNonce),
      summaryHasEchoNonce: output.summary.includes(echoNonce),
      observedCat: output.observed.some((tool) => tool.command.includes("nonce.txt") && tool.exitCode === 0),
      observedEcho: output.observed.some((tool) => tool.command.includes(echoNonce) && tool.exitCode === 0),
    };
    await collect(sandbox, "pass");
  } finally {
    result.passTeardown = await sandbox.teardown();
  }
}

result.spentAfterUsd = spent();
write("result.json", JSON.stringify(result, null, 1));
process.stdout.write(`${JSON.stringify({ probe: result.probe, verdict: result.verdict, outcome: result.pass?.outcome, failureReason: result.pass?.failureReason, observed: result.pass?.observed?.length, spent: result.spentAfterUsd })}\n`);
