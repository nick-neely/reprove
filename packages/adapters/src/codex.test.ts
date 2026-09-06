import { describe, expect, it } from "vitest";

import { createCodexAdapter, codexFingerprint } from "./index.js";

describe("the Codex Adapter capability", () => {
  it("cancels a pending probe even if its callback never settles", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<boolean>();
    const adapter = createCodexAdapter({
      model: "gpt-5.5",
      authentication: { kind: "api-key", provider: "openai", key: "synthetic" },
      instructionProbe: () => {
        started.resolve(true);
        return Promise.withResolvers<never>().promise;
      },
    });
    const result = adapter.capability({
      model: "gpt-5.5",
      sandbox: { id: "fixture", workspace: { path: "/reprove/workspace" } },
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(new Error("cancelled probe"));
    await expect(result).rejects.toThrow("cancelled probe");
  }, 1000);

  it("withdraws capability when the actual Sandbox lacks streaming access", async () => {
    const authentication = {
      kind: "api-key",
      provider: "openai",
      key: "synthetic",
    } as const;
    const adapter = createCodexAdapter({
      model: "gpt-5.5",
      authentication,
      instructionProbe: () =>
        Promise.resolve({
          fingerprint: codexFingerprint(authentication, "gpt-5.5"),
          probedAt: Date.now(),
          satisfied: true,
          runtimeFingerprint: "a".repeat(64),
        }),
    });
    await expect(
      adapter.capability({
        model: "gpt-5.5",
        sandbox: { id: "buffered", workspace: { path: "/reprove/workspace" } },
        signal: AbortSignal.timeout(1000),
      })
    ).resolves.toMatchObject({
      supportedAutonomy: [],
      canEnforceRepoInstructionBoundary: false,
    });
  });

  it("does not claim an instruction boundary without a matching behavioral probe", async () => {
    const adapter = createCodexAdapter({
      model: "gpt-5.5",
      authentication: { kind: "api-key", provider: "openai", key: "test-key" },
    });
    expect(adapter.harness).toBe("codex");
    await expect(adapter.capability()).resolves.toMatchObject({
      supportedAutonomy: [],
      canEnforceRepoInstructionBoundary: false,
      reportsResolvedModel: false,
    });
  });
});
