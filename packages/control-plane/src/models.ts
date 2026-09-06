import type { Harness } from "@reprove/protocol/v1";

/** Reprove product data. Harnesses receive an opaque pin and never enumerate Models. */
export const MODEL_CATALOGUE = [
  { harness: "codex", model: "gpt-5" },
  { harness: "codex", model: "gpt-5.5" },
] as const satisfies readonly {
  readonly harness: Harness;
  readonly model: string;
}[];

export const availableModels = (harness: Harness): readonly string[] =>
  MODEL_CATALOGUE.filter((entry) => entry.harness === harness).map(
    (entry) => entry.model
  );

export const DEFAULT_CODEX_MODEL = MODEL_CATALOGUE[0].model;
