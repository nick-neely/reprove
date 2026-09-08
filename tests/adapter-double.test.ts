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

/**
 * A file `tsconfig.build.json` keeps out of `dist`, spelled the way
 * `tools/verify-workspace.mjs` spells it: a test, and the support module a test
 * imports.
 *
 * `.d` is optional in the middle because the assertions below read `dist`, and
 * every build here inherits `declaration: true`: a test source that reached the
 * build output arrives as `example.test.js` *and* `example.test.d.ts`, and a
 * pattern anchored on `.ts` alone would report the second one as shipped
 * output like any other module.
 */
const UNSHIPPED = /\.test(?:-support)?(?:\.d)?\.[cm]?tsx?$/u;

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
    //
    // Scoped to what each lifecycle **ships**, which is the property: an
    // unshipped file may name a test-support module, because that is what a
    // test is for and `tsconfig.build.json` keeps both out of `dist`. The next
    // case is what holds that half, over the artifact rather than over a name.
    for (const workspace of ["packages/worker", "packages/worker-hosted"]) {
      const sources = sourcesOf(workspace).filter(
        (file) => !UNSHIPPED.test(file)
      );

      // A lifecycle whose sources vanished would otherwise assert nothing.
      expect(sources.length).toBeGreaterThan(0);
      for (const file of sources) {
        const source = readFileSync(file, "utf-8");

        expect(source).not.toContain("test-support");
        expect(source).not.toContain("Double");
      }
    }
  });

  it("cannot arrive in either lifecycle's build output", () => {
    // The other half of the case above, and the one that survives a test file
    // being renamed: whatever a lifecycle's sources say, its `dist` carries no
    // test and no test-support module at all.
    for (const workspace of ["packages/worker", "packages/worker-hosted"]) {
      const shipped = filesUnder(path.join(ROOT, workspace, "dist"));

      expect(shipped.length).toBeGreaterThan(0);
      expect(shipped.filter((file) => UNSHIPPED.test(file))).toStrictEqual([]);
      for (const file of shipped) {
        expect(readFileSync(file, "utf-8")).not.toContain("test-support");
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

  it("names an unshipped file in every spelling a build emits it as", () => {
    // The `dist` assertions above are only as strong as this pattern, and one
    // spelling is easy to miss: the builds set `declaration: true`, so a test
    // source that reached the output arrives twice - once as JavaScript and
    // once as `.d.ts` - and a pattern that matched only the first would let the
    // declaration through as ordinary shipped output.
    //
    // The JavaScript half needs no spelling of its own: the two are emitted
    // together, so matching the declaration is enough for the assertion to
    // fail on a test that reached `dist`.
    for (const unshipped of [
      "packages/worker-core/src/boundary.test.ts",
      "packages/worker-core/src/boundary.test-support.ts",
      "packages/worker-core/dist/boundary.test.d.ts",
      "packages/worker-core/dist/boundary.test-support.d.ts",
    ]) {
      expect(UNSHIPPED.test(unshipped)).toBeTruthy();
    }

    // And nothing else: `.test` has to be the whole segment before the
    // extension, or a module whose name merely ends in it would be read as a
    // test and excused from every assertion above.
    for (const shipped of [
      "packages/worker-core/src/boundary.ts",
      "packages/worker-core/dist/boundary.d.ts",
      "packages/worker-core/dist/latest.d.ts",
      "packages/worker-core/dist/test.d.ts",
    ]) {
      expect(UNSHIPPED.test(shipped)).toBeFalsy();
    }
  });
});
