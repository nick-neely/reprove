import { describe, expect, it } from "vitest";

import { createCodexAdapter, codexFingerprint } from "./index.js";

describe("the Codex Adapter capability", () => {
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
