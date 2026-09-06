/**
 * `@reprove/adapters` may not depend on `@reprove/protocol`: an Adapter
 * yields the unnamed per-Pass bundle and `@reprove/worker-core` composes the
 * wire Result, so an Adapter that knew the wire format would be reaching a
 * layer above itself (ADR 0005, ADR 0010).
 */
export const packageName = "@reprove/adapters" as const;

export { CODEX_PROBE_FILES, probeCodexInstructions } from "./probe.js";

export { codexImageFiles } from "./image.js";
export type { ImageFile } from "./image.js";
export {
  createCodexAdapter,
  codexFingerprint,
  CODEX_CLI_VERSION,
} from "./codex.js";
export type {
  CodexOptions,
  CodexAuthentication,
  InstructionProbe,
} from "./codex.js";

export type { PassProgress } from "./types.js";

export { CODEX_REASONING_EFFORTS } from "./reasoning.js";
export type { CodexReasoningEffort } from "./reasoning.js";
