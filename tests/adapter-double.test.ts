import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The Adapter double is test-only, and this is what makes that a fact rather
 * than an intention.
 *
 * `@reprove/worker-core` holds a Codex Adapter double so one fixed Run can be
 * taken through the Worker boundary without a Harness. It is a
 * `*.test-support.ts`, which `tsconfig.build.json` keeps out of `dist` and
 * `tools/verify-workspace.mjs` matches from the other direction - but both of
 * those are rules about files, and the thing worth asserting is the artifact:
 * a Harness that answers without a Harness must not be reachable from the
 * composed Worker, in either lifecycle.
 *
 * Read against built output, which is why `turbo run build` precedes
 * `vitest run` in the verify seam.
 */
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));

const sourcesOf = (workspace: string): string[] =>
  filesUnder(path.join(ROOT, workspace, "src"));

describe("the test-only Codex Adapter double", () => {
  it("is absent from the Worker core the composed Worker installs", () => {
    const shipped = filesUnder(path.join(ROOT, "packages/worker-core/dist"));

    expect(shipped.length).toBeGreaterThan(0);
    expect(
      shipped.filter((file) => /\.test(?:-support)?\./u.test(file))
    ).toStrictEqual([]);
    for (const file of shipped) {
      expect(readFileSync(file, "utf-8")).not.toContain(
        "createCodexAdapterDouble"
      );
    }
  });

  it("is unreachable from either execution lifecycle", () => {
    // Neither `@reprove/worker` nor `@reprove/worker-hosted` may name it, and
    // neither could resolve it if it did: it is not in `dist`, and the package
    // exports one subpath.
    for (const workspace of ["packages/worker", "packages/worker-hosted"]) {
      const sources = sourcesOf(workspace);

      // A lifecycle whose sources vanished would otherwise assert nothing.
      expect(sources.length).toBeGreaterThan(0);
      for (const file of sources) {
        const source = readFileSync(file, "utf-8");

        expect(source).not.toContain("test-support");
        expect(source).not.toContain("Double");
      }
    }
  });

  it("lives where both halves of the unshipped rule can see it", () => {
    // The two directions have disagreed before: a `*.test-support.ts` was
    // excluded from `dist` and not matched by the import-boundary rule, which
    // left a file unshipped in fact and shipped as far as that rule could tell.
    // SAFETY: the file is this repository's own tsconfig, and the one field
    // read is the field the assertion is about.
    const build = JSON.parse(
      readFileSync(
        path.join(ROOT, "packages/worker-core/tsconfig.build.json"),
        "utf-8"
      ).replaceAll(/^\s*\/\/.*$/gmu, "")
    ) as { exclude: string[] };

    expect(build.exclude).toContain("src/**/*.test-support.ts");
    expect(
      sourcesOf("packages/worker-core").filter((file) =>
        file.endsWith("boundary.test-support.ts")
      )
    ).toHaveLength(1);
  });
});
