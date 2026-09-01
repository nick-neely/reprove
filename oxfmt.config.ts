import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "prototypes/**",
    "**/*.md",
    "docs/**",
    // GitHub configuration is hand-authored YAML; reformatting it is churn.
    "**/*.yml",
    "**/*.yaml",
  ],
});
