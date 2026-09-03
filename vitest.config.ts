import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "prototypes/**",
    ],
    include: ["**/*.test.{ts,mts,mjs}"],
    // The tools tests copy the whole repository per case, so their cost is
    // runner disk rather than compute and the 5s default has no headroom on a
    // slow one.
    testTimeout: 30_000,
  },
});
