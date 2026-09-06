import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";

import { VERSION } from "@ai-sdk/harness-codex";

import { ARTIFACT_FINGERPRINT } from "./fingerprint.js";
import { invokeCodex, nativeAuthentication } from "./pass.js";
import { checkCodexSandbox } from "./preflight.js";
import type { Adapter, ResolvedCapability } from "./types.js";

export type CodexAuthentication =
  | {
      readonly kind: "api-key";
      readonly provider: "openai" | "gateway";
      readonly key: string;
    }
  | { readonly kind: "native"; readonly authJson: string };

export interface InstructionProbe {
  readonly runtimeFingerprint: string;
  readonly fingerprint: string;
  readonly probedAt: number;
  readonly satisfied: boolean;
}

export interface CodexOptions {
  readonly model: string;
  readonly timeoutMs?: number;
  readonly authentication: CodexAuthentication;
  /** A behavioral measurement, never a version allowlist or a claimed default. */
  readonly instructionProbe?: (
    signal: AbortSignal
  ) => Promise<InstructionProbe>;
  /** Substitutable only at the external Provider HTTP boundary. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

export const CODEX_CLI_VERSION = "0.149.1";
export const codexFingerprint = (
  authentication: CodexAuthentication,
  model: string
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        bridge: VERSION,
        artifact: ARTIFACT_FINGERPRINT,
        cli: CODEX_CLI_VERSION,
        route: authentication.kind,
        provider:
          authentication.kind === "api-key"
            ? authentication.provider
            : "native",
        model,
        suppression: 1,
      })
    )
    .digest("hex");

export const createCodexAdapter = (input: CodexOptions): Adapter => {
  const options = { ...input, authentication: { ...input.authentication } };
  if (!options.model.trim()) {
    throw new TypeError("a Pass needs an explicit Model");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new RangeError("Pass timeout must be a positive integer");
  }
  if (options.authentication.kind === "native") {
    nativeAuthentication(options.authentication.authJson);
  } else if (!options.authentication.key.trim()) {
    throw new TypeError("Codex credential is empty");
  }
  const fingerprint = codexFingerprint(options.authentication, options.model);
  const capability: Adapter["capability"] = async (
    request
  ): Promise<ResolvedCapability> => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(request ? [request.signal] : []),
    ]);
    signal.throwIfAborted();
    const cancelled = Promise.withResolvers<never>();
    const subscription = addAbortListener(signal, () =>
      cancelled.reject(signal.reason)
    );
    let probe: InstructionProbe | undefined;
    try {
      probe = await Promise.race([
        options.instructionProbe?.(signal),
        cancelled.promise,
      ]);
    } finally {
      subscription[Symbol.dispose]();
    }
    signal.throwIfAborted();
    const established =
      probe?.satisfied === true &&
      probe.fingerprint === fingerprint &&
      /^[a-f0-9]{64}$/u.test(probe.runtimeFingerprint) &&
      Number.isSafeInteger(probe.probedAt) &&
      probe.probedAt <= Date.now() &&
      Date.now() - probe.probedAt <= 300_000 &&
      (!request ||
        (request.model === options.model &&
          (await checkCodexSandbox({ ...request, signal })) ===
            probe.runtimeFingerprint));
    return {
      exposure: options.authentication.kind === "native" ? "account" : "none",
      supportedAutonomy: established ? ["verify"] : [],
      canEnforceRepoInstructionBoundary: established,
      reportsResolvedModel: false,
      probeFingerprint: fingerprint,
      probedAt: probe?.probedAt ?? 0,
    };
  };
  return {
    harness: "codex",
    capability,
    pass: async (request) => {
      let output;
      try {
        request.onProgress?.({ type: "started" });
        const resolved = await capability(request);
        if (!resolved.canEnforceRepoInstructionBoundary) {
          throw new Error(
            "Codex instruction boundary has no fresh matching probe"
          );
        }
        output = await invokeCodex(options, request);
      } catch (error) {
        request.onProgress?.({
          type: "finished",
          outcome: "failed",
          failureReason: "codex_execution_failed",
        });
        throw error;
      }
      request.onProgress?.({
        type: "finished",
        outcome: output.outcome,
        failureReason: output.failureReason,
      });
      return output;
    },
  };
};
