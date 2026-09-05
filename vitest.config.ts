import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "prototypes/**",
      // `@reprove/control-plane-workflow` runs its workflows under a real
      // Workflow builder, from its own directory and its own config, because
      // the transform and the bundle have to agree on where the project root
      // is. `pnpm verify:test` runs it after this one.
      "packages/control-plane-workflow/**",
    ],
    include: ["**/*.test.{ts,mts,mjs}"],
    // The tools tests copy the whole repository per case, so their cost is
    // runner disk rather than compute and the 5s default has no headroom on a
    // slow one.
    testTimeout: 30_000,
  },
});
