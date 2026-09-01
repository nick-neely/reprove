import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

// Lint and format configuration lives at the repository root only; no workspace
// carries its own (issue #29).
export default defineConfig({
  // `antiSlop` extends last on purpose. It is Ultracite's bundled build of
  // https://github.com/dmmulroy/anti-slop, and beyond the plugin's own fifteen
  // rules it switches off the two core rules that fight them - the
  // `consistent-indexed-object-style` autofix produces a `Record` alias that
  // `no-known-value-widening` then rejects, and `no-immediate-mutation` bans
  // that rule's own empty-accumulator escape. Extending it after core is what
  // makes those two off rather than on.
  extends: [core, react, next, vitest, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    // Throwaway prototype scratch, deliberately outside the workspace.
    "prototypes/**",
    // Prose and specification sketches. Reflowing hand-wrapped prose produces a
    // diff that hides the edit that mattered, so the formatter stays out.
    "**/*.md",
    "docs/**",
    // GitHub configuration is hand-authored YAML; reformatting it is churn.
    "**/*.yml",
    "**/*.yaml",
  ],
  rules: {
    // An `exports` map must list `types` first, and the ADR 0010 matrix in
    // tools/verify-workspace.mjs reads in the ADR's own column order. Sorting
    // either alphabetically would break a real contract or a real mapping.
    "sort-keys": "off",
  },
});
