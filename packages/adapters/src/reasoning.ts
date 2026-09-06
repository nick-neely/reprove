import { z } from "zod";

export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export const resolveReasoningEffort = (
  value: CodexReasoningEffort = "medium"
): CodexReasoningEffort => z.enum(CODEX_REASONING_EFFORTS).parse(value);
