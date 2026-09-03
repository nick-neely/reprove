#!/usr/bin/env node
/**
 * Proves the artifact a consumer would actually install, before publication
 * exists (ADR 0010, issue #43).
 *
 * Every check here reads the *packed* tarball rather than the source tree,
 * because the defects this step exists to catch - a wrong `files` list, an
 * export map that resolves only inside the workspace, an upstream type leaking
 * through a signature - are invisible from the workspace and appear only once
 * the package has been packed and installed somewhere else.
 *
 * It owns no allowlist. Publishable workspaces are discovered from their own
 * manifests through tools/workspaces.mjs; ADR 0010's table stays in
 * tools/verify-workspace.mjs, which is also what guarantees the `private` flag
 * this step reads agrees with that table.
 *
 * Run as `node tools/verify-packages.mjs`. `--update` rewrites the checked-in
 * API reports instead of failing on their drift; `--keep` leaves the temporary
 * consumer fixture on disk and prints its path.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createScanner } from "typescript/unstable/ast/scanner";

import { publishableWorkspaces } from "./workspaces.mjs";

/** The checked-in API report, one per publishable package, beside its manifest. */
const API_REPORT_FILE = "api-report.md";

/**
 * ADR 0010 settles ESM-only output with no CJS build, so `node10` resolution
 * and `require` from CJS are expected to fail and are not defects. This is the
 * profile that says so, rather than a list of suppressed rules.
 */
const ATTW_PROFILE = "esm-only";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const EXPORT_PATTERN_KEY = "*";
const MANIFEST_EXPORT_KEY = "./package.json";

const CARRIAGE_RETURN = /\r\n/gu;
const SOURCE_MAPPING_URL = /^\/\/# sourceMappingURL=.*\n?/gmu;
const TRAILING_WHITESPACE = /[ \t]+$/gmu;
const SCOPE_PREFIX = /^@[^/]+\//u;
const NON_ALPHANUMERIC = /[^a-zA-Z0-9]+/u;

/**
 * ADR 0005's type boundary, read off the emitted declarations rather than the
 * import graph. An upstream type leaks through an exported signature even when
 * the package never imports `@ai-sdk/harness`, so an import check cannot see it
 * (ADR 0010).
 */
const UPSTREAM_TYPE = /^(?:HarnessV1|Experimental_|experimental_)/u;
const UPSTREAM_PACKAGE = /^@ai-sdk\//u;

const REPORT_HEADER = `<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run \`pnpm verify:packages --update\` to accept an intended API change. -->`;

// --- helpers -----------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));

const byText = (a, b) => (a < b ? -1 : 1);

/**
 * Runs a tool and lets its own output through untouched. The package-contract
 * tools are the ones with something to say when they fail, so nothing here
 * parses or reformats them; only the exit code is read.
 *
 * @returns {boolean} Whether the tool exited zero.
 */
const run = (command, args, options = {}) => {
  try {
    execFileSync(command, args, { stdio: "inherit", ...options });
    return true;
  } catch {
    return false;
  }
};

const localBin = (rootDir, name) =>
  path.join(rootDir, "node_modules", ".bin", name);

/**
 * The version of a dependency as the workspace actually installed it. The
 * consumer fixture pins these exactly so it can install with `--offline`, which
 * is what keeps it inside the supply-chain policy rather than resolving fresh
 * ranges against the registry.
 *
 * @returns {string | null} The installed version, or null when it is absent.
 */
const installedVersion = (fromDir, dependency) => {
  const file = path.join(fromDir, "node_modules", dependency, "package.json");
  return existsSync(file) ? readJson(file).version : null;
};

/** Every `.d.ts` inside a directory, as `{ path, text }` with POSIX paths. */
const listDeclarations = (dir, prefix = "") => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listDeclarations(full, relative));
    } else if (entry.name.endsWith(".d.ts")) {
      found.push({ path: relative, text: readFileSync(full, "utf-8") });
    }
  }
  return found;
};

// --- pure contract functions -------------------------------------------------

/**
 * The specifiers a consumer may import, derived from the packed `exports` map.
 * A package with no `"."` export offers no bare name, which is exactly how
 * `@reprove/protocol` is meant to be reached.
 *
 * @param {{ name: string, exports?: Record<string, unknown> }} manifest A packed manifest.
 * @returns {string[]} One importable specifier per public subpath.
 */
export const exportSubpaths = (manifest) =>
  Object.keys(manifest.exports ?? {})
    .filter(
      (key) => key !== MANIFEST_EXPORT_KEY && !key.includes(EXPORT_PATTERN_KEY)
    )
    .map((key) =>
      key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`
    );

/**
 * A binding name for a subpath, used by the generated consumer. The scope is
 * dropped because every package shares it and it carries no information.
 *
 * @param {string} specifier An importable specifier.
 * @returns {string} A camel-cased identifier.
 */
export const consumerIdentifier = (specifier) =>
  specifier
    .replace(SCOPE_PREFIX, "")
    .split(NON_ALPHANUMERIC)
    .filter((segment) => segment !== "")
    .map((segment, index) =>
      index === 0
        ? segment
        : `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`
    )
    .join("");

/**
 * The whole consumer fixture as text, generated from the packed manifests so no
 * list of packages, subpaths or dependencies is maintained by hand.
 *
 * One fixture holds every package rather than one fixture each. pnpm's isolated
 * `node_modules` layout means an installed package still resolves only what its
 * own manifest declares, so a missing dependency fails here exactly as it would
 * in a consumer that installed that package alone - and `nodeLinker: isolated`
 * is written out rather than assumed, because the guarantee is the point.
 *
 * @param {{
 *   packages: { name: string, tarball: string, manifest: Record<string, unknown> }[],
 *   externals: Record<string, string>,
 *   nodeTypes: string,
 * }} options The packed packages, exact external pins, and the `@types/node`
 *   version the workspace installed.
 * @returns {Record<string, string>} File name to contents.
 */
export const consumerFixture = ({ packages, externals, nodeTypes }) => {
  const ordered = packages.toSorted((a, b) => byText(a.name, b.name));
  const subpaths = ordered.flatMap((entry) => exportSubpaths(entry.manifest));
  const tarballs = Object.fromEntries(
    ordered.map((entry) => [entry.name, `file:${entry.tarball}`])
  );
  const overrides = { ...tarballs, ...externals };

  const manifest = {
    name: "reprove-consumer-fixture",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: tarballs,
    devDependencies: { "@types/node": nodeTypes },
  };

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      moduleDetection: "force",
      types: ["node"],
      strict: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      // The repository base config skips lib checking for build speed. Here the
      // opposite is the point: that the shipped declarations themselves compile
      // for a consumer, not merely that the consumer's own file does.
      skipLibCheck: false,
      noEmit: true,
    },
    include: ["consumer.ts"],
  };

  return {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "pnpm-workspace.yaml": [
      "# Generated by tools/verify-packages.mjs.",
      "# `packages: []` keeps this fixture out of any enclosing workspace, and",
      "# every version is pinned exactly so `pnpm install --offline` resolves it",
      "# from the store the repository install already filled.",
      "packages: []",
      "nodeLinker: isolated",
      "overrides:",
      ...Object.keys(overrides)
        .toSorted(byText)
        .map((key) => `  "${key}": "${overrides[key]}"`),
      "",
    ].join("\n"),
    "consumer.ts": [
      "// Generated by tools/verify-packages.mjs. This is what an outside",
      "// consumer would write: every published subpath, resolved through the",
      "// packed export map rather than through the workspace.",
      ...subpaths.map(
        (specifier) =>
          `import * as ${consumerIdentifier(specifier)} from "${specifier}";`
      ),
      "",
      "export const surface = {",
      ...subpaths.map((specifier) => `  ${consumerIdentifier(specifier)},`),
      "};",
      "",
    ].join("\n"),
    "tsconfig.json": `${JSON.stringify(tsconfig, null, 2)}\n`,
    "smoke.mjs": [
      "// Generated by tools/verify-packages.mjs.",
      "const subpaths = [",
      ...subpaths.map((specifier) => `  "${specifier}",`),
      "];",
      "",
      "for (const subpath of subpaths) {",
      "  const namespace = await import(subpath);",
      "  if (Object.keys(namespace).length === 0) {",
      '    throw new Error(subpath + " imported but exported nothing.");',
      "  }",
      '  process.stdout.write(subpath + " -> " + Object.keys(namespace).join(", ") + "\\n");',
      "}",
      "",
    ].join("\n"),
  };
};

const normalizeDeclaration = (text) =>
  text
    .replaceAll(CARRIAGE_RETURN, "\n")
    .replaceAll(SOURCE_MAPPING_URL, "")
    .replaceAll(TRAILING_WHITESPACE, "")
    .trimEnd();

/**
 * The checked-in API report for one packed package: its emitted declarations
 * verbatim, so a public TypeScript change produces a reviewable diff rather
 * than depending on a reviewer recalling ADR 0005 (ADR 0010).
 *
 * Doc comments stay in. They are part of the surface a consumer reads, and
 * removing them would need a parser to do safely.
 *
 * @param {{ name: string, files: { path: string, text: string }[] }} options The
 *   package name and its declaration files.
 * @returns {string} The report, ready to compare byte for byte.
 */
export const apiReport = ({ name, files }) => {
  const sections = files
    .toSorted((a, b) => byText(a.path, b.path))
    .map(
      (file) =>
        `## ${file.path}\n\n\`\`\`ts\n${normalizeDeclaration(file.text)}\n\`\`\`\n`
    );
  return `${REPORT_HEADER}\n\n# ${name}\n\n${sections.join("\n")}`;
};

/**
 * Upstream implementation types on a package's public declaration surface.
 *
 * The text is tokenized rather than matched with a regex so that a comment
 * naming the rule - the one in `packages/adapters/src/index.ts`, for instance -
 * cannot be read as a violation of it. The scanner skips trivia, so only real
 * identifiers and module specifiers are examined.
 *
 * @param {string} source The text of one emitted `.d.ts`.
 * @returns {string[]} Each offending identifier or specifier, once, in order.
 */
export const forbiddenUpstreamTypes = (source) => {
  const scanner = createScanner(true);
  scanner.setText(source);
  const found = new Set();

  while (true) {
    scanner.scan();
    const text = scanner.getTokenText();
    if (text === "") {
      break;
    }
    if (UPSTREAM_TYPE.test(text)) {
      found.add(text);
      continue;
    }
    const value = scanner.getTokenValue();
    if (
      (text.startsWith('"') || text.startsWith("'")) &&
      UPSTREAM_PACKAGE.test(value)
    ) {
      found.add(value);
    }
  }

  return [...found];
};

// --- steps -------------------------------------------------------------------

/**
 * Packs one workspace and unpacks the tarball, so every later check reads the
 * artifact a consumer would receive rather than the directory it came from.
 */
const packWorkspace = (found, packDir, unpackRoot, violations) => {
  const add = (message) =>
    violations.push({
      workspace: found.workspace,
      rule: "package-pack",
      message,
    });

  let report;
  try {
    const output = execFileSync(
      "pnpm",
      ["pack", "--json", "--pack-destination", packDir],
      {
        cwd: found.dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      }
    );
    report = JSON.parse(output);
  } catch (error) {
    add(`\`pnpm pack\` failed: ${String(error)}`);
    return null;
  }
  const { filename } = report;

  const unpackDir = path.join(unpackRoot, path.basename(filename, ".tgz"));
  mkdirSync(unpackDir, { recursive: true });
  if (!run("tar", ["-xzf", filename, "-C", unpackDir])) {
    add(`the tarball ${path.basename(filename)} could not be unpacked.`);
    return null;
  }

  const packageDir = path.join(unpackDir, "package");
  const manifestFile = path.join(packageDir, "package.json");
  if (!existsSync(manifestFile)) {
    add(`the tarball ${path.basename(filename)} carries no package.json.`);
    return null;
  }

  const declarations = listDeclarations(packageDir);
  if (declarations.length === 0) {
    add(
      `the tarball ${path.basename(filename)} carries no .d.ts files. A published package ships its declarations; check "files" and that \`turbo run build\` ran.`
    );
    return null;
  }

  return {
    name: readJson(manifestFile).name,
    tarball: filename,
    manifest: readJson(manifestFile),
    declarations,
    source: found,
  };
};

const checkApiReport = (packed, update, violations) => {
  const file = path.join(packed.source.dir, API_REPORT_FILE);
  const report = apiReport({ name: packed.name, files: packed.declarations });

  if (update) {
    writeFileSync(file, report);
    return;
  }

  const add = (message) =>
    violations.push({
      workspace: packed.source.workspace,
      rule: "api-report",
      message,
    });

  if (!existsSync(file)) {
    add(
      `"${packed.name}" has no checked-in ${API_REPORT_FILE}. Run \`pnpm verify:packages --update\` and commit it.`
    );
    return;
  }
  if (readFileSync(file, "utf-8") !== report) {
    add(
      `"${packed.name}" has a public API change its ${API_REPORT_FILE} does not record. Run \`pnpm verify:packages --update\` and review the diff.`
    );
  }
};

const checkForbiddenTypes = (packed, violations) => {
  for (const declaration of packed.declarations) {
    const offenders = forbiddenUpstreamTypes(declaration.text);
    if (offenders.length > 0) {
      violations.push({
        workspace: packed.source.workspace,
        rule: "forbidden-upstream-type",
        message: `"${packed.name}" exposes ${offenders.join(", ")} in ${declaration.path}. ADR 0005 keeps upstream implementation types off the public declaration surface.`,
      });
    }
  }
};

const checkPackedArtifact = (rootDir, packed, violations) => {
  const add = (tool) =>
    violations.push({
      workspace: packed.source.workspace,
      rule: "packed-artifact",
      message: `${tool} rejected ${path.basename(packed.tarball)}; its own output is above.`,
    });

  if (!run(localBin(rootDir, "publint"), [packed.tarball])) {
    add("publint");
  }
  if (
    !run(localBin(rootDir, "attw"), [packed.tarball, "--profile", ATTW_PROFILE])
  ) {
    add("attw");
  }
};

/**
 * The exact versions the fixture must pin: every non-Reprove dependency any
 * packed manifest declares, resolved to the copy its own workspace installed.
 */
const collectExternals = (packages, violations) => {
  const externals = {};
  for (const packed of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(packed.manifest[field] ?? {})) {
        if (dependency.startsWith("@reprove/")) {
          continue;
        }
        const version = installedVersion(packed.source.dir, dependency);
        if (version === null) {
          violations.push({
            workspace: packed.source.workspace,
            rule: "consumer-fixture",
            message: `"${packed.name}" declares "${dependency}", which is not installed. Run \`pnpm install\` so the consumer fixture can pin and resolve it offline.`,
          });
          continue;
        }
        externals[dependency] = version;
      }
    }
  }
  return externals;
};

const checkConsumerFixture = (rootDir, packages, fixtureDir, violations) => {
  const add = (message) =>
    violations.push({ workspace: "<root>", rule: "consumer-fixture", message });

  const nodeTypes = installedVersion(rootDir, "@types/node");
  if (nodeTypes === null) {
    add(
      "@types/node is not installed at the repository root, so the consumer fixture cannot type-check against the settled runtime. Run `pnpm install`."
    );
    return;
  }

  const externals = collectExternals(packages, violations);

  mkdirSync(fixtureDir, { recursive: true });
  for (const [file, contents] of Object.entries(
    consumerFixture({ packages, externals, nodeTypes })
  )) {
    writeFileSync(path.join(fixtureDir, file), contents);
  }

  if (
    !run("pnpm", ["install", "--ignore-scripts", "--offline"], {
      cwd: fixtureDir,
    })
  ) {
    add(
      "the consumer fixture did not install from the local store. Run `pnpm install` at the repository root so every packed dependency is in the store, then run this step again."
    );
    return;
  }

  if (
    !run(localBin(rootDir, "tsc"), [
      "--noEmit",
      "-p",
      path.join(fixtureDir, "tsconfig.json"),
    ])
  ) {
    add(
      "the packed declarations did not type-check in a clean consumer; tsc's own output is above."
    );
  }

  if (!run(process.execPath, ["smoke.mjs"], { cwd: fixtureDir })) {
    add(
      "an installed package did not import at runtime; node's own output is above."
    );
  }
};

// --- entry point -------------------------------------------------------------

/**
 * Proves every publishable package as a packed artifact.
 *
 * @param {{ rootDir: string, update?: boolean, keep?: boolean }} options The
 *   repository root, whether to rewrite the API reports, and whether to leave
 *   the temporary fixture on disk.
 * @returns {{ workspace: string, rule: string, message: string }[]} Every
 *   violation found, empty when the packed package contract holds.
 */
export const verifyPackages = ({ rootDir, update = false, keep = false }) => {
  const violations = [];
  const found = publishableWorkspaces({ rootDir });

  if (found.length === 0) {
    violations.push({
      workspace: "<root>",
      rule: "publishable-set",
      message:
        "no publishable workspace was discovered. Every package is marked private, or pnpm-workspace.yaml declares no globs.",
    });
    return violations;
  }

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "reprove-packages-"));
  try {
    const packDir = path.join(temporaryRoot, "tarballs");
    const unpackRoot = path.join(temporaryRoot, "unpacked");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(unpackRoot, { recursive: true });

    const packages = [];
    for (const workspace of found) {
      const packed = packWorkspace(workspace, packDir, unpackRoot, violations);
      if (packed === null) {
        continue;
      }
      packages.push(packed);
      checkApiReport(packed, update, violations);
      checkForbiddenTypes(packed, violations);
      checkPackedArtifact(rootDir, packed, violations);
    }

    if (packages.length === found.length) {
      checkConsumerFixture(
        rootDir,
        packages,
        path.join(temporaryRoot, "consumer"),
        violations
      );
    }

    return violations;
  } finally {
    if (keep) {
      process.stdout.write(`\nKept the package fixture at ${temporaryRoot}\n`);
    } else {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }
};

const main = () => {
  const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const update = process.argv.includes("--update");
  const keep = process.argv.includes("--keep");
  const violations = verifyPackages({ rootDir, update, keep });

  if (violations.length > 0) {
    for (const { workspace, rule, message } of violations) {
      process.stderr.write(`${workspace}  ${rule}  ${message}\n`);
    }
    process.stderr.write(
      `\n${violations.length} packed package contract violation(s). The step lives in tools/verify-packages.mjs.\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `\nPacked package contract holds: ${publishableWorkspaces({ rootDir }).length} publishable packages pack, install into a clean consumer fixture, type-check, import, and pass publint and attw.\n`
  );
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
