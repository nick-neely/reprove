import type { Harness, CodexReasoningEffort } from "@reprove/protocol/v1";

/** Reprove product data. Harnesses receive an opaque pin and never enumerate Models. */
export const MODEL_CATALOGUE = [
  {
    harness: "codex",
    model: "gpt-5.6-sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    harness: "codex",
    model: "gpt-5",
    reasoningEfforts: ["low", "medium", "high"],
  },
  {
    harness: "codex",
    model: "gpt-5.5",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
] as const satisfies readonly {
  readonly harness: Harness;
  readonly model: string;
  readonly reasoningEfforts: readonly CodexReasoningEffort[];
}[];

export const availableModels = (harness: Harness): readonly string[] =>
  MODEL_CATALOGUE.filter((entry) => entry.harness === harness).map(
    (entry) => entry.model
  );

export const DEFAULT_CODEX_MODEL = MODEL_CATALOGUE[0].model;

export const DEFAULT_CODEX_REASONING_EFFORT = "medium" as const;

/** Only levels supported by both the selected Model and the Codex bridge. */
export const availableReasoningEfforts = (
  harness: Harness,
  model: string
): readonly CodexReasoningEffort[] =>
  MODEL_CATALOGUE.find(
    (entry) => entry.harness === harness && entry.model === model
  )?.reasoningEfforts ?? [];
