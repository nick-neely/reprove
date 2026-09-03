import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  apiReport,
  consumerDirectory,
  consumerFixture,
  consumerIdentifier,
  exportSubpaths,
  forbiddenUpstreamTypes,
  patternExportKeys,
  pinExternals,
} from "./verify-packages.mjs";
import { publishableWorkspaces } from "./workspaces.mjs";

/** The slice of a packed `package.json` these tests write or read. */
interface Manifest {
  name?: string;
  private?: boolean;
  exports?: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** The compiler options the generated consumer fixture must settle. */
interface ConsumerTsconfig {
  compilerOptions?: {
    moduleResolution?: string;
    skipLibCheck?: boolean;
    types?: string[];
  };
}

const repoRoot = path.join(import.meta.dirname, "..");

const SKIPPED = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "prototypes",
]);

const temporaryRoots: string[] = [];

/**
 * Copies the real repository into a temp dir, the way the workspace verifier's
 * tests do, so a discovery case can flip one manifest flag without touching the
 * checkout. The skip list is what keeps the copy cheap.
 */
const copyRepository = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "reprove-packages-"));
  temporaryRoots.push(root);
  cpSync(repoRoot, root, {
    filter: (source) => !SKIPPED.has(path.basename(source)),
    recursive: true,
  });
  return root;
};

const editManifest = (
  root: string,
  workspace: string,
  edit: (manifest: Manifest) => void
): void => {
  const file = path.join(root, workspace, "package.json");
  // SAFETY: `file` is a manifest this repository owns, copied verbatim by
  // `copyRepository`. Anything malformed enough to break this shape would have
  // failed `pnpm install` first, so the tests would never reach here.
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as Manifest;
  edit(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
};

const names = (root: string): string[] =>
  publishableWorkspaces({ rootDir: root }).map((found) => found.workspace);

/** One package's report, so two declarations can be compared as reports. */
const reportOf = (text: string): string =>
  apiReport({
    name: "@reprove/worker",
    files: [{ path: "dist/index.d.ts", text }],
  });

describe(publishableWorkspaces, () => {
  afterEach(() => {
    while (temporaryRoots.length > 0) {
      const dir = temporaryRoots.pop();
      if (dir) {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  });

  it("finds every publishable package and neither app", () => {
    expect(names(copyRepository())).toStrictEqual([
      "packages/adapters",
      "packages/control-plane",
      "packages/control-plane-workflow",
      "packages/protocol",
      "packages/sandbox-container",
      "packages/worker",
      "packages/worker-core",
      "packages/worker-hosted",
    ]);
  });

  it("drops a package the manifest marks private", () => {
    const root = copyRepository();
    editManifest(root, "packages/worker", (manifest) => {
      manifest.private = true;
    });

    expect(names(root)).not.toContain("packages/worker");
  });

  it("picks up an app the manifest stops marking private", () => {
    const root = copyRepository();
    editManifest(root, "apps/docs", (manifest) => {
      manifest.private = undefined;
    });

    expect(names(root)).toContain("apps/docs");
  });
});

describe(exportSubpaths, () => {
  it("maps the root export to the bare package name", () => {
    expect(
      exportSubpaths({
        name: "@reprove/adapters",
        exports: { ".": { types: "./dist/index.d.ts" } },
      })
    ).toStrictEqual(["@reprove/adapters"]);
  });

  it("maps a versioned subpath and offers no bare name", () => {
    expect(
      exportSubpaths({
        name: "@reprove/protocol",
        exports: { "./v1": { types: "./dist/v1/index.d.ts" } },
      })
    ).toStrictEqual(["@reprove/protocol/v1"]);
  });

  it("skips the manifest subpath and any pattern key", () => {
    expect(
      exportSubpaths({
        name: "@reprove/worker",
        exports: {
          ".": { types: "./dist/index.d.ts" },
          "./package.json": { default: "./package.json" },
          "./internal/*": { default: "./dist/internal/*.js" },
        },
      })
    ).toStrictEqual(["@reprove/worker"]);
  });

  it("returns nothing for a manifest with no exports", () => {
    expect(exportSubpaths({ name: "@reprove/worker" })).toStrictEqual([]);
  });
});

describe(patternExportKeys, () => {
  it("reports a pattern export rather than leaving it silently unproved", () => {
    expect(
      patternExportKeys({
        exports: {
          ".": { types: "./dist/index.d.ts" },
          "./internal/*": { default: "./dist/internal/*.js" },
        },
      })
    ).toStrictEqual(["./internal/*"]);
  });

  it("reports nothing for the export surfaces these packages ship", () => {
    expect(
      patternExportKeys({
        exports: { "./v1": { types: "./dist/v1/index.d.ts" } },
      })
    ).toStrictEqual([]);
  });
});

describe(pinExternals, () => {
  const edge = {
    workspace: "packages/protocol",
    name: "@reprove/protocol",
    dependency: "zod",
    range: "^4.5.4",
    installed: "4.5.4",
  };

  it("pins a dependency the installed version satisfies", () => {
    expect(pinExternals([edge])).toStrictEqual({
      externals: { zod: "4.5.4" },
      problems: [],
    });
  });

  it("rejects a pin the packed manifest's own range would not accept", () => {
    // Without this the fixture would install 4.5.4, prove the package against
    // it, and never notice the manifest asks for something else entirely.
    const { externals, problems } = pinExternals([
      { ...edge, range: "^99.0.0" },
    ]);

    expect(externals).toStrictEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]?.workspace).toBe("packages/protocol");
    expect(problems[0]?.message).toContain('"zod": "^99.0.0"');
    expect(problems[0]?.message).toContain("4.5.4");
  });

  it("rejects two workspaces resolving one dependency differently", () => {
    const { problems } = pinExternals([
      edge,
      {
        ...edge,
        workspace: "packages/worker",
        name: "@reprove/worker",
        installed: "4.6.0",
      },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("4.6.0");
    expect(problems[0]?.message).toContain("4.5.4");
  });

  it("accepts two workspaces that resolve one dependency the same way", () => {
    expect(
      pinExternals([edge, { ...edge, workspace: "packages/worker" }]).problems
    ).toStrictEqual([]);
  });

  it("reports a dependency the workspace never installed", () => {
    const { problems } = pinExternals([{ ...edge, installed: null }]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("pnpm install");
  });
});

describe(consumerIdentifier, () => {
  it("camel-cases a hyphenated package name without its scope", () => {
    expect(consumerIdentifier("@reprove/control-plane-workflow")).toBe(
      "controlPlaneWorkflow"
    );
  });

  it("folds a subpath into the identifier", () => {
    expect(consumerIdentifier("@reprove/protocol/v1")).toBe("protocolV1");
  });

  it("gives every real subpath a distinct identifier", () => {
    const specifiers = [
      "@reprove/adapters",
      "@reprove/control-plane",
      "@reprove/control-plane-workflow",
      "@reprove/protocol/v1",
      "@reprove/sandbox-container",
      "@reprove/worker",
      "@reprove/worker-core",
      "@reprove/worker-hosted",
    ];

    expect(new Set(specifiers.map(consumerIdentifier)).size).toBe(
      specifiers.length
    );
  });
});

describe(consumerFixture, () => {
  const packages = [
    {
      tarball: "/tmp/pack/reprove-protocol-0.0.0.tgz",
      manifest: {
        name: "@reprove/protocol",
        exports: { "./v1": { types: "./dist/v1/index.d.ts" } },
        dependencies: { zod: "^4.5.4" },
      },
    },
    {
      tarball: "/tmp/pack/reprove-worker-core-0.0.0.tgz",
      manifest: {
        name: "@reprove/worker-core",
        exports: { ".": { types: "./dist/index.d.ts" } },
        dependencies: { "@reprove/protocol": "0.0.0" },
      },
    },
  ];
  const fixture = consumerFixture({
    packages,
    externals: { zod: "4.5.4" },
    nodeTypes: "26.4.0",
  });
  const workspace = fixture["pnpm-workspace.yaml"] ?? "";

  it("gives each package a consumer that installs only that package", () => {
    // The isolation this step claims rests entirely on this. A consumer holding
    // every tarball puts the siblings on its own module resolution walk-up, and
    // an undeclared dependency resolves through them.
    // SAFETY: the string under test is one this function just generated.
    const protocol = JSON.parse(
      fixture["consumers/protocol/package.json"] ?? ""
    ) as Manifest;
    // SAFETY: the string under test is one this function just generated.
    const workerCore = JSON.parse(
      fixture["consumers/worker-core/package.json"] ?? ""
    ) as Manifest;

    expect(protocol.dependencies).toStrictEqual({
      "@reprove/protocol": "file:/tmp/pack/reprove-protocol-0.0.0.tgz",
    });
    expect(workerCore.dependencies).toStrictEqual({
      "@reprove/worker-core": "file:/tmp/pack/reprove-worker-core-0.0.0.tgz",
    });
    expect(protocol.devDependencies).toStrictEqual({ "@types/node": "26.4.0" });
  });

  it("leaves the fixture root with no dependencies of its own", () => {
    // SAFETY: the string under test is one this function just generated.
    const root = JSON.parse(fixture["package.json"] ?? "") as Manifest;

    expect(root.dependencies).toBeUndefined();
    expect(root.devDependencies).toBeUndefined();
  });

  it("turns hoisting off, so nothing sits on the walk-up path", () => {
    // pnpm's default `["*"]` builds node_modules/.pnpm/node_modules, which is
    // exactly the directory a package's own resolution walks up through.
    expect(workspace).toContain("hoistPattern: []");
    expect(workspace).toContain("publicHoistPattern: []");
    expect(workspace).toContain("nodeLinker: isolated");
  });

  it("makes the consumers one workspace, so they share one install", () => {
    expect(workspace).toContain('- "consumers/*"');
  });

  it("overrides every internal edge to its sibling tarball", () => {
    // `pnpm pack` rewrites `workspace:*` to a version no registry has, so the
    // override is what makes the transitive edge resolve at all.
    expect(workspace).toContain(
      '"@reprove/protocol": "file:/tmp/pack/reprove-protocol-0.0.0.tgz"'
    );
  });

  it("pins every external to the version the workspace installed", () => {
    expect(workspace).toContain('"zod": "4.5.4"');
  });

  it("imports only its own package's subpaths, and uses each import", () => {
    const protocol = fixture["consumers/protocol/consumer.ts"] ?? "";

    expect(protocol).toContain(
      'import * as protocolV1 from "@reprove/protocol/v1";'
    );
    expect(protocol).toContain("export const surface = {");
    expect(protocol).toContain("  protocolV1,");
    expect(protocol).not.toContain("@reprove/worker-core");
  });

  it("type-checks the packed declarations rather than skipping them", () => {
    // SAFETY: the string under test is one this function just generated.
    const tsconfig = JSON.parse(
      fixture["consumers/worker-core/tsconfig.json"] ?? ""
    ) as ConsumerTsconfig;

    // `skipLibCheck` is asserted here rather than left to the repository base
    // config: the point of this fixture is that the shipped declarations
    // themselves compile, not merely that the consumer's own file does.
    expect(tsconfig.compilerOptions).toMatchObject({
      moduleResolution: "NodeNext",
      skipLibCheck: false,
      types: ["node"],
    });
  });

  it("smoke-imports only its own package's subpaths at runtime", () => {
    const workerCore = fixture["consumers/worker-core/smoke.mjs"] ?? "";

    expect(workerCore).toContain('"@reprove/worker-core"');
    expect(workerCore).not.toContain('"@reprove/protocol/v1"');
  });
});

describe(consumerDirectory, () => {
  it("drops the scope, so each package gets its own fixture directory", () => {
    expect(consumerDirectory("@reprove/control-plane-workflow")).toBe(
      "control-plane-workflow"
    );
  });
});

describe(apiReport, () => {
  it("renders one fenced section per declaration, ordered by path", () => {
    expect(
      apiReport({
        name: "@reprove/worker",
        files: [
          { path: "dist/index.d.ts", text: "export declare const a = 1;\n" },
          { path: "dist/bin.d.ts", text: "export {};\n" },
        ],
      })
    ).toBe(
      `<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run \`pnpm verify:packages --update\` to accept an intended API change. -->

# @reprove/worker

## dist/bin.d.ts

\`\`\`ts
export {};
\`\`\`

## dist/index.d.ts

\`\`\`ts
export declare const a = 1;
\`\`\`
`
    );
  });

  it("drops the source map comment and trailing whitespace", () => {
    expect(
      apiReport({
        name: "@reprove/adapters",
        files: [
          {
            path: "dist/index.d.ts",
            text: "export {};   \r\n//# sourceMappingURL=index.d.ts.map\n",
          },
        ],
      })
    ).toContain("```ts\nexport {};\n```");
  });

  it("reports a one-byte change to a declaration as a different report", () => {
    // This difference is exactly what the checked-in api-report.md is compared
    // against, so a public API change cannot land without a reviewable diff.
    expect(reportOf("export declare const a: 1;\n")).not.toBe(
      reportOf("export declare const a: 2;\n")
    );
  });

  it("keeps doc comments, which are part of the published surface", () => {
    expect(
      apiReport({
        name: "@reprove/adapters",
        files: [{ path: "dist/index.d.ts", text: "/** Why. */\nexport {};\n" }],
      })
    ).toContain("/** Why. */");
  });
});

describe(forbiddenUpstreamTypes, () => {
  it("finds a HarnessV1 type in an exported signature", () => {
    expect(
      forbiddenUpstreamTypes(
        "export declare function make(): HarnessV1Session;\n"
      )
    ).toStrictEqual(["HarnessV1Session"]);
  });

  it("finds both spellings of an experimental type", () => {
    expect(
      forbiddenUpstreamTypes(
        "export declare const s: Experimental_SandboxSession;\nexport declare const t: typeof experimental_steer;\n"
      )
    ).toStrictEqual(["Experimental_SandboxSession", "experimental_steer"]);
  });

  it("finds an upstream package in a declaration import", () => {
    expect(
      forbiddenUpstreamTypes(
        'import type { X } from "@ai-sdk/harness";\nexport declare const x: X;\n'
      )
    ).toStrictEqual(["@ai-sdk/harness"]);
  });

  it("ignores a comment that names the rule it is enforcing", () => {
    expect(
      forbiddenUpstreamTypes(
        '/** Never expose HarnessV1Session or experimental_steer here. */\nexport declare const packageName = "@reprove/adapters";\n'
      )
    ).toStrictEqual([]);
  });

  it("accepts the declarations these packages ship today", () => {
    expect(
      forbiddenUpstreamTypes(
        'export declare const packageName: "@reprove/adapters";\n'
      )
    ).toStrictEqual([]);
  });

  it("reports each offender once", () => {
    expect(
      forbiddenUpstreamTypes(
        "export declare const a: HarnessV1Session;\nexport declare const b: HarnessV1Session;\n"
      )
    ).toStrictEqual(["HarnessV1Session"]);
  });
});
