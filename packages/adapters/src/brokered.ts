import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1JSONSchema,
} from "@ai-sdk/harness";
import { createCodex } from "@ai-sdk/harness-codex";
import { isSandboxCredentialPlaceholder } from "@ai-sdk/harness/utils";
import { z } from "zod";

import { ANSWER_SCHEMA } from "./answer.js";
import type { CodexOptions } from "./codex.js";
import type { SandboxConnection } from "./connection.js";
import type { CodexEngine } from "./engine.js";
import { execute, readBytes } from "./io.js";
import type { PassRequest, ObservedToolCall, Usage } from "./types.js";

const inputSchema = z.object({ command: z.string() });
const toolResult = z.object({ exitCode: z.number().int().nullable() });
const transformations = z
  .array(
    z
      .object({
        match: z
          .object({
            host: z.string(),
            path: z.object({ startsWith: z.string() }).optional(),
            headers: z
              .array(
                z.object({
                  key: z.object({ exact: z.string() }),
                  value: z.object({ exact: z.string() }),
                })
              )
              .length(1),
          })
          .strict(),
        transform: z
          .object({ headers: z.object({ Authorization: z.string() }).strict() })
          .strict(),
      })
      .strict()
  )
  .length(1);

export const createBrokeredEngine = async (
  request: PassRequest,
  options: CodexOptions,
  access: SandboxConnection,
  environment: Readonly<Record<string, string>>,
  instructions: string,
  bindCredentials: Awaited<
    ReturnType<SandboxConnection["openProxy"]>
  >["credentials"]
): Promise<CodexEngine> => {
  const { authentication } = options;
  if (authentication.kind !== "api-key") {
    throw new Error("brokered authentication is missing");
  }
  const origin =
    authentication.provider === "gateway"
      ? "https://ai-gateway.vercel.sh"
      : "https://api.openai.com";
  const endpoint = await access.exposePort(3000);
  const io: HarnessV1NetworkSandboxSession = {
    id: request.sandbox.id,
    description: "Reprove Sandbox",
    defaultWorkingDirectory: "/reprove/runtime",
    ports: [3000],
    getPortEndpoint: ({ protocol }) =>
      Promise.resolve({
        url: endpoint.url.replace("http:", protocol === "ws" ? "ws:" : "http:"),
      }),
    getPortUrl: () => Promise.resolve(endpoint.url),
    // The Worker owns destruction; the SDK may release only its bridge endpoint.
    stop: endpoint.close,
    destroy: endpoint.close,
    restricted: () => ({
      description: io.description,
      readFile: io.readFile,
      readBinaryFile: io.readBinaryFile,
      readTextFile: io.readTextFile,
      writeFile: io.writeFile,
      writeBinaryFile: io.writeBinaryFile,
      writeTextFile: io.writeTextFile,
      run: io.run,
      spawn: io.spawn,
    }),
    readBinaryFile: ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      return access.read(path);
    },
    readFile: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      const bytes = await access.read(path);
      return bytes === null ? null : new Response(bytes).body;
    },
    readTextFile: async ({
      path,
      abortSignal,
      startLine,
      endLine,
      encoding,
    }) => {
      abortSignal?.throwIfAborted();
      const bytes = await access.read(path);
      if (bytes === null) {
        return null;
      }
      const text = new TextDecoder(encoding).decode(bytes);
      return startLine !== undefined || endLine !== undefined
        ? text
            .split("\n")
            .slice((startLine ?? 1) - 1, endLine)
            .join("\n")
        : text;
    },
    writeBinaryFile: async ({ path, content, abortSignal }) => {
      abortSignal?.throwIfAborted();
      await access.write(path, content);
    },
    writeFile: async ({ path, content, abortSignal }) => {
      abortSignal?.throwIfAborted();
      await access.write(path, await readBytes(content));
    },
    writeTextFile: async ({ path, content, abortSignal }) => {
      abortSignal?.throwIfAborted();
      await access.write(path, new TextEncoder().encode(content));
    },
    run: ({ command, workingDirectory, env, abortSignal }) =>
      execute(
        access,
        ["/bin/sh", "-c", command],
        { ...environment, ...env },
        abortSignal ?? request.signal,
        workingDirectory ?? "/reprove/runtime"
      ),
    spawn: async ({ command, workingDirectory, env, abortSignal }) => {
      const process = access.start(["/bin/sh", "-c", command], {
        directory: workingDirectory ?? "/reprove/runtime",
        environment: { ...environment, ...env },
        signal: abortSignal ?? request.signal,
      });
      await process.stdin.getWriter().close();
      return {
        stdout: process.stdout,
        stderr: process.stderr,
        wait: process.wait,
        kill: process.kill,
      };
    },
    addRequestTransformations: (entries) => {
      const [entry] = transformations.parse(entries);
      const header = entry?.match.headers[0];
      if (
        !entry ||
        !header ||
        entry.match.host !== new URL(origin).hostname ||
        entry.match.path?.startsWith !== "/v1" ||
        header.key.exact.toLowerCase() !== "authorization" ||
        !header.value.exact.startsWith("Bearer ") ||
        entry.transform.headers.Authorization !== `Bearer ${authentication.key}`
      ) {
        throw new Error("unsupported credential transformation");
      }
      const placeholder = header.value.exact.slice(7);
      if (!isSandboxCredentialPlaceholder(placeholder)) {
        throw new Error("a real credential would enter the Sandbox");
      }
      bindCredentials([{ origin, placeholder, secret: authentication.key }]);
      return Promise.resolve();
    },
  };
  const auth: Record<string, string> =
    authentication.provider === "gateway"
      ? { AI_GATEWAY_API_KEY: authentication.key }
      : { OPENAI_API_KEY: authentication.key };
  const harness = createCodex({
    model: request.model,
    auth,
    webSearch: false,
    codexConfig: {
      project_doc_max_bytes: 0,
      "skills.include_instructions": false,
    },
    credentialForwarding: ({ credential }) => {
      if (!isSandboxCredentialPlaceholder(credential)) {
        throw new Error("a real credential would enter the Sandbox");
      }
      return credential;
    },
  });
  let session;
  try {
    session = await harness.doStart({
      sessionId: request.passId,
      sandboxSession: io,
      sessionWorkDir: request.sandbox.workspace.path,
      permissionMode: "allow-all",
      abortSignal: request.signal,
    });
  } catch (error) {
    await endpoint.close();
    throw error;
  }
  return {
    turn: async (prompt) => {
      let text = "";
      let failed = false;
      let finished = false;
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      const commands = new Map<string, string>();
      const observed: ObservedToolCall[] = [];
      const control = await session.doPromptTurn({
        prompt,
        instructions,
        skills: [],
        tools: [],
        abortSignal: request.signal,
        responseFormat: {
          type: "json",
          // SAFETY: Zod emits a JSON Schema object; the SDK type only narrows JSON values.
          schema: ANSWER_SCHEMA as HarnessV1JSONSchema,
        },
        emit: (event) => {
          if (event.type === "text-delta") {
            if (
              Buffer.byteLength(text) + Buffer.byteLength(event.delta) >
              1024 * 1024
            ) {
              failed = true;
            } else {
              text += event.delta;
            }
          }
          if (
            event.type === "tool-call" &&
            event.toolName === "bash" &&
            event.providerExecuted
          ) {
            const parsed = inputSchema.safeParse(
              z
                .string()
                .transform((value, context) => {
                  try {
                    return JSON.parse(value);
                  } catch {
                    context.addIssue({
                      code: "custom",
                      message: "invalid tool JSON",
                    });
                    return z.NEVER;
                  }
                })
                .safeParse(event.input).data
            );
            if (parsed.success) {
              commands.set(event.toolCallId, parsed.data.command);
            }
          }
          if (event.type === "tool-result" && event.toolName === "bash") {
            const command = commands.get(event.toolCallId);
            const result = toolResult.safeParse(event.result);
            if (command && result.success) {
              observed.push({ command, exitCode: result.data.exitCode });
            }
          }
          if (event.type === "error") {
            failed = true;
          }
          if (event.type === "finish") {
            finished = true;
            usage = {
              inputTokens: event.totalUsage.inputTokens.total ?? 0,
              outputTokens: event.totalUsage.outputTokens.total ?? 0,
              cachedInputTokens: event.totalUsage.inputTokens.cacheRead ?? 0,
            };
            if (event.finishReason.unified === "error") {
              failed = true;
            }
          }
        },
      });
      await control.done;
      return { text, observed, usage, failed: failed || !finished };
    },
    close: async () => {
      try {
        await session.doStop();
      } finally {
        await endpoint.close();
      }
    },
  };
};
