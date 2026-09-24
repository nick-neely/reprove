// Summarize every out/<config>-r<n>/ run into out/summary.json and a table.
// usage: node analyze.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { OUT } from "./variants.mjs";

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

const ledger = lines(path.join(OUT, "ledger.jsonl"));
const rows = [];
for (const name of readdirSync(OUT).filter((entry) => /^[A-D]-r\d+$/u.test(entry)).toSorted()) {
  const dir = path.join(OUT, name);
  if (!existsSync(path.join(dir, "result.json"))) {
    continue;
  }
  const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf-8"));
  const requests = lines(path.join(dir, "requests.jsonl"));
  const pass = requests.filter((request) => request.phase === "pass");
  const probe = requests.filter((request) => request.phase === "probe");
  const first = pass[0]?.request;
  const toolCalls = pass.flatMap((request) =>
    (request.outputItems ?? [])
      .filter((item) => /call$/u.test(item.type))
      .map((item) => `${item.type}:${item.namespace ? `${item.namespace}.` : ""}${item.name}`)
  );
  // A response with a message and no tool call ends a turn; the first one ends
  // the Pass prompt's turn, before any repair turn.
  const messages = pass.flatMap((request) =>
    (request.outputItems ?? []).filter((item) => item.type === "message").map((item) => item.text)
  );
  const finals = pass.filter(
    (request) =>
      request.outputItems?.some((item) => item.type === "message") &&
      !request.outputItems.some((item) => /call$/u.test(item.type))
  );
  const firstAnswer = finals[0]?.outputItems.findLast((item) => item.type === "message").text ?? null;
  // Messages that shared a response with a tool call: the model's preamble.
  const commentary = pass.flatMap((request) =>
    request.outputItems?.some((item) => /call$/u.test(item.type))
      ? request.outputItems.filter((item) => item.type === "message").map((item) => item.text)
      : []
  );
  const rollout = readdirSync(dir).find((file) => file.startsWith("pass-") && file.includes("rollout"));
  const rolloutEvents = rollout ? lines(path.join(dir, rollout)) : [];
  const eventLog = readdirSync(dir).find((file) => file.startsWith("pass-") && file.endsWith("event-log.ndjson"));
  const bridgeEvents = eventLog ? lines(path.join(dir, eventLog)) : [];
  const console = existsSync(path.join(OUT, `${name}.console.txt`))
    ? readFileSync(path.join(OUT, `${name}.console.txt`), "utf-8")
    : "";
  const warnings = [
    ...new Set(
      console
        .split("\n")
        .filter((line) => /warn|error/iu.test(line))
        .map((line) => line.replace(/^\[harness:codex:stderr\] /u, "").trim())
    ),
  ];
  const costOf = (phase) =>
    ledger
      .filter((entry) => entry.run === name && entry.phase === phase)
      .reduce(
        (sum, entry) => ({
          requests: sum.requests + 1,
          inputTokens: sum.inputTokens + entry.inputTokens,
          cachedInputTokens: sum.cachedInputTokens + entry.cachedInputTokens,
          outputTokens: sum.outputTokens + entry.outputTokens,
          reasoningTokens: sum.reasoningTokens + entry.reasoningTokens,
          costUsd: sum.costUsd + entry.costUsd,
        }),
        { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 }
      );
  rows.push({
    run: name,
    model: result.model,
    cli: result.cli,
    probeSatisfied: result.probe?.satisfied ?? null,
    probe: costOf("probe"),
    probeShape: probe[0] && {
      tools: probe[0].request.tools,
      input: probe[0].request.input.map((item) => item.type),
    },
    passShape: first && {
      topLevelTools: first.tools,
      additionalTools: first.input.find((item) => item.type === "additional_tools")?.tools ?? null,
      inputTypes: first.input.map((item) => item.type),
      instructionsChars: first.instructionsChars,
      parallelToolCalls: first.parallel_tool_calls,
      serviceTier: first.service_tier,
      reasoning: first.reasoning,
      textFormat: first.text?.format,
      requestHeaderNames: Object.keys(pass[0].requestHeaders),
    },
    responseServiceTier: [...new Set(pass.map((request) => request.terminal?.serviceTier))],
    httpStatuses: [...new Set(requests.map((request) => request.status))],
    terminalErrors: requests.map((request) => request.terminal?.error ?? request.errorBody).filter(Boolean),
    maxRequestMs: Math.max(...pass.map((request) => request.durationMs)),
    toolCalls,
    bridgeToolCalls: bridgeEvents
      .filter((event) => event.type === "tool-call")
      .map((event) => `${event.toolName}${event.providerExecuted ? "(provider)" : ""}`),
    rolloutItemTypes: [
      ...new Set(
        rolloutEvents.map((event) => `${event.type}:${event.payload?.type ?? ""}`)
      ),
    ],
    observed: result.pass?.observed?.map((tool) => `${tool.command} => ${tool.exitCode}`) ?? [],
    firstTurnAnswer: firstAnswer,
    firstAnswerNoncesCorrect:
      firstAnswer !== null &&
      firstAnswer.includes(result.nonces?.file) &&
      firstAnswer.includes(result.nonces?.echo),
    commentaryMessages: commentary,
    messageCount: messages.length,
    adapterOutcome: result.pass && `${result.pass.outcome}/${result.pass.failureReason}/repair=${result.pass.repairTurnUsed}`,
    passDurationMs: result.pass?.durationMs,
    pass: costOf("pass"),
    adapterUsage: result.pass?.usage,
    warnings,
  });
}
const total = ledger.reduce((sum, entry) => sum + entry.costUsd, 0);
writeFileSync(path.join(OUT, "summary.json"), `${JSON.stringify({ totalUsd: total, rows }, null, 1)}\n`);
for (const row of rows) {
  process.stdout.write(
    `${row.run} ${row.model}@${row.cli} probe=${row.probeSatisfied} $${row.probe.costUsd.toFixed(4)} | tools=${row.toolCalls.join(",")} | observed=${row.observed.length} | nonces=${row.firstAnswerNoncesCorrect} | adapter=${row.adapterOutcome} | pass $${row.pass.costUsd.toFixed(4)} ${row.passDurationMs}ms\n`
  );
}
process.stdout.write(`total $${total.toFixed(4)}\n`);
