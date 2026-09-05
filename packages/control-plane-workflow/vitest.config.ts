import { workflow } from "@workflow/vitest";
import { defineConfig } from "vitest/config";

/**
 * This package's tests run its workflows under a real Workflow builder, which
 * is why they have a project of their own: `@workflow/vitest` compiles every
 * `'use workflow'` and `'use step'` function it discovers under this directory
 * into bundles and executes them in-process against the local World, and
 * nothing else in the repository wants that transform or that setup. It also
 * has to run **from this directory**: the transform stamps a workflow's id from
 * `process.cwd()` and the bundle stamps it from the project root, and the two
 * agree only when those are the same place. So the root config excludes this
 * package and `pnpm verify:test` runs `pnpm --filter` into it.
 *
 * The step bundle runs from a module registry of its own, so a step resolves
 * its configuration from `process.env` rather than from anything a test
 * composed - which is the builder-dependence ADR 0014 built this package
 * around, exercised rather than assumed.
 */
export default defineConfig({
  plugins: [workflow()],
  test: {
    name: "control-plane-workflow",
    include: ["src/**/*.test.ts"],
    // A lifecycle sleeps toward a real deadline and `returnValue` polls once a
    // second, so a case that watches a window close takes seconds by design.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
