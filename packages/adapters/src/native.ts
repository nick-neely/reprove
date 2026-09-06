import { createInterface } from "node:readline";
import { Readable } from "node:stream";

import { z } from "zod";

import { ANSWER_SCHEMA } from "./answer.js";
import type { SandboxConnection } from "./connection.js";
import type { CodexSession, TurnOutput } from "./session.js";
import type { PassRequest, ObservedToolCall, PassProgress } from "./types.js";

const eventSchema = z.object({
  type: z.string(),
  thread_id: z.uuid().optional(),
  item: z
    .object({
      type: z.string(),
      text: z.string().optional(),
      command: z.string().optional(),
      exit_code: z.number().int().nullable().optional(),
    })
    .optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      cached_input_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const createNativeSession = async (
  request: PassRequest,
  access: SandboxConnection,
  environment: Readonly<Record<string, string>>,
  instructions: string,
  authJson: string
): Promise<CodexSession> => {
  const progress = (event: PassProgress) => {
    request.onProgress?.(event);
  };
  const home = environment.CODEX_HOME;
  if (!home) {
    throw new Error("Codex has no private authentication directory");
  }
  await access.write(`${home}/auth.json`, new TextEncoder().encode(authJson));
  const schemaPath = `${home}/answer-schema.json`;
  await access.write(
    schemaPath,
    new TextEncoder().encode(JSON.stringify(ANSWER_SCHEMA))
  );
  let threadId: string | undefined;
  const turn = async (prompt: string): Promise<TurnOutput> => {
    const base = [
      "/opt/reprove/codex/node_modules/.pnpm/node_modules/.bin/codex",
      "exec",
      "--sandbox",
      "danger-full-access",
    ];
    if (threadId) {
      base.push("resume", threadId);
    }
    base.push(
      "--model",
      request.model,
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema",
      schemaPath,
      "-c",
      "project_doc_max_bytes=0",
      "-c",
      "skills.include_instructions=false",
      "-c",
      `developer_instructions=${JSON.stringify(instructions)}`,
      "-"
    );
    const running = access.start(base, {
      directory: request.sandbox.workspace.path,
      environment,
      signal: request.signal,
    });
    const write = async () => {
      const writer = running.stdin.getWriter();
      await writer.write(new TextEncoder().encode(prompt));
      await writer.close();
    };
    const collect = async (): Promise<TurnOutput> => {
      const observed: ObservedToolCall[] = [];
      let text = "";
      let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      let failed = false;
      let completed = false;
      let bytes = 0;
      const input = Readable.fromWeb(running.stdout);
      input.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          input.destroy(new Error("Codex stream exceeds the Pass limit"));
        }
      });
      for await (const line of createInterface({
        input,
        crlfDelay: Infinity,
      })) {
        const event = eventSchema.parse(JSON.parse(line));
        if (event.type === "thread.started") {
          threadId = event.thread_id;
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        ) {
          text = event.item.text ?? "";
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "command_execution" &&
          event.item.command
        ) {
          const tool = {
            command: event.item.command,
            exitCode: event.item.exit_code ?? null,
          };
          observed.push(tool);
          progress({
            type: "tool-completed",
            tool: { kind: "command", exitCode: tool.exitCode },
          });
        }
        completed ||= event.type === "turn.completed";
        if (event.type === "turn.completed" && event.usage) {
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cachedInputTokens: event.usage.cached_input_tokens ?? 0,
          };
          progress({ type: "usage", usage: { ...usage } });
        }
        if (event.type === "turn.failed") {
          failed = true;
        }
      }
      const status = await running.wait();
      return {
        text,
        observed,
        usage,
        failed: failed || !completed || status.exitCode !== 0,
      };
    };
    // Stderr is deliberately drained, never exposed as Finding prose or a
    // Failure detail: SDK diagnostics can contain request data or credentials.
    const drain = async () => {
      for await (const chunk of running.stderr) {
        void chunk;
      }
    };
    try {
      const [output] = await Promise.all([collect(), write(), drain()]);
      return output;
    } finally {
      await running.kill();
    }
  };
  return { turn, close: () => Promise.resolve() };
};
