import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyWorkspace } from "./verify-workspace.mjs";

interface Violation {
  workspace: string;
  rule: string;
  message: string;
}
/**
 * The slice of a workspace `package.json` these tests write or edit. Naming the
 * fields is what lets each case below mutate a manifest directly; an open
 * `Record<string, unknown>` would push an assertion onto every call site.
 */
interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  exports?: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const repoRoot = path.join(import.meta.dirname, "..");

/** The date the verifier compares a `review-by` against, spelled the same way. */
const today = new Date().toISOString().slice(0, 10);

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
 * Copies the real repository - manifests, configs and sources - into a temp dir.
 * The skip list is what keeps the copy cheap: `node_modules` and the build
 * outputs dwarf the sources, and the verifier never reads any of them.
 */
const copyRepository = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "reprove-verify-"));
  temporaryRoots.push(root);
  cpSync(repoRoot, root, {
    filter: (source) => !SKIPPED.has(path.basename(source)),
    recursive: true,
  });
  return root;
};

const writeManifest = (
  root: string,
  workspace: string,
  manifest: Manifest
): void => {
  writeFileSync(
    path.join(root, workspace, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
};

const editManifest = (
  root: string,
  workspace: string,
  edit: (manifest: Manifest) => void
): void => {
  const file = path.join(root, workspace, "package.json");
  // SAFETY: `file` is a manifest this repository owns, copied verbatim by
  // `copyRepository` or written by `writeManifest` above. Anything malformed
  // enough to break this shape would have failed `pnpm install` first, so the
  // tests would never reach here.
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as Manifest;
  edit(manifest);
  writeManifest(root, workspace, manifest);
};

const writeSource = (root: string, file: string, source: string): void => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
};

/**
 * Rewrites `pnpm-workspace.yaml` around one `trustPolicyExclude` block, keeping
 * the settled globs so only the supply-chain rule is under test.
 */
const writeWorkspaceYaml = (
  root: string,
  exclude: string,
  key = "trustPolicyExclude:"
): void => {
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    `packages:\n  - packages/*\n  - apps/*\n\n${key}\n${exclude}`
  );
};

const broke = (
  violations: Violation[],
  rule: string,
  workspace: string,
  fragment = ""
): boolean =>
  violations.some(
    (violation) =>
      violation.rule === rule &&
      violation.workspace === workspace &&
      violation.message.includes(fragment)
  );

describe(verifyWorkspace, () => {
  afterEach(() => {
    while (temporaryRoots.length > 0) {
      const dir = temporaryRoots.pop();
      if (dir) {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  });

  // The one baseline case. It runs against the copy every rejection below
  // mutates, so it proves the repository holds *and* that the copy is faithful;
  // a second run against `repoRoot` would only restate the first half, and
  // `pnpm verify` already runs the verifier against the real repository.
  it("passes on a faithful copy of the repository", () => {
    expect(verifyWorkspace({ rootDir: copyRepository() })).toStrictEqual([]);
  });

  it("rejects an extra workspace", () => {
    const root = copyRepository();
    mkdirSync(path.join(root, "packages/extra/src"), { recursive: true });
    writeManifest(root, "packages/extra", {
      name: "@reprove/extra",
      version: "0.0.0",
      scripts: { build: "tsc", typecheck: "tsc --noEmit" },
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "workspace-set",
        "packages/extra"
      )
    ).toBeTruthy();
  });

  it("rejects a missing workspace", () => {
    const root = copyRepository();
    rmSync(path.join(root, "packages/adapters"), {
      force: true,
      recursive: true,
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "workspace-set",
        "packages/adapters"
      )
    ).toBeTruthy();
  });

  it("rejects a workspace glob that would pull prototypes in", () => {
    const root = copyRepository();
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n  - apps/*\n  - prototypes/*\n"
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "workspace-globs",
        "<root>",
        "prototypes/*"
      )
    ).toBeTruthy();
  });

  it("rejects a renamed package", () => {
    const root = copyRepository();
    editManifest(root, "packages/protocol", (manifest) => {
      manifest.name = "@reprove/wire";
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "package-name",
        "packages/protocol",
        "@reprove/protocol"
      )
    ).toBeTruthy();
  });

  it("rejects a flipped publishability flag", () => {
    const root = copyRepository();
    editManifest(root, "packages/worker", (manifest) => {
      manifest.private = true;
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "publishability",
        "packages/worker"
      )
    ).toBeTruthy();
  });

  it("rejects a published app", () => {
    const root = copyRepository();
    editManifest(root, "apps/docs", (manifest) => {
      manifest.private = undefined;
    });

    expect(
      broke(verifyWorkspace({ rootDir: root }), "publishability", "apps/docs")
    ).toBeTruthy();
  });

  it("rejects a changed bin", () => {
    const root = copyRepository();
    editManifest(root, "packages/control-plane", (manifest) => {
      manifest.bin = { reprove: "./dist/bin.js" };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "package-bin",
        "packages/control-plane"
      )
    ).toBeTruthy();
  });

  it("rejects a changed export surface", () => {
    const root = copyRepository();
    editManifest(root, "packages/protocol", (manifest) => {
      manifest.exports = {
        ".": { types: "./dist/v1/index.d.ts", default: "./dist/v1/index.js" },
        "./v1": {
          types: "./dist/v1/index.d.ts",
          default: "./dist/v1/index.js",
        },
      };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "package-exports",
        "packages/protocol"
      )
    ).toBeTruthy();
  });

  it("rejects @reprove/control-plane declaring @reprove/worker-core, by name", () => {
    const root = copyRepository();
    editManifest(root, "packages/control-plane", (manifest) => {
      manifest.dependencies = {
        ...manifest.dependencies,
        "@reprove/worker-core": "workspace:*",
      };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "dependency-allowlist",
        "packages/control-plane",
        "@reprove/worker-core"
      )
    ).toBeTruthy();
  });

  it("rejects @reprove/adapters declaring @reprove/protocol, by name", () => {
    const root = copyRepository();
    editManifest(root, "packages/adapters", (manifest) => {
      manifest.dependencies = { "@reprove/protocol": "workspace:*" };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "dependency-allowlist",
        "packages/adapters",
        "@reprove/protocol"
      )
    ).toBeTruthy();
  });

  it("rejects an internal edge that does not use the workspace protocol", () => {
    const root = copyRepository();
    editManifest(root, "packages/worker", (manifest) => {
      manifest.dependencies = {
        ...manifest.dependencies,
        "@reprove/worker-core": "^0.0.0",
      };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "dependency-protocol",
        "packages/worker"
      )
    ).toBeTruthy();
  });

  it("rejects a deep import that bypasses a package export", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/worker-core/src/index.ts",
      'import { protocolVersion } from "@reprove/protocol/src/v1/index.js";\nexport const packageName = protocolVersion;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/worker-core",
        "@reprove/protocol/src/v1/index.js"
      )
    ).toBeTruthy();
  });

  it("rejects a relative import that escapes the workspace", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/worker/src/index.ts",
      'import { protocolVersion } from "../../protocol/src/v1/index.js";\nexport const packageName = protocolVersion;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/worker"
      )
    ).toBeTruthy();
  });

  it("rejects an import of a forbidden external dependency", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/control-plane/src/index.ts",
      'import { start } from "workflow";\nexport const packageName = start;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/control-plane",
        "workflow"
      )
    ).toBeTruthy();
  });

  it("rejects a boundary violation outside src/, naming the file", () => {
    const root = copyRepository();
    writeSource(
      root,
      "apps/control-plane/next.config.ts",
      'import { workerCore } from "@reprove/worker-core";\nexport default workerCore;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "apps/control-plane",
        "next.config.ts"
      )
    ).toBeTruthy();
  });

  it("rejects a boundary violation in a JavaScript file, naming the file", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/control-plane/src/extra.mjs",
      'import "@reprove/worker-core";\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/control-plane",
        "packages/control-plane/src/extra.mjs"
      )
    ).toBeTruthy();
  });

  it("rejects a published package importing a shared dev dependency", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/protocol/src/v1/index.ts",
      'import ts from "typescript";\nexport const protocolVersion = ts.version;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/protocol",
        "typescript"
      )
    ).toBeTruthy();
  });

  it("rejects a published package importing the test runner outside a test", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/control-plane/src/shipped.ts",
      'import { expect } from "vitest";\nexport const shipped = expect;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/control-plane",
        "vitest"
      )
    ).toBeTruthy();
  });

  it("permits a test file importing the declared test runner", () => {
    const root = copyRepository();
    writeSource(
      root,
      "packages/control-plane/src/shipped.test.ts",
      'import { expect } from "vitest";\nexport const shipped = expect;\n'
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "import-boundary",
        "packages/control-plane",
        "vitest"
      )
    ).toBeFalsy();
  });

  it("rejects a package shipping a runtime asset the matrix does not name", () => {
    const root = copyRepository();
    editManifest(root, "packages/worker", (manifest) => {
      manifest.files = ["dist", "drizzle"];
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "publishability",
        "packages/worker",
        "files"
      )
    ).toBeTruthy();
  });

  it("rejects the control plane dropping its migration folder", () => {
    const root = copyRepository();
    editManifest(root, "packages/control-plane", (manifest) => {
      manifest.files = ["dist"];
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "publishability",
        "packages/control-plane",
        "drizzle"
      )
    ).toBeTruthy();
  });

  it("rejects an external dependency outside the allowlist, by name", () => {
    const root = copyRepository();
    editManifest(root, "packages/protocol", (manifest) => {
      manifest.dependencies = { ...manifest.dependencies, octokit: "^5.0.0" };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "dependency-allowlist",
        "packages/protocol",
        "octokit"
      )
    ).toBeTruthy();
  });

  it("rejects a chained build script", () => {
    const root = copyRepository();
    editManifest(root, "packages/protocol", (manifest) => {
      manifest.scripts = {
        ...manifest.scripts,
        build: "tsc -p tsconfig.build.json && echo done",
      };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "task-scripts",
        "packages/protocol",
        "build"
      )
    ).toBeTruthy();
  });

  it("rejects a root devDependency the matrix gives a workspace, by name", () => {
    const root = copyRepository();
    editManifest(root, ".", (manifest) => {
      manifest.devDependencies = {
        ...manifest.devDependencies,
        "drizzle-orm": "^0.45.0",
      };
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "root-dependencies",
        "<root>",
        "drizzle-orm"
      )
    ).toBeTruthy();
  });

  it("rejects a root manifest that declares dependencies", () => {
    const root = copyRepository();
    editManifest(root, ".", (manifest) => {
      manifest.dependencies = { "@reprove/protocol": "workspace:*" };
    });

    expect(
      broke(verifyWorkspace({ rootDir: root }), "root-dependencies", "<root>")
    ).toBeTruthy();
  });

  it("rejects a supply-chain exception with no review-by date", () => {
    const root = copyRepository();
    writeWorkspaceYaml(root, "  - undici-types@6.21.0\n");

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "supply-chain-exception",
        "<root>",
        "undici-types@6.21.0"
      )
    ).toBeTruthy();
  });

  it("rejects a supply-chain exception whose review-by date has passed", () => {
    const root = copyRepository();
    writeWorkspaceYaml(
      root,
      "  # review-by: 2020-01-01\n  - undici-types@6.21.0\n"
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "supply-chain-exception",
        "<root>",
        "2020-01-01"
      )
    ).toBeTruthy();
  });

  it("accepts a supply-chain exception reviewed today", () => {
    const root = copyRepository();
    writeWorkspaceYaml(
      root,
      `  # review-by: ${today}\n  - undici-types@6.21.0\n`
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "supply-chain-exception",
        "<root>"
      )
    ).toBeFalsy();
  });

  it("rejects an expired exception under a key line carrying a comment", () => {
    const root = copyRepository();
    writeWorkspaceYaml(
      root,
      "  # review-by: 2020-01-01\n  - undici-types@6.21.0\n",
      "trustPolicyExclude: # reviewed exceptions"
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "supply-chain-exception",
        "<root>",
        "undici-types@6.21.0"
      )
    ).toBeTruthy();
  });

  it("accepts a reviewed exception under a key line carrying a comment", () => {
    const root = copyRepository();
    writeWorkspaceYaml(
      root,
      `  # review-by: ${today}\n  - undici-types@6.21.0\n`,
      "trustPolicyExclude: # reviewed exceptions"
    );

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "supply-chain-exception",
        "<root>"
      )
    ).toBeFalsy();
  });

  it("rejects a missing typecheck script", () => {
    const root = copyRepository();
    editManifest(root, "packages/adapters", (manifest) => {
      delete manifest.scripts?.typecheck;
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "task-scripts",
        "packages/adapters",
        "typecheck"
      )
    ).toBeTruthy();
  });

  it("rejects a missing build script", () => {
    const root = copyRepository();
    editManifest(root, "apps/control-plane", (manifest) => {
      delete manifest.scripts?.build;
    });

    expect(
      broke(
        verifyWorkspace({ rootDir: root }),
        "task-scripts",
        "apps/control-plane",
        "build"
      )
    ).toBeTruthy();
  });
});
