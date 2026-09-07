import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "prototypes/**",
    // Adversarial-gate fixtures are content-addressed: `corpusVersion` digests
    // their exact bytes, so neither the linter nor the formatter may touch them.
    "tools/gate/corpus/**",
    "**/*.md",
    "docs/**",
    // GitHub configuration is hand-authored YAML; reformatting it is churn.
    "**/*.yml",
    "**/*.yaml",
  ],
});
