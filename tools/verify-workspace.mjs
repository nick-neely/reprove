#!/usr/bin/env node
/**
 * The single source of truth for ADR 0010's architecture invariants, as amended
 * by ADR 0014.
 *
 * The allowlist below is the whole matrix. There is deliberately no second
 * dependency matrix and no package-local boundary configuration anywhere else
 * in the repository: adding a permitted dependency means editing this table, in
 * a diff a reviewer can read against the ADR.
 *
 * Run as `node tools/verify-workspace.mjs`. It prints every violation, each
 * naming the workspace and the rule it broke, then exits 1.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { valid } from "semver";
import { createScanner } from "typescript/unstable/ast/scanner";

import {
  expandGlobs,
  readWorkspaceGlobs,
  YAML_COMMENT,
  YAML_LIST_ITEM,
  YAML_QUOTES,
} from "./workspaces.mjs";

/** ADR 0010: explicit globs only, so `prototypes/**` stays outside the workspace. */
const WORKSPACE_GLOBS = ["packages/*", "apps/*"];

/**
 * Tooling every workspace needs to expose its thin `build` and `typecheck` and
 * to run its own tests, and may therefore declare in `devDependencies` without
 * the matrix naming it.
 *
 * The declaration exemption is not an import exemption: shipped source that
 * imports one of these is shipping a compiler or a test runner in a published
 * package. Only an unshipped file may import one, because
 * `tsconfig.build.json` keeps those out of `dist` and the packed artifact
 * therefore never carries the edge.
 */
const SHARED_DEV_DEPENDENCIES = new Set([
  "@types/node",
  "typescript",
  "vitest",
]);

/**
 * What never reaches `dist`: a test, and the support module a test imports.
 *
 * This pattern and every `tsconfig.build.json`'s `exclude` encode the same
 * decision from two directions - this one grants the import exemption, that one
 * makes the exemption true - so they have to name the same files. They did not:
 * a `*.test-support.ts` was excluded from `dist` and not matched here, which
 * left the file that knows the address of a local Docker stack unshipped in
 * fact and shipped as far as this rule could tell.
 *
 * A workspace's own `vitest.config.ts` is the third shape: it configures the
 * test runner, imports from it, and is kept out of `dist` by every
 * `tsconfig.build.json` that lists `src` alone.
 */
const UNSHIPPED_FILE =
  /(?:\.test(?:-support)?\.[cm]?tsx?|(?:^|[\\/])vitest\.config\.[cm]?ts)$/u;

/**
 * The Node declaration each role makes, and they are deliberately different
 * shapes rather than one string used twice.
 *
 * A published package declares a **floor**, because the statement it is making
 * is to a consumer: this works on 24 and anything later. A range is the only
 * honest spelling of that.
 *
 * An app declares the **major it was tested on**, because an app is a
 * deployment rather than a dependency, and a lower bound hands the choice of
 * major to the platform. Vercel resolves a range to the newest version it
 * offers that satisfies it, so `>=24` would silently move the deployment to 26
 * the day 26 becomes available there - while CI and `@types/node` stayed on 24,
 * which is exactly the production-versus-tested gap the pin exists to close.
 */
const PUBLISHED_NODE_RANGE = ">=24";
const APP_NODE_RANGE = "24.x";

const DEFAULT_EXPORT = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
};

/** What a published package ships when it ships only its build output. */
const DEFAULT_FILES = ["dist"];

/**
 * ADR 0010's dependency table as amended by ADR 0014, with the concrete package
 * names the ADR's prose implies spelled out: `react-dom` beside `react` and the
 * `@types/react*` typings for the Next.js shell, and the Postgres drivers (`pg`,
 * `postgres`, `@neondatabase/serverless`) the ADR keeps on the control-plane
 * package rather than in the app. Anything else here is the table's own wording.
 *
 * - `internal`  - the `@reprove/*` edges the matrix permits ("May depend on").
 * - `external`  - the non-Reprove packages the matrix permits. A dependency the
 *   matrix does not name is rejected even if it looks harmless; admitting one is
 *   an edit here.
 * - `testExternal` - the non-Reprove packages only the workspace's own tests
 *   may reach: permitted in `devDependencies` alone, and importable from an
 *   unshipped file alone, so a shipped file cannot carry the edge into a
 *   published package.
 * - `forbidden` - the matrix's "Must not depend on" column, kept so a violation
 *   can say *forbidden* rather than merely *unlisted*. A pattern may end in `/*`
 *   to cover a scope.
 * - `files`     - what the package ships, when it ships more than `dist`. A
 *   runtime asset is a publication decision, so it is named here rather than
 *   left to whichever manifest happens to list it.
 */
const WORKSPACES = {
  "packages/protocol": {
    name: "@reprove/protocol",
    published: true,
    // Version families are subpath exports, not a growing union. No "." export.
    exports: {
      "./v1": { types: "./dist/v1/index.d.ts", default: "./dist/v1/index.js" },
    },
    internal: [],
    external: ["zod"],
    forbidden: [
      "@reprove/*",
      "@ai-sdk/*",
      "workflow",
      "drizzle-orm",
      "octokit",
      "better-auth",
    ],
  },
  "packages/adapters": {
    name: "@reprove/adapters",
    published: true,
    exports: DEFAULT_EXPORT,
    internal: [],
    external: [
      "@ai-sdk/harness",
      "@ai-sdk/harness-codex",
      "@ai-sdk/harness-claude-code",
      "@ai-sdk/harness-opencode",
      "zod",
    ],
    forbidden: [
      "@reprove/*",
      "workflow",
      "drizzle-orm",
      "octokit",
      "better-auth",
    ],
  },
  "packages/sandbox-container": {
    name: "@reprove/sandbox-container",
    published: true,
    exports: DEFAULT_EXPORT,
    internal: [],
    // `@ai-sdk/harness` core only, never the per-Harness bridges. A container
    // runtime library is permitted by the ADR but must be named here first.
    external: ["@ai-sdk/harness", "zod"],
    forbidden: [
      "@reprove/*",
      "@ai-sdk/harness-codex",
      "@ai-sdk/harness-claude-code",
      "@ai-sdk/harness-opencode",
      "workflow",
      "drizzle-orm",
      "octokit",
      "better-auth",
    ],
  },
  "packages/worker-core": {
    name: "@reprove/worker-core",
    published: true,
    exports: DEFAULT_EXPORT,
    internal: [
      "@reprove/protocol",
      "@reprove/adapters",
      "@reprove/sandbox-container",
    ],
    external: [],
    forbidden: ["workflow", "drizzle-orm", "octokit", "better-auth"],
  },
  "packages/worker": {
    name: "@reprove/worker",
    published: true,
    exports: DEFAULT_EXPORT,
    bin: { reprove: "./dist/bin.js" },
    internal: ["@reprove/worker-core", "@reprove/protocol"],
    external: [],
    forbidden: [
      "@ai-sdk/*",
      "workflow",
      "drizzle-orm",
      "octokit",
      "better-auth",
    ],
  },
  "packages/worker-hosted": {
    name: "@reprove/worker-hosted",
    published: true,
    exports: DEFAULT_EXPORT,
    internal: ["@reprove/worker-core", "@reprove/protocol"],
    external: ["workflow"],
    forbidden: ["@ai-sdk/*", "drizzle-orm", "octokit", "better-auth"],
  },
  "packages/control-plane": {
    name: "@reprove/control-plane",
    published: true,
    exports: DEFAULT_EXPORT,
    bin: { "reprove-control-plane": "./dist/bin.js" },
    // ADR 0017 makes the Drizzle migration folder a runtime asset of this
    // package: the boot assertion joins the applied migration hashes against
    // the committed files, so the files have to be in the tarball.
    files: ["dist", "drizzle"],
    internal: ["@reprove/protocol"],
    external: [
      "drizzle-orm",
      "octokit",
      "better-auth",
      // ADR 0010 keeps the Postgres drivers on this package rather than in the
      // app. `drizzle-kit` generates the migrations the package then ships.
      "pg",
      "@types/pg",
      "drizzle-kit",
      // ADR 0007 puts the zod-and-Drizzle boundary here: zod is what enforces a
      // Run spec's immutability and what parses the least trusted input the
      // system takes - a webhook body - at the seam it arrives on.
      "zod",
    ],
    // ADR 0014 removed `workflow` from this row.
    forbidden: [
      "@reprove/worker-core",
      "@reprove/adapters",
      "@reprove/sandbox-container",
      "@ai-sdk/*",
      "workflow",
    ],
  },
  "packages/control-plane-workflow": {
    name: "@reprove/control-plane-workflow",
    published: true,
    // Two subpaths, because the optional peer below is a *type* edge as well as
    // a module one. The hosted half declares its types over `worker-hosted`, so
    // its declarations name a specifier a self-hosted install does not have -
    // and a consumer type-checking the package it did install would fail on it
    // before `hostedPlacement()` could answer `null`. The default subpath is
    // what ADR 0010's self-hosted row installs and resolves with
    // `control-plane` and `workflow` alone; `./hosted` is what the deployment
    // that also installs the driver reaches for.
    exports: {
      ...DEFAULT_EXPORT,
      "./hosted": { types: "./dist/hosted.d.ts", default: "./dist/hosted.js" },
    },
    internal: ["@reprove/protocol", "@reprove/control-plane"],
    // ADR 0010's deployment table as an edge. A hosted deployment composes
    // `worker-hosted` and a self-hosted one omits it, so the package this one
    // reaches it through must run either way: the import is lazy and its
    // absence composes no hosted dispatch.
    //
    // An **optional peer** is the only field that says that in a manifest a
    // consumer installs from. pnpm installs `optionalDependencies` by default -
    // only `--omit=optional` skips them - so declaring it there would install
    // the harness stack into every deployment. `autoInstallPeers` (on by
    // default) installs missing *non-optional* peers only, so a peer marked
    // optional in `peerDependenciesMeta` arrives exactly when the deployment
    // that composes this package names it, and never otherwise. That is the
    // property ADR 0010 exists to keep - "a control plane that dispatches only
    // to self-hosted Workers installs no harness code at all".
    //
    // The same edge is a devDependency here as well, which a consumer never
    // installs: this package type-checks against the driver and its own tests
    // import it.
    optionalInternal: ["@reprove/worker-hosted"],
    external: ["workflow"],
    // `@workflow/vitest` is the builder the package's own tests run its
    // workflows under. It is named here rather than in `external` because that
    // row is package-wide: a shipped `src` file could import it and still pass,
    // and a consumer of the published package would then fail to resolve a
    // devDependency. `testExternal` is the narrower grant the edge actually
    // needs - `devDependencies` only, and importable from an unshipped file
    // only - because the shared-tooling exemption covers the test runner alone.
    testExternal: ["@workflow/vitest"],
    forbidden: [
      "@reprove/worker-core",
      "@reprove/adapters",
      "@reprove/sandbox-container",
      "@ai-sdk/*",
    ],
  },
  "apps/control-plane": {
    name: "@reprove/control-plane-app",
    published: false,
    // This app is the **hosted** composition root, so it names the hosted
    // driver: `control-plane-workflow` carries that edge as an optional peer,
    // which pnpm does not auto-install, so a deployment that wants hosted
    // dispatch is the thing that has to declare it. A self-hosted composition
    // root declares neither the driver nor anything that requires it, and
    // installs no harness code at all. `harness-reach` below holds both ends of
    // that to more than a convention.
    internal: [
      "@reprove/control-plane",
      "@reprove/control-plane-workflow",
      "@reprove/worker-hosted",
    ],
    external: [
      "next",
      "react",
      "react-dom",
      "@types/react",
      "@types/react-dom",
      // ADR 0014: the app composes the orchestration seam, which means the
      // `withWorkflow` build integration in `next.config.ts` and the World the
      // deployment runs on. Which World is deployment configuration, so the
      // Postgres one is the app's edge rather than the package's.
      "workflow",
      "@workflow/world-postgres",
    ],
    forbidden: [
      "@reprove/adapters",
      "@reprove/worker-core",
      "@reprove/sandbox-container",
      "@ai-sdk/*",
      "drizzle-orm",
      "octokit",
      "better-auth",
      "pg",
      "postgres",
      "@neondatabase/serverless",
    ],
  },
  "apps/docs": {
    name: "@reprove/docs-app",
    published: false,
    internal: [],
    external: [],
    forbidden: [
      "@reprove/*",
      "@ai-sdk/*",
      "workflow",
      "drizzle-orm",
      "octokit",
      "better-auth",
    ],
  },
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Extensions the import walk reads. JavaScript belongs here alongside
 * TypeScript: `allowJs` is on for the Next.js app, and any workspace may ship a
 * `.mjs` or `.cjs` file, so a boundary crossing hides in one exactly as it does
 * in a `.ts` file. TypeScript 7 exposes its lexical scanner from the unstable
 * AST entrypoint; it reports the specifiers in these files without needing them
 * to type-check.
 */
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

/**
 * Directories the import walk never descends into: installed dependencies and
 * build output. Everything else a workspace owns is in scope, because a config
 * file such as `next.config.ts` crosses a package boundary exactly as a file
 * under `src/` does.
 */
const UNSCANNED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  // Generated by the Workflow test builder: the bundles `@workflow/vitest`
  // emits, which import the SDK's own internals and are no boundary anybody
  // authored. Both are skipped by name like `dist` above, because nothing a
  // person writes is called either.
  ".workflow-vitest",
  ".workflow-data",
]);

/**
 * The generated route tree, which is skipped by **path** rather than by name.
 *
 * `withWorkflow` writes its routes into `src/app/.well-known/workflow`, and
 * that subtree is build output. `.well-known` itself is not: a Next app may
 * legitimately hold a route there - a `security.txt`, say - and skipping the
 * whole directory by name would hide a forbidden import in one.
 *
 * @param {string} parent The directory being walked.
 * @param {string} name The child directory's name.
 * @returns {boolean} Whether the child is the generated route tree.
 */
const isGeneratedWorkflowRoutes = (parent, name) =>
  name === "workflow" && path.basename(parent) === ".well-known";

const NODE_BUILTINS = new Set(builtinModules);

const CHAINED_SCRIPT = /&&|\|\||;/u;
const TRUST_POLICY_EXCLUDE_KEY = /^trustPolicyExclude:\s*$/u;
const REVIEW_BY_COMMENT = /^#\s*review-by:\s*(?<date>\d{4}-\d{2}-\d{2})\s*$/u;

// --- helpers -----------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));

const normalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  // JSON has no third composite: whatever survives the array branch is either a
  // plain object or a primitive, and `instanceof` separates the two without
  // probing the representation of a value this walker never decoded.
  if (value instanceof Object) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, normalize(value[key])])
    );
  }
  return value;
};

const deepEqual = (a, b) =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

const matchesPattern = (name, pattern) =>
  pattern.endsWith("/*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern;

/**
 * Says whether the matrix names the dependency in a "Must not depend on" column
 * or simply never permits it, so the message can be specific.
 *
 * @param {object} spec The workspace's row in the matrix.
 * @param {string} dependency The offending dependency name.
 * @returns {string} A clause naming how the matrix treats the dependency.
 */
const describeDenial = (spec, dependency) =>
  spec.forbidden.some((pattern) => matchesPattern(dependency, pattern))
    ? `explicitly forbids for "${spec.name}"`
    : `does not permit for "${spec.name}"`;

const packageNameOf = (specifier) => {
  if (specifier.startsWith("@")) {
    const segments = specifier.split("/");
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
  }
  return specifier.split("/")[0];
};

const subpathOf = (specifier, packageName) => {
  const rest = specifier.slice(packageName.length);
  return rest === "" ? "." : `.${rest}`;
};

const listSourceFiles = (dir) => {
  if (!existsSync(dir)) {
    return [];
  }
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        !(
          UNSCANNED_DIRECTORIES.has(entry.name) ||
          isGeneratedWorkflowRoutes(dir, entry.name)
        )
      ) {
        found.push(...listSourceFiles(full));
      }
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
};

const isStringLiteral = (token) =>
  token?.text.startsWith('"') || token?.text.startsWith("'");

const isPropertyAccess = (tokens, index) =>
  tokens[index - 1]?.text === "." || tokens[index - 1]?.text === "?.";

const DEPTH_DELTAS = new Map([
  ["{", [0, 1]],
  ["}", [0, -1]],
  ["(", [1, 1]],
  [")", [1, -1]],
  ["[", [2, 1]],
  ["]", [2, -1]],
]);

/**
 * Finds the module specifier after `from` in an import or export declaration.
 * Bracket depth keeps an imported binding named `from` from being mistaken for
 * the declaration's module clause.
 */
const findFromSpecifier = (tokens, start) => {
  const depths = [0, 0, 0];
  const isTopLevel = () => depths.every((depth) => depth === 0);

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.text === ";" && isTopLevel()) {
      return null;
    }

    if (["import", "export"].includes(token.text) && isTopLevel()) {
      return null;
    }

    const depthDelta = DEPTH_DELTAS.get(token.text);
    if (depthDelta) {
      const [dimension, delta] = depthDelta;
      depths[dimension] = Math.max(0, depths[dimension] + delta);
      continue;
    }

    if (
      token.text === "from" &&
      isTopLevel() &&
      isStringLiteral(tokens[index + 1])
    ) {
      return tokens[index + 1];
    }
  }

  return null;
};

/**
 * TypeScript 7 no longer exposes `preProcessFile` from its root module. The
 * unstable scanner is the replacement lexical primitive, and keeping the
 * small declaration recognizer here means the boundary check does not need a
 * full parser or type-checking pass.
 */
const importedSpecifiers = (source) => {
  const scanner = createScanner(true);
  scanner.setText(source);
  const tokens = [];

  while (true) {
    scanner.scan();
    const text = scanner.getTokenText();
    if (text === "") {
      break;
    }
    tokens.push({ text, value: scanner.getTokenValue() });
  }

  const imported = [];
  const add = (token) => {
    if (isStringLiteral(token)) {
      imported.push({ fileName: token.value });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isPropertyAccess(tokens, index)) {
      continue;
    }

    if (token.text === "import") {
      if (tokens[index + 1]?.text === "(") {
        add(tokens[index + 2]);
      } else if (isStringLiteral(tokens[index + 1])) {
        add(tokens[index + 1]);
      } else {
        add(findFromSpecifier(tokens, index + 1));
      }
      continue;
    }

    if (token.text === "export") {
      let declarationStart = index + 1;
      if (tokens[declarationStart]?.text === "type") {
        declarationStart += 1;
      }
      if (
        tokens[declarationStart]?.text === "{" ||
        tokens[declarationStart]?.text === "*"
      ) {
        add(findFromSpecifier(tokens, declarationStart + 1));
      }
      continue;
    }

    if (
      token.text === "require" &&
      tokens[index + 1]?.text === "(" &&
      isStringLiteral(tokens[index + 2])
    ) {
      add(tokens[index + 2]);
    }
  }

  return imported;
};

/**
 * Every non-Reprove package the matrix hands to some workspace, as match
 * patterns. Deriving it from the table above is the point: a second hand-kept
 * list would be exactly the drift this file exists to prevent.
 *
 * @returns {string[]} Patterns in `matchesPattern` form, `dir/*` included.
 */
const productDependencyPatterns = () => [
  ...new Set(
    Object.values(WORKSPACES).flatMap((spec) => [
      ...spec.external,
      // A "Must not depend on" entry names a real product dependency too: it is
      // forbidden *here* because it belongs somewhere else in the graph.
      ...spec.forbidden.filter((pattern) => !pattern.startsWith("@reprove/")),
    ])
  ),
];

/**
 * The `@reprove/*` edges a workspace may name at all: the required ones and the
 * optional ones together.
 *
 * @param {object} spec The workspace's row in the matrix.
 * @returns {string[]} Every permitted internal dependency.
 */
const permittedInternal = (spec) => [
  ...spec.internal,
  ...(spec.optionalInternal ?? []),
];

/**
 * ADR 0010's load-bearing claim about the graph, as a reachability check:
 * *"a control plane that dispatches only to self-hosted Workers installs no
 * harness code at all"*, and *"'the control plane never touches harness
 * credentials' becomes something an operator can verify with `pnpm why`"*.
 *
 * The row-by-row matrix above cannot state it, because it reads one manifest at
 * a time: `control-plane` naming no harness package says nothing about what
 * `control-plane-workflow` might name on its behalf. This reads the whole
 * `@reprove/*` graph instead and asserts two things about it:
 *
 * ```text
 * @reprove/control-plane        cannot reach worker-core at all
 * apps/control-plane            declares worker-hosted, and reaches worker-core
 *                               only through it
 * ```
 *
 * The second is the one that makes the optional edge worth anything, and it has
 * two halves. Deleting `worker-hosted` from the graph is exactly what a
 * self-hosted deployment does to the install, so removing the node and
 * re-running the search is the same question `pnpm why` answers, asked at
 * review time. And the hosted composition root has to *name* the driver, or the
 * optional peer above is nothing but an unmet expectation: pnpm auto-installs
 * only non-optional peers, so a hosted deployment whose app declares nothing
 * installs no driver and composes no hosted dispatch - a pruned install
 * answering `not_composed` where the operator asked for hosted execution.
 *
 * **What it does not prove.** It is a statement about the *package graph*, not
 * about the route bundles of the app in this repository - which is the hosted
 * topology, and does reach the harness stack, because that is what a hosted
 * deployment is for. The workflow bundle is held to the stronger property
 * separately, by `tools/verify-workflow-build.mjs`.
 */
const HARNESS_REACH = {
  harness: "@reprove/worker-core",
  only: "@reprove/worker-hosted",
  from: "apps/control-plane",
  sealed: "packages/control-plane",
};

/**
 * Every `@reprove/*` edge each workspace declares, by package name.
 *
 * @param {string} rootDir The repository root.
 * @param {readonly string[]} workspaces The settled workspaces to read.
 * @returns {Map<string, Set<string>>} The graph, keyed by package name.
 */
const internalGraph = (rootDir, workspaces) => {
  const graph = new Map();
  for (const workspace of workspaces) {
    const spec = WORKSPACES[workspace];
    let manifest;
    try {
      manifest = readJson(path.join(rootDir, workspace, "package.json"));
    } catch {
      // Unreadable manifests are reported by `checkWorkspaceSet`; this rule
      // reports reachability and has nothing to add about a missing file.
      continue;
    }
    graph.set(
      spec.name,
      new Set(
        DEPENDENCY_FIELDS.flatMap((field) =>
          Object.keys(manifest[field] ?? {})
        ).filter((dependency) => dependency.startsWith("@reprove/"))
      )
    );
  }
  return graph;
};

/**
 * Whether `to` is reachable from `from`, with `without` deleted from the graph.
 *
 * @param {Map<string, Set<string>>} graph The dependency graph.
 * @param {string} from The package to search from.
 * @param {string} to The package to search for.
 * @param {string | null} without A package to remove first, or `null`.
 * @returns {string[] | null} One path, or `null` where there is none.
 */
const pathBetween = (graph, from, to, without) => {
  /** @type {[string, string[]][]} */
  const frontier = [[from, [from]]];
  const seen = new Set(without === null ? [] : [without]);
  while (frontier.length > 0) {
    const step = frontier.shift();
    if (!step) {
      break;
    }
    const [at, trail] = step;
    if (at === to) {
      return trail;
    }
    for (const next of graph.get(at) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        frontier.push([next, [...trail, next]]);
      }
    }
  }
  return null;
};

const checkHarnessReach = (rootDir, workspaces, violations) => {
  const graph = internalGraph(rootDir, workspaces);
  const add = (workspace, message) =>
    violations.push({ workspace, rule: "harness-reach", message });

  const sealed = WORKSPACES[HARNESS_REACH.sealed]?.name;
  const app = WORKSPACES[HARNESS_REACH.from]?.name;
  if (!(sealed && app)) {
    add(
      "<root>",
      "the harness-reach rule names a workspace that is not settled."
    );
    return;
  }

  const fromControlPlane = pathBetween(
    graph,
    sealed,
    HARNESS_REACH.harness,
    null
  );
  if (fromControlPlane) {
    add(
      HARNESS_REACH.sealed,
      `"${sealed}" reaches ${HARNESS_REACH.harness} through ${fromControlPlane.join(" -> ")}. ADR 0010: a control plane that dispatches only to self-hosted Workers installs no harness code at all.`
    );
  }

  if (!graph.get(app)?.has(HARNESS_REACH.only)) {
    add(
      HARNESS_REACH.from,
      `"${app}" declares no edge to ${HARNESS_REACH.only}, and it is the hosted composition root. "${WORKSPACES["packages/control-plane-workflow"].name}" carries that edge as an *optional* peer, which pnpm does not auto-install, so the deployment that wants hosted dispatch is what names the driver. Undeclared, this app installs none and every dispatch answers not_composed.`
    );
  }

  const detour = pathBetween(
    graph,
    app,
    HARNESS_REACH.harness,
    HARNESS_REACH.only
  );
  if (detour) {
    add(
      HARNESS_REACH.from,
      `"${app}" reaches ${HARNESS_REACH.harness} through ${detour.join(" -> ")}, which does not pass through ${HARNESS_REACH.only}. The hosted driver is the only edge the harness stack may arrive on, or the self-hosted deployment cannot omit it.`
    );
  }
};

// --- rules -------------------------------------------------------------------

const checkGlobs = (globs, violations) => {
  const add = (message) =>
    violations.push({ workspace: "<root>", rule: "workspace-globs", message });

  for (const glob of globs) {
    if (!WORKSPACE_GLOBS.includes(glob)) {
      add(
        `workspace glob "${glob}" is not one of the settled globs ${WORKSPACE_GLOBS.join(", ")}. ADR 0010 keeps prototypes/** outside the workspace.`
      );
    }
  }
  for (const glob of WORKSPACE_GLOBS) {
    if (!globs.includes(glob)) {
      add(`workspace glob "${glob}" is missing from pnpm-workspace.yaml.`);
    }
  }
};

const checkWorkspaceSet = (rootDir, violations) => {
  const globs = readWorkspaceGlobs(rootDir);
  if (globs === null) {
    violations.push({
      workspace: "<root>",
      rule: "workspace-globs",
      message: "pnpm-workspace.yaml is missing.",
    });
    return [];
  }

  checkGlobs(globs, violations);

  const discovered = expandGlobs(rootDir, globs);
  const settled = Object.keys(WORKSPACES);

  for (const workspace of settled) {
    if (!discovered.includes(workspace)) {
      violations.push({
        workspace,
        rule: "workspace-set",
        message: `settled workspace "${workspace}" (${WORKSPACES[workspace].name}) is missing. ADR 0010 as amended by ADR 0014 settles exactly ${settled.length} workspaces.`,
      });
    }
  }
  for (const workspace of discovered) {
    if (!settled.includes(workspace)) {
      violations.push({
        workspace,
        rule: "workspace-set",
        message: `"${workspace}" is not one of the ${settled.length} settled workspaces. Adding a package is an ADR 0010 amendment, not a directory.`,
      });
    }
  }

  return discovered.filter((workspace) => settled.includes(workspace));
};

/**
 * The root manifest is tooling only. It ships nothing, so it declares no
 * `dependencies`, and it must not hold a package the matrix assigns to a
 * workspace: a product dependency at the root is installed for every workspace
 * and hoisted into reach of all of them, which is the boundary the matrix
 * draws. `@reprove/*` at `workspace:*` stays permitted, because the root smoke
 * test in tests/ is the intended consumer of every published export.
 *
 * @param {string} rootDir The repository root to read `package.json` from.
 * @param {{ workspace: string, rule: string, message: string }[]} violations The
 *   running list this rule appends to.
 */
const checkRootManifest = (rootDir, violations) => {
  const add = (message) =>
    violations.push({
      workspace: "<root>",
      rule: "root-dependencies",
      message,
    });

  let manifest;
  try {
    manifest = readJson(path.join(rootDir, "package.json"));
  } catch (error) {
    add(`the root package.json could not be read: ${String(error)}`);
    return;
  }

  if (manifest.dependencies) {
    add(
      'the root package.json declares "dependencies". The root publishes nothing, so its manifest carries devDependencies only.'
    );
  }

  const patterns = productDependencyPatterns();
  for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
    if (patterns.some((pattern) => matchesPattern(dependency, pattern))) {
      add(
        `the root package.json declares "${dependency}", which the ADR 0010 matrix assigns to a workspace. A product dependency is declared by the workspace that owns it, never at the root.`
      );
    }
  }
};

/**
 * Every `trustPolicyExclude` entry carries an expiry. Issue #30 settled that a
 * supply-chain exception names its reason and a review-by date, and that an
 * expired one fails the gate rather than lingering as a silent allowlist; the
 * date is the last comment line above the entry it excuses.
 *
 * @param {string} rootDir The repository root to read `pnpm-workspace.yaml` from.
 * @param {{ workspace: string, rule: string, message: string }[]} violations The
 *   running list this rule appends to.
 */
const checkSupplyChainExceptions = (rootDir, violations) => {
  const file = path.join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    return;
  }
  const add = (message) =>
    violations.push({
      workspace: "<root>",
      rule: "supply-chain-exception",
      message,
    });

  const today = new Date().toISOString().slice(0, 10);
  let inExclude = false;
  let reviewBy = null;

  for (const rawLine of readFileSync(file, "utf-8").split("\n")) {
    // Two views of the same line. Structure is read with the comment stripped,
    // the way readWorkspaceGlobs reads `packages:`, so `trustPolicyExclude: #
    // note` still opens the block instead of silently skipping every exception
    // under it. The review-by date is read from the raw line, which is the only
    // view that still carries the comment.
    const line = rawLine.replace(YAML_COMMENT, "").trimEnd();
    const raw = rawLine.trim();
    if (TRUST_POLICY_EXCLUDE_KEY.test(line)) {
      inExclude = true;
      reviewBy = null;
      continue;
    }
    if (!inExclude) {
      continue;
    }
    if (raw.startsWith("#")) {
      // Only the nearest comment counts, so a date higher up a block cannot be
      // read as covering an entry appended under it later.
      reviewBy = REVIEW_BY_COMMENT.exec(raw)?.groups?.date ?? null;
      continue;
    }

    const item = YAML_LIST_ITEM.exec(line);
    if (item?.groups) {
      const entry = item.groups.item.replaceAll(YAML_QUOTES, "");
      if (reviewBy === null) {
        add(
          `trustPolicyExclude entry "${entry}" carries no "# review-by: YYYY-MM-DD" line immediately above it. An exception without an expiry is a permanent silent allowlist (issue #30).`
        );
      } else if (reviewBy < today) {
        add(
          `trustPolicyExclude entry "${entry}" expired on ${reviewBy}. Re-review it and move the date, or drop the entry.`
        );
      }
      reviewBy = null;
      continue;
    }

    if (line.trim() !== "") {
      inExclude = false;
    }
    reviewBy = null;
  }
};

const checkPublishability = (spec, manifest, add) => {
  if (spec.published) {
    if (manifest.private) {
      add(
        "publishability",
        `"${spec.name}" is publishable but declares "private": true.`
      );
    }
    if (manifest.publishConfig?.access !== "public") {
      add(
        "publishability",
        `"${spec.name}" is publishable and must declare "publishConfig": { "access": "public" }.`
      );
    }
    if (manifest.license !== "Apache-2.0") {
      add(
        "publishability",
        `"${spec.name}" must declare "license": "Apache-2.0".`
      );
    }
    const files = spec.files ?? DEFAULT_FILES;
    if (!deepEqual(manifest.files, files)) {
      add(
        "publishability",
        `"${spec.name}" must declare "files": ${JSON.stringify(files)}.`
      );
    }
    if (manifest.sideEffects !== false) {
      add(
        "publishability",
        `"${spec.name}" must declare "sideEffects": false.`
      );
    }
    if (manifest.engines?.node !== PUBLISHED_NODE_RANGE) {
      add(
        "publishability",
        `"${spec.name}" must declare "engines": { "node": "${PUBLISHED_NODE_RANGE}" }.`
      );
    }
  } else {
    if (manifest.private !== true) {
      add(
        "publishability",
        `"${spec.name}" is an app and must declare "private": true.`
      );
    }
    if (manifest.publishConfig) {
      add(
        "publishability",
        `"${spec.name}" is an app and must not declare "publishConfig".`
      );
    }
    if (manifest.engines?.node !== APP_NODE_RANGE) {
      add(
        "publishability",
        `"${spec.name}" is an app and must declare "engines": { "node": "${APP_NODE_RANGE}" }; a deployment pins the major CI runs rather than declaring a floor the platform may exceed.`
      );
    }
  }

  if (manifest.type !== "module") {
    add(
      "publishability",
      `"${spec.name}" must declare "type": "module"; published output is ESM-only.`
    );
  }
};

const checkSurface = (spec, manifest, add) => {
  if (!deepEqual(manifest.bin, spec.bin)) {
    add(
      "package-bin",
      `"${spec.name}" declares bin ${JSON.stringify(manifest.bin ?? null)} but its settled role is ${spec.bin ? JSON.stringify(spec.bin) : "no bin"}.`
    );
  }
  if (!deepEqual(manifest.exports, spec.exports)) {
    add(
      "package-exports",
      `"${spec.name}" declares exports ${JSON.stringify(manifest.exports ?? null)} but its settled export surface is ${spec.exports ? JSON.stringify(spec.exports) : "no exports"}.`
    );
  }
};

const checkTaskScripts = (spec, manifest, add) => {
  for (const task of ["build", "typecheck"]) {
    // A task pnpm never accepted into the manifest and a task declared blank are
    // the same absence to Turbo, so both read as the empty command here.
    const script = manifest.scripts?.[task] ?? "";
    if (script.trim() === "") {
      add(
        "task-scripts",
        `"${spec.name}" is missing a "${task}" script; Turbo owns that task.`
      );
      continue;
    }
    if (CHAINED_SCRIPT.test(script)) {
      add(
        "task-scripts",
        `"${spec.name}" has a chained "${task}" script (${script}). Package scripts stay thin; sequencing belongs to the root verify seam.`
      );
    }
  }
};

const checkManifest = (workspace, spec, manifest, violations) => {
  const add = (rule, message) => violations.push({ workspace, rule, message });

  if (manifest.name !== spec.name) {
    add(
      "package-name",
      `package is named "${manifest.name}" but its settled role is "${spec.name}".`
    );
  }

  checkPublishability(spec, manifest, add);
  checkSurface(spec, manifest, add);
  checkTaskScripts(spec, manifest, add);
};

/**
 * The fields an optional internal edge may be declared in.
 *
 * `peerDependencies` is where it is *stated*, and `checkOptionalInternal` below
 * requires it there. `devDependencies` is permitted alongside because a
 * consumer installs none of them, and the declaring package still has to
 * resolve the edge to type-check and test against it.
 */
const OPTIONAL_EDGE_FIELDS = new Set(["peerDependencies", "devDependencies"]);

/**
 * That every optional internal edge is declared the one way that delivers it:
 * a peer, marked optional.
 *
 * `checkDeclaredDependencies` reads the manifest field by field, so it can only
 * reject an optional edge found in the wrong place. This asks the other
 * question - whether the edge is declared as an optional peer at all - because
 * an edge that appears nowhere but `devDependencies` is an edge no consumer can
 * ever satisfy, and a peer without `peerDependenciesMeta.optional` is one pnpm
 * auto-installs into every deployment.
 *
 * @param {object} spec The workspace's row in the matrix.
 * @param {object} manifest The workspace's manifest.
 * @param {(rule: string, message: string) => void} add Records a violation.
 */
const checkOptionalInternal = (spec, manifest, add) => {
  for (const dependency of spec.optionalInternal ?? []) {
    if (manifest.peerDependencies?.[dependency] === undefined) {
      add(
        "dependency-optionality",
        `"${spec.name}" carries "${dependency}" as an optional edge in the ADR 0010 matrix, and declares it in no peerDependencies. That is the only field that both states the edge to a consumer and leaves the install to it.`
      );
      continue;
    }
    if (manifest.peerDependenciesMeta?.[dependency]?.optional !== true) {
      add(
        "dependency-optionality",
        `peerDependencies declares "${dependency}" and peerDependenciesMeta does not mark it optional. pnpm's autoInstallPeers installs every missing non-optional peer, so without the mark the edge is installed into the deployment ADR 0010 says omits it.`
      );
    }
  }
};

const checkDeclaredDependencies = (workspace, spec, manifest, violations) => {
  const add = (rule, message) => violations.push({ workspace, rule, message });

  checkOptionalInternal(spec, manifest, add);

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (
        dependency.startsWith("@ai-sdk/harness") &&
        range !== "catalog:harness"
      ) {
        add(
          "harness-pin",
          `${field} declares "${dependency}": "${range}"; the Harness family must use the coordinated exact-pin catalog.`
        );
      }
      if (dependency.startsWith("@reprove/")) {
        const optional = (spec.optionalInternal ?? []).includes(dependency);
        if (spec.internal.includes(dependency) || optional) {
          if (!range.startsWith("workspace:")) {
            add(
              "dependency-protocol",
              `${field} declares "${dependency}": "${range}"; an internal edge must use the workspace protocol.`
            );
          }
          // An optional edge that lands in any field a consumer installs from
          // is installed by every consumer, which is the whole of what the
          // matrix means by optional: ADR 0010's self-hosted deployment omits
          // the package. `optionalDependencies` is not the escape - pnpm
          // installs those by default and only `--omit=optional` skips them -
          // so the field is `peerDependencies` marked optional in
          // `peerDependenciesMeta`, which `autoInstallPeers` leaves alone.
          // `devDependencies` is permitted beside it, because a consumer
          // installs none of those and the package still has to type-check and
          // test against the edge.
          if (optional && !OPTIONAL_EDGE_FIELDS.has(field)) {
            add(
              "dependency-optionality",
              `${field} declares "${dependency}", which the ADR 0010 matrix carries as an optional edge for "${spec.name}". It belongs in peerDependencies, marked optional in peerDependenciesMeta: every other field is installed by every consumer of this package - pnpm installs optionalDependencies unless the install passes --omit=optional - which puts it into the deployment the matrix says omits it.`
            );
          }
          if (!optional && field === "optionalDependencies") {
            add(
              "dependency-optionality",
              `optionalDependencies declares "${dependency}", which the ADR 0010 matrix carries as a required edge for "${spec.name}". An edge the package cannot run without must not be installable away.`
            );
          }
        } else {
          add(
            "dependency-allowlist",
            `${field} declares "${dependency}", which the ADR 0010 matrix ${describeDenial(spec, dependency)}.`
          );
        }
        continue;
      }

      // A test-only edge is a devDependency and nothing else: declared in
      // `dependencies` it would be installed by every consumer of the published
      // package, which is the opposite of what the narrower grant means.
      const devOnly =
        field === "devDependencies" &&
        (SHARED_DEV_DEPENDENCIES.has(dependency) ||
          (spec.testExternal ?? []).includes(dependency));
      if (!(devOnly || spec.external.includes(dependency))) {
        add(
          "dependency-allowlist",
          `${field} declares "${dependency}", which the ADR 0010 matrix ${describeDenial(spec, dependency)}.`
        );
      }
    }
  }
};

const checkInternalImport = (context, specifier, target, subpath) => {
  const { spec, declared, relative, add } = context;

  if (target === spec.name) {
    add(
      `${relative} imports its own package by name ("${specifier}"); use a relative path.`
    );
    return;
  }
  // An optional edge is importable exactly like a required one. What differs
  // is the manifest field it is declared in, which `checkDeclaredDependencies`
  // holds it to, and that the importer must survive its absence - a property of
  // the code rather than of the specifier, so it is the importing package's
  // tests that state it.
  if (!permittedInternal(spec).includes(target)) {
    add(
      `${relative} imports "${specifier}", and the ADR 0010 matrix ${describeDenial(spec, target)}.`
    );
    return;
  }
  if (!declared.has(target)) {
    add(
      `${relative} imports "${specifier}", which is not declared in package.json.`
    );
    return;
  }
  const targetSpec = Object.values(WORKSPACES).find(
    (entry) => entry.name === target
  );
  const exported = Object.keys(targetSpec?.exports ?? {});
  if (!exported.includes(subpath)) {
    add(
      `${relative} imports "${specifier}", which bypasses "${target}"'s export surface (${exported.join(", ") || "none"}).`
    );
  }
};

const checkExternalImport = (context, specifier, target) => {
  const { spec, declared, relative, isUnshipped, add } = context;

  // An unshipped file is not packed, so the test runner is reachable from one
  // and from nowhere else. It still has to be declared, so the edge is visible
  // in the manifest rather than resolved out of whatever the root hoisted.
  // A test-only edge is the same exemption with the matrix naming the package
  // rather than the shared list: reachable from an unshipped file, and from a
  // shipped one a violation like any other, because the published package
  // declares it nowhere a consumer installs.
  const testOnly = (spec.testExternal ?? []).includes(target);
  if (isUnshipped && (SHARED_DEV_DEPENDENCIES.has(target) || testOnly)) {
    if (!declared.has(target)) {
      add(
        `${relative} imports "${specifier}", which is not declared in package.json.`
      );
    }
    return;
  }

  if (testOnly) {
    add(
      `${relative} imports "${specifier}", which the ADR 0010 matrix permits only in this workspace's own tests; a shipped file may not carry it.`
    );
    return;
  }

  if (!spec.external.includes(target)) {
    add(
      `${relative} imports "${specifier}", and the ADR 0010 matrix ${describeDenial(spec, target)}.`
    );
    return;
  }
  if (!declared.has(target)) {
    add(
      `${relative} imports "${specifier}", which is not declared in package.json.`
    );
  }
};

const checkImports = (rootDir, workspace, spec, manifest, violations) => {
  const workspaceDir = path.join(rootDir, workspace);
  const declared = new Set(
    DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}))
  );

  for (const file of listSourceFiles(workspaceDir)) {
    const relative = path.relative(rootDir, file);
    const add = (message) =>
      violations.push({ workspace, rule: "import-boundary", message });
    const context = {
      spec,
      declared,
      relative,
      isUnshipped: UNSHIPPED_FILE.test(file),
      add,
    };
    const preprocessed = importedSpecifiers(readFileSync(file, "utf-8"));

    for (const { fileName: specifier } of preprocessed) {
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (path.relative(workspaceDir, resolved).startsWith("..")) {
          add(
            `${relative} imports "${specifier}", which escapes the workspace. Cross-package access goes through a package export.`
          );
        }
        continue;
      }

      const target = packageNameOf(specifier);
      if (specifier.startsWith("node:") || NODE_BUILTINS.has(target)) {
        continue;
      }

      if (target.startsWith("@reprove/")) {
        checkInternalImport(
          context,
          specifier,
          target,
          subpathOf(specifier, target)
        );
      } else {
        checkExternalImport(context, specifier, target);
      }
    }
  }
};

// --- entry point -------------------------------------------------------------

/**
 * Checks the repository against ADR 0010's matrix.
 *
 * @param {{ rootDir: string }} options The repository root to verify.
 * @returns {{ workspace: string, rule: string, message: string }[]} Every
 *   violation found, empty when the workspace contract holds.
 */
export const verifyWorkspace = ({ rootDir }) => {
  const violations = [];

  // This deliberately accepts only a literal, quoted coordinated catalog. A
  // missing, renamed or syntactically indirect set must fail, not skip the gate.
  const config = readFileSync(
    path.join(rootDir, "pnpm-workspace.yaml"),
    "utf-8"
  );
  const catalogs = [
    ...config.matchAll(/^ {2}harness:\n(?<entries>(?:    [^\n]*\n)+)/gmu),
  ];
  const pins = new Map();
  for (const line of catalogs[0]?.groups.entries.trimEnd().split("\n") ?? []) {
    const entry =
      /^ {4}"(?<dependency>@ai-sdk\/harness[^"]*)": (?<version>\S+)$/u.exec(
        line
      );
    if (
      !entry ||
      valid(entry.groups.version) !== entry.groups.version ||
      pins.has(entry.groups.dependency)
    ) {
      violations.push({
        workspace: ".",
        rule: "harness-pin",
        message:
          "Harness catalog entries must be unique quoted package names with literal exact versions.",
      });
    } else {
      pins.set(entry.groups.dependency, entry.groups.version);
    }
  }
  if (
    catalogs.length !== 1 ||
    !pins.has("@ai-sdk/harness") ||
    !pins.has("@ai-sdk/harness-codex")
  ) {
    violations.push({
      workspace: ".",
      rule: "harness-pin",
      message:
        "The coordinated Harness catalog must contain the core and Codex bridge pins.",
    });
  }

  checkRootManifest(rootDir, violations);
  checkSupplyChainExceptions(rootDir, violations);

  const settled = checkWorkspaceSet(rootDir, violations);
  checkHarnessReach(rootDir, settled, violations);

  for (const workspace of settled) {
    const spec = WORKSPACES[workspace];
    let manifest;
    try {
      manifest = readJson(path.join(rootDir, workspace, "package.json"));
    } catch (error) {
      violations.push({
        workspace,
        rule: "workspace-set",
        message: `package.json could not be read: ${String(error)}`,
      });
      continue;
    }

    checkManifest(workspace, spec, manifest, violations);
    checkDeclaredDependencies(workspace, spec, manifest, violations);
    checkImports(rootDir, workspace, spec, manifest, violations);
  }

  return violations;
};

const main = () => {
  const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const violations = verifyWorkspace({ rootDir });

  if (violations.length > 0) {
    for (const { workspace, rule, message } of violations) {
      process.stderr.write(`${workspace}  ${rule}  ${message}\n`);
    }
    process.stderr.write(
      `\n${violations.length} workspace contract violation(s). The matrix lives in tools/verify-workspace.mjs.\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `Workspace contract holds: ${Object.keys(WORKSPACES).length} workspaces match ADR 0010 as amended by ADR 0014.\n`
  );
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
