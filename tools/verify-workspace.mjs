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

import ts from "typescript";

/** ADR 0010: explicit globs only, so `prototypes/**` stays outside the workspace. */
const WORKSPACE_GLOBS = ["packages/*", "apps/*"];

/**
 * Tooling every workspace needs to expose its thin `build` and `typecheck`, and
 * may therefore declare in `devDependencies` without the matrix naming it. It is
 * a declaration exemption only: source that *imports* one of these is shipping a
 * compiler in a published package, so the import check does not consult it.
 */
const SHARED_DEV_DEPENDENCIES = new Set(["@types/node", "typescript"]);

const DEFAULT_EXPORT = {
  ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
};

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
 * - `forbidden` - the matrix's "Must not depend on" column, kept so a violation
 *   can say *forbidden* rather than merely *unlisted*. A pattern may end in `/*`
 *   to cover a scope.
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
    external: ["@ai-sdk/harness"],
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
    internal: ["@reprove/protocol"],
    external: ["drizzle-orm", "octokit", "better-auth"],
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
    exports: DEFAULT_EXPORT,
    internal: ["@reprove/protocol", "@reprove/control-plane"],
    external: ["workflow"],
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

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);

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
]);

const NODE_BUILTINS = new Set(builtinModules);

const CHAINED_SCRIPT = /&&|\|\||;/u;
const PACKAGES_KEY = /^packages:\s*$/u;
const TRUST_POLICY_EXCLUDE_KEY = /^trustPolicyExclude:\s*$/u;
const REVIEW_BY_COMMENT = /^#\s*review-by:\s*(?<date>\d{4}-\d{2}-\d{2})\s*$/u;
const YAML_LIST_ITEM = /^\s+-\s+(?<item>.+?)\s*$/u;
const YAML_QUOTES = /^['"]|['"]$/gu;
const YAML_COMMENT = /#.*$/u;

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
      if (!UNSCANNED_DIRECTORIES.has(entry.name)) {
        found.push(...listSourceFiles(full));
      }
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
};

/**
 * Reads the `packages:` list out of `pnpm-workspace.yaml`. A YAML parser is not
 * worth a runtime dependency for one fixed-shape list; anything this misreads
 * surfaces as a workspace-set violation rather than as silence.
 *
 * @param {string} rootDir The repository root to read from.
 * @returns {string[] | null} The declared globs, or null when the file is absent.
 */
const readWorkspaceGlobs = (rootDir) => {
  const file = path.join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    return null;
  }
  const globs = [];
  let inPackages = false;
  for (const rawLine of readFileSync(file, "utf-8").split("\n")) {
    const line = rawLine.replace(YAML_COMMENT, "").trimEnd();
    if (PACKAGES_KEY.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = YAML_LIST_ITEM.exec(line);
    if (item?.groups) {
      globs.push(item.groups.item.replaceAll(YAML_QUOTES, ""));
      continue;
    }
    if (line.trim() !== "") {
      inPackages = false;
    }
  }
  return globs;
};

/** Expands the settled `dir/*` glob shape. Nothing deeper is supported on purpose. */
const expandGlobs = (rootDir, globs) => {
  const found = [];
  for (const glob of globs) {
    if (!glob.endsWith("/*")) {
      continue;
    }
    const prefix = glob.slice(0, -2);
    const parent = path.join(rootDir, prefix);
    if (!existsSync(parent)) {
      continue;
    }
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const workspace = `${prefix}/${entry.name}`;
      if (
        entry.isDirectory() &&
        existsSync(path.join(rootDir, workspace, "package.json"))
      ) {
        found.push(workspace);
      }
    }
  }
  return found.toSorted();
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
    const line = rawLine.trim();
    if (TRUST_POLICY_EXCLUDE_KEY.test(line)) {
      inExclude = true;
      reviewBy = null;
      continue;
    }
    if (!inExclude) {
      continue;
    }
    if (line.startsWith("#")) {
      // Only the nearest comment counts, so a date higher up a block cannot be
      // read as covering an entry appended under it later.
      reviewBy = REVIEW_BY_COMMENT.exec(line)?.groups?.date ?? null;
      continue;
    }

    const item = YAML_LIST_ITEM.exec(
      rawLine.replace(YAML_COMMENT, "").trimEnd()
    );
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

    if (line !== "") {
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
    if (!deepEqual(manifest.files, ["dist"])) {
      add("publishability", `"${spec.name}" must declare "files": ["dist"].`);
    }
    if (manifest.sideEffects !== false) {
      add(
        "publishability",
        `"${spec.name}" must declare "sideEffects": false.`
      );
    }
    if (manifest.engines?.node !== ">=22") {
      add(
        "publishability",
        `"${spec.name}" must declare "engines": { "node": ">=22" }.`
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

const checkDeclaredDependencies = (workspace, spec, manifest, violations) => {
  const add = (rule, message) => violations.push({ workspace, rule, message });

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (dependency.startsWith("@reprove/")) {
        if (spec.internal.includes(dependency)) {
          if (!range.startsWith("workspace:")) {
            add(
              "dependency-protocol",
              `${field} declares "${dependency}": "${range}"; an internal edge must use the workspace protocol.`
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

      const sharedDev =
        field === "devDependencies" && SHARED_DEV_DEPENDENCIES.has(dependency);
      if (!(sharedDev || spec.external.includes(dependency))) {
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
  if (!spec.internal.includes(target)) {
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
  const { spec, declared, relative, add } = context;

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
    const context = { spec, declared, relative, add };
    const preprocessed = ts.preProcessFile(
      readFileSync(file, "utf-8"),
      true,
      true
    );

    for (const { fileName: specifier } of preprocessed.importedFiles) {
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

  checkRootManifest(rootDir, violations);
  checkSupplyChainExceptions(rootDir, violations);

  for (const workspace of checkWorkspaceSet(rootDir, violations)) {
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
