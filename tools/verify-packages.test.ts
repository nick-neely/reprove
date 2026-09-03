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
  consumerFixture,
  consumerIdentifier,
  exportSubpaths,
  forbiddenUpstreamTypes,
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
      name: "@reprove/protocol",
      tarball: "/tmp/pack/reprove-protocol-0.0.0.tgz",
      manifest: {
        name: "@reprove/protocol",
        exports: { "./v1": { types: "./dist/v1/index.d.ts" } },
        dependencies: { zod: "^4.5.4" },
      },
    },
    {
      name: "@reprove/worker-core",
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

  it("depends on each tarball by absolute file path", () => {
    // SAFETY: the string under test is one this function just generated.
    const manifest = JSON.parse(fixture["package.json"] ?? "") as Manifest;

    expect(manifest.dependencies).toStrictEqual({
      "@reprove/protocol": "file:/tmp/pack/reprove-protocol-0.0.0.tgz",
      "@reprove/worker-core": "file:/tmp/pack/reprove-worker-core-0.0.0.tgz",
    });
    expect(manifest.devDependencies).toStrictEqual({
      "@types/node": "26.4.0",
    });
  });

  it("overrides every internal edge to its sibling tarball", () => {
    // `pnpm pack` rewrites `workspace:*` to a version no registry has, so the
    // override is what makes the transitive edge resolve at all.
    expect(fixture["pnpm-workspace.yaml"]).toContain(
      '"@reprove/protocol": "file:/tmp/pack/reprove-protocol-0.0.0.tgz"'
    );
  });

  it("pins every external to the version the workspace installed", () => {
    expect(fixture["pnpm-workspace.yaml"]).toContain('"zod": "4.5.4"');
  });

  it("keeps the fixture out of any enclosing workspace and unhoisted", () => {
    expect(fixture["pnpm-workspace.yaml"]).toContain("packages: []");
    expect(fixture["pnpm-workspace.yaml"]).toContain("nodeLinker: isolated");
  });

  it("imports every subpath exactly once and uses each import", () => {
    expect(fixture["consumer.ts"]).toContain(
      'import * as protocolV1 from "@reprove/protocol/v1";'
    );
    expect(fixture["consumer.ts"]).toContain(
      'import * as workerCore from "@reprove/worker-core";'
    );
    expect(fixture["consumer.ts"]).toContain("export const surface = {");
    expect(fixture["consumer.ts"]).toContain("  protocolV1,");
    expect(fixture["consumer.ts"]).toContain("  workerCore,");
  });

  it("type-checks the packed declarations rather than skipping them", () => {
    // SAFETY: the string under test is one this function just generated.
    const tsconfig = JSON.parse(
      fixture["tsconfig.json"] ?? ""
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

  it("smoke-imports every subpath at runtime", () => {
    expect(fixture["smoke.mjs"]).toContain('"@reprove/protocol/v1"');
    expect(fixture["smoke.mjs"]).toContain('"@reprove/worker-core"');
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
