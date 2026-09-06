import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createCodexAdapter,
  CODEX_PROBE_FILES,
  probeCodexInstructions,
} from "@reprove/adapters";
import { resultSchema } from "@reprove/protocol/v1";
import {
  createCliRuntime,
  createDockerProvider,
} from "@reprove/sandbox-container";
import {
  CODEX_SANDBOX_PROFILE,
  sandboxRequestFor,
  createWorkerCore,
  materializeNarrative,
} from "@reprove/worker-core";
import { beforeAll, describe, expect, it } from "vitest";

import { buildCodexImage } from "./build-codex-image.mjs";

const execute = promisify(execFile);
const CANARY = "REPROVE_UNTRUSTED_INSTRUCTION_CANARY_52";
const ANSWER = {
  summary: "Fixture reviewed.",
  disprovedHypothesisCount: 1,
  findings: [],
};

// Only the external Provider HTTP boundary is substituted. Container runtime,
// CLI, bridge, credential transforms, process streams and parsing are real.
const responseEvents = (output) => {
  const response = {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    model: "gpt-5.5",
    output: [output],
    usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...output, status: "in_progress" },
    },
  ];
  if (output.type === "message") {
    const [part] = output.content;
    const { text } = part;
    events.push(
      {
        type: "response.content_part.added",
        item_id: output.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: output.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: "response.output_text.done",
        item_id: output.id,
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: "response.content_part.done",
        item_id: output.id,
        output_index: 0,
        content_index: 0,
        part: output.content[0],
      }
    );
  }
  events.push(
    { type: "response.output_item.done", output_index: 0, item: output },
    { type: "response.completed", response }
  );
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
};

const message = (text) => ({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});

const seed = async (sandbox, narrative = true) => {
  const files = Object.fromEntries(
    CODEX_PROBE_FILES.map((file) => [file.path, file.content])
  );
  await execute("docker", [
    "exec",
    "--user",
    "0:0",
    sandbox.id,
    "node",
    "-e",
    "const fs=require('node:fs'),path=require('node:path');for(const [p,v] of Object.entries(JSON.parse(process.argv[1]))){const target=path.join('/reprove/workspace',p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,v,{mode:0o444})}",
    JSON.stringify(files),
  ]);
  if (narrative) {
    await sandbox.access.protect(
      "/reprove/input/narrative.json",
      new TextEncoder().encode('{"authority":"none","title":"fixture"}')
    );
  }
};

const qualify = async (provider, authentication) => {
  const sandbox = await provider.launch(
    sandboxRequestFor("codex", CODEX_SANDBOX_PROFILE)
  );
  try {
    await seed(sandbox);
    const proof = await probeCodexInstructions({
      model: "gpt-5.5",
      authentication,
      sandbox,
      signal: AbortSignal.timeout(60_000),
      fetch: () =>
        Promise.resolve(responseEvents(message(JSON.stringify(ANSWER)))),
    });
    expect(proof.satisfied).toBe(true);
    return proof;
  } finally {
    await sandbox.teardown();
  }
};

const RUN_SPEC = {
  runId: "run_01JQ7Z0000000000000000",
  ownerId: "owner_1",
  repositoryId: "repository_1",
  installationId: "installation_1",
  pullRequestNumber: 128,
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  provenance: "internal",
  provenanceBasis: {
    ruleVersion: 1,
    baseRepositoryId: 4242,
    headRepositoryId: 4242,
    authorAssociation: "MEMBER",
    authorId: 99,
    matchedSameRepository: true,
    matchedAssociation: true,
  },
  trigger: "automatic",
  placement: "hosted",
  allowHostedFallback: false,
  harness: "codex",
  model: "gpt-5.5",
  strategy: "standard",
  autonomy: "verify",
  resolvedConfig: {
    schemaVersion: 1,
    review: {
      enabled: true,
      strategy: "standard",
      event: "COMMENT",
      threshold: { severity: "medium", verification: "any" },
      ignore: [],
      baseConventions: true,
      harnessOptions: {},
      overrides: [],
    },
    security: {
      maxExposure: "account",
      allowExternalProvenance: false,
      installScripts: "deny",
      allowHostedFallback: false,
      egress: [],
    },
  },
  configDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb924",
  claimableUntil: "2026-09-06T00:05:00.000Z",
  createdAt: "2026-09-06T00:00:00.000Z",
};

describe("real Codex Adapter contracts", () => {
  beforeAll(buildCodexImage, 240_000);

  it.each([
    "RUN sed -i 's/ --ignore-user-config --ignore-rules//' /opt/reprove/codex/reprove-codex",
    "RUN echo '# rebuilt bootstrap' >> /opt/reprove/codex/pnpm-lock.yaml",
  ])(
    "refuses rebuilt runtime with unchanged CLI version: %s",
    async (change) => {
      const provider = createDockerProvider({
        runtime: createCliRuntime({ name: "docker" }),
      });
      const authentication = {
        kind: "api-key",
        provider: "openai",
        key: "synthetic-broker-key",
      };
      const proof = await qualify(provider, authentication);
      const adapter = createCodexAdapter({
        model: "gpt-5.5",
        authentication,
        instructionProbe: () => Promise.resolve(proof),
      });
      const directory = await mkdtemp(
        path.join(tmpdir(), "reprove-codex-drift-")
      );
      const tag = `reprove-codex-drift:${crypto.randomUUID()}`;
      let sandbox;
      try {
        await writeFile(
          path.join(directory, "Dockerfile"),
          `FROM ${CODEX_SANDBOX_PROFILE.image}\n${change}\n`
        );
        await execute("docker", ["build", "--tag", tag, directory], {
          timeout: 60_000,
        });
        sandbox = await provider.launch(
          sandboxRequestFor("codex", { ...CODEX_SANDBOX_PROFILE, image: tag })
        );
        await seed(sandbox);
        await expect(
          adapter.capability({
            model: "gpt-5.5",
            sandbox,
            signal: AbortSignal.timeout(30_000),
          })
        ).resolves.toMatchObject({ canEnforceRepoInstructionBoundary: false });
      } finally {
        await sandbox?.teardown();
        await execute("docker", ["image", "rm", "--force", tag]);
        await rm(directory, { recursive: true, force: true });
      }
    },
    120_000
  );

  for (const authentication of [
    { kind: "api-key", provider: "openai", key: "synthetic-broker-key" },
    { kind: "api-key", provider: "gateway", key: "synthetic-broker-key" },
    {
      kind: "native",
      authJson: JSON.stringify({
        tokens: {
          access_token: "synthetic-native-key",
          refresh_token: "synthetic-refresh",
          id_token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus" } })).toString("base64url")}.synthetic`,
          account_id: "fixture",
        },
        last_refresh: new Date().toISOString(),
      }),
    },
  ]) {
    if (authentication.kind === "native") {
      it("fails a native Pass with a malformed thread event without starting repair", async () => {
        const runtime = createCliRuntime({ name: "docker" });
        let corrupt = false;
        let invocations = 0;
        const provider = createDockerProvider({
          runtime: {
            ...runtime,
            spawn: (request) => {
              const running = runtime.spawn(request);
              if (!corrupt || !request.arguments.includes("--json")) {
                return running;
              }
              invocations += 1;
              let pending = "";
              const stdout = running.stdout
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(
                  new TransformStream({
                    transform(chunk, output) {
                      pending += chunk;
                      let end;
                      while ((end = pending.indexOf("\n")) !== -1) {
                        const event = JSON.parse(pending.slice(0, end));
                        pending = pending.slice(end + 1);
                        if (event.type === "thread.started") {
                          delete event.thread_id;
                        }
                        output.enqueue(`${JSON.stringify(event)}\n`);
                      }
                    },
                    flush(output) {
                      if (pending) {
                        output.enqueue(pending);
                      }
                    },
                  })
                )
                .pipeThrough(new TextEncoderStream());
              return { ...running, stdout };
            },
          },
        });
        const proof = await qualify(provider, authentication);
        const sandbox = await provider.launch(
          sandboxRequestFor("codex", CODEX_SANDBOX_PROFILE)
        );
        try {
          await seed(sandbox);
          corrupt = true;
          const adapter = createCodexAdapter({
            model: "gpt-5.5",
            authentication,
            instructionProbe: () => Promise.resolve(proof),
            fetch: () => Promise.resolve(responseEvents(message("not JSON"))),
          });
          const result = await adapter.pass({
            runId: "malformed",
            passId: crypto.randomUUID(),
            model: "gpt-5.5",
            autonomy: "verify",
            sandbox,
            instructions: {
              policy: "Return JSON",
              conventions: [],
              narrativePath: "/reprove/input/narrative.json",
            },
            signal: AbortSignal.timeout(30_000),
            check: () => null,
          });
          expect(result).toMatchObject({
            outcome: "failed",
            repairTurnUsed: false,
            failureReason: "codex_execution_failed",
          });
          expect(invocations).toBe(1);
        } finally {
          await sandbox.teardown();
        }
      }, 90_000);
    }
    it(`${authentication.kind}/${authentication.provider ?? "saved-auth"}: suppresses repo instructions, observes execution, and repairs once in the same Pass`, async () => {
      const runtime = createCliRuntime({ name: "docker" });
      const inputs = [];
      const provider = createDockerProvider({
        runtime: {
          ...runtime,
          invoke: (request) => {
            inputs.push(JSON.stringify(request.arguments));
            if (request.stdin) {
              inputs.push(
                Buffer.from(request.stdin, "base64").toString("utf-8")
              );
            }
            return runtime.invoke(request);
          },
          spawn: (request) => {
            inputs.push(JSON.stringify(request.arguments));
            return runtime.spawn(request);
          },
        },
      });
      const proof = await qualify(provider, authentication);
      const sandbox = await provider.launch(
        sandboxRequestFor("codex", CODEX_SANDBOX_PROFILE)
      );
      try {
        await seed(sandbox);
        const requests = [];
        const progress = [];
        const adapter = createCodexAdapter({
          model: "gpt-5.5",
          authentication,
          timeoutMs: 90_000,
          instructionProbe: () => Promise.resolve(proof),
          fetch: async (request) => {
            const body = await request.json();
            requests.push(body);
            expect(request.headers.get("authorization")).toBe(
              `Bearer synthetic-${authentication.kind === "native" ? "native" : "broker"}-key`
            );
            if (requests.length === 1) {
              expect(JSON.stringify(body)).not.toContain(CANARY);
              return responseEvents({
                id: "fc_fixture",
                call_id: "call_fixture",
                type: "function_call",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: "cat /reprove/workspace/AGENTS.md",
                  max_output_tokens: 100,
                }),
                status: "completed",
              });
            }
            if (requests.length === 3) {
              expect(progress.map((event) => event.type)).toEqual(
                expect.arrayContaining(["tool-completed", "repair-started"])
              );
            }
            return responseEvents(
              message(
                requests.length === 2 ? "not JSON" : JSON.stringify(ANSWER)
              )
            );
          },
        });
        let settled = false;
        const mismatched = createCodexAdapter({
          model: "gpt-5.5",
          authentication,
          instructionProbe: () =>
            Promise.resolve({ ...proof, runtimeFingerprint: "0".repeat(64) }),
        });
        await expect(
          mismatched.capability({
            model: "gpt-5.5",
            sandbox,
            signal: AbortSignal.timeout(30_000),
          })
        ).resolves.toMatchObject({ canEnforceRepoInstructionBoundary: false });
        const output = await adapter.pass({
          onProgress: (event) => {
            expect(settled).toBe(false);
            progress.push(event);
          },
          runId: "fixture",
          passId: crypto.randomUUID(),
          model: "gpt-5.5",
          autonomy: "verify",
          instructions: {
            policy: "Review the Workspace. Return JSON.",
            conventions: [],
            narrativePath: "/reprove/input/narrative.json",
          },
          sandbox,
          signal: AbortSignal.timeout(100_000),
          check: () => null,
        });
        settled = true;
        expect(progress.map((event) => event.type)).toEqual(
          expect.arrayContaining([
            "started",
            "tool-completed",
            "usage",
            "repair-started",
            "finished",
          ])
        );
        expect(progress.at(-1)).toMatchObject({
          type: "finished",
          outcome: "completed",
        });
        expect(output).toMatchObject({
          ...ANSWER,
          outcome: "completed",
          repairTurnUsed: true,
          resolvedModel: null,
        });
        expect(
          progress.filter((event) => event.type === "tool-completed")
        ).toEqual([
          { type: "tool-completed", tool: { kind: "command", exitCode: 0 } },
        ]);
        expect(output.observed).toEqual([
          expect.objectContaining({
            command: expect.stringContaining(
              "cat /reprove/workspace/AGENTS.md"
            ),
            exitCode: 0,
          }),
        ]);
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[1])).toContain(CANARY);
        const inputText = inputs.join("\n");
        if (authentication.kind === "api-key") {
          expect(inputText).not.toContain(authentication.key);
        } else {
          expect(inputText).toContain("synthetic-native-key");
        }
        expect(output.usage).toMatchObject({
          inputTokens: 9,
          outputTokens: 12,
        });
      } finally {
        await expect(sandbox.teardown()).resolves.toEqual({ residue: [] });
      }
    }, 120_000);
    it(`${authentication.kind}/${authentication.provider ?? "saved-auth"}: aborts a streaming Provider turn and releases the Sandbox`, async () => {
      const provider = createDockerProvider({
        runtime: createCliRuntime({ name: "docker" }),
      });
      const proof = await qualify(provider, authentication);
      const sandbox = await provider.launch(
        sandboxRequestFor("codex", CODEX_SANDBOX_PROFILE)
      );
      try {
        await seed(sandbox);
        const controller = new AbortController();
        const started = Promise.withResolvers();
        const adapter = createCodexAdapter({
          model: "gpt-5.5",
          authentication,
          instructionProbe: () => Promise.resolve(proof),
          timeoutMs: 30_000,
          fetch: (request) => {
            started.resolve();
            const pending = Promise.withResolvers();
            request.signal.addEventListener(
              "abort",
              () => pending.reject(new Error("cancelled fixture")),
              { once: true }
            );
            return pending.promise;
          },
        });
        const progress = [];
        const running = adapter.pass({
          onProgress: (event) => progress.push(event),
          runId: "cancel",
          passId: crypto.randomUUID(),
          model: "gpt-5.5",
          autonomy: "verify",
          sandbox,
          instructions: {
            policy: "Return JSON",
            conventions: [],
            narrativePath: "/reprove/input/narrative.json",
          },
          signal: controller.signal,
          check: () => null,
        });
        const ended = async () => {
          await running;
          throw new Error("Pass ended before Provider request");
        };
        await Promise.race([started.promise, ended()]);
        controller.abort();
        await expect(running).resolves.toMatchObject({
          outcome: "failed",
          failureReason: "pass_aborted",
        });
        expect(progress.at(-1)).toMatchObject({
          type: "finished",
          outcome: "failed",
          failureReason: "pass_aborted",
        });
      } finally {
        await expect(sandbox.teardown()).resolves.toEqual({ residue: [] });
      }
    }, 90_000);
  }
  it.each([false, true])(
    "Worker normalizes a real Pass and rejects unsupported Evidence (unsupported=%s)",
    async (unsupported) => {
      const provider = createDockerProvider({
        runtime: createCliRuntime({ name: "docker" }),
      });
      const authentication = {
        kind: "api-key",
        provider: "openai",
        key: "synthetic-broker-key",
      };
      const proof = await qualify(provider, authentication);
      let requests = 0;
      const candidate = unsupported
        ? {
            ...ANSWER,
            findings: [
              {
                title: "A claim",
                body: "A bounded claim.",
                severity: "medium",
                verification: "verified",
                location: { path: "AGENTS.md", startLine: 1, endLine: 1 },
                anchoredText: CANARY,
                evidence: [
                  {
                    command: "never executed",
                    exitCode: 1,
                    durationMs: 1,
                    output: "claimed",
                  },
                ],
                patch: null,
              },
            ],
          }
        : ANSWER;
      const adapter = createCodexAdapter({
        model: "gpt-5.5",
        authentication,
        instructionProbe: () => Promise.resolve(proof),
        fetch: () => {
          requests += 1;
          return Promise.resolve(
            responseEvents(message(JSON.stringify(candidate)))
          );
        },
      });
      const core = createWorkerCore({
        adapter,
        sandboxes: provider,
        profile: CODEX_SANDBOX_PROFILE,
        workerBuildVersion: "contract-test",
        materialize: async (sandbox, file) => {
          await seed(sandbox, false);
          await materializeNarrative(sandbox, file);
        },
      });
      const outcome = await core.execute({
        spec: RUN_SPEC,
        narrative: { title: "Review fixture", description: null },
        conventions: [],
        exposure: "none",
      });
      if (unsupported) {
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          kind: "failure",
          failure: { reason: "pass_failed", detail: "evidence_unsupported" },
        });
        expect(requests).toBe(2);
      } else {
        expect(outcome, JSON.stringify(outcome)).toMatchObject({
          kind: "result",
          result: {
            ...ANSWER,
            completeness: "complete",
            protocolVersion: 1,
            workerBuildVersion: "contract-test",
            passes: [
              {
                harness: "codex",
                pinnedModel: "gpt-5.5",
                repairTurnUsed: false,
              },
            ],
          },
        });
        expect(resultSchema.safeParse(outcome.result).success).toBe(true);
        expect(requests).toBe(1);
      }
    },
    60_000
  );
});
