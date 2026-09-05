#!/usr/bin/env node
/**
 * Proves the artifact a consumer would actually install, before publication
 * exists (ADR 0010, issue #43).
 *
 * Every check here reads the *packed* tarball rather than the source tree,
 * because the defects this step exists to catch - a wrong `files` list, an
 * export map that resolves only inside the workspace, a dependency used but
 * never declared, an upstream type leaking through a signature - are invisible
 * from the workspace and appear only once the package has been packed and
 * installed somewhere else.
 *
 * The fixture it installs into holds one consumer per package, each depending
 * on its own tarball alone; `consumerFixture` explains why that shape is what
 * the isolation claim rests on.
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
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { satisfies } from "semver";
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

const RAN = "ran";
const REJECTED = "rejected";
const ABSENT = "absent";

/**
 * Runs a tool and lets its own output through untouched. The package-contract
 * tools are the ones with something to say when they fail, so nothing here
 * parses or reformats them; only the exit code is read.
 *
 * A tool that is not installed is reported separately from one that ran and
 * refused, because the two need opposite fixes and only the second leaves any
 * output to read. Anything that is neither is rethrown rather than reported as
 * a contract violation the repository could act on.
 *
 * @returns {"ran" | "rejected" | "absent"} How the tool ended.
 */
const run = (command, args, options = {}) => {
  try {
    execFileSync(command, args, { stdio: "inherit", ...options });
    return RAN;
  } catch (error) {
    if (error.code === "ENOENT") {
      return ABSENT;
    }
    if (error.status !== undefined || error.signal) {
      return REJECTED;
    }
    throw error;
  }
};

const localBin = (rootDir, name) =>
  path.join(rootDir, "node_modules", ".bin", name);

const notInstalled = (name) =>
  `${name} is not installed, so the packed artifact was never checked. Run \`pnpm install\`.`;

const notOnPath = (name, purpose) =>
  `${name} was not found on PATH. The packed package contract ${purpose}.`;

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
 * `"./package.json"` is dropped because it is not an API. A pattern key is
 * dropped too, but it is never dropped silently: `patternExportKeys` reports it
 * so the step fails rather than quietly proving less than it claims to.
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
 * The `exports` keys this step cannot expand into a concrete specifier. A
 * pattern names a set of subpaths only the file system knows, so neither the
 * generated consumer nor the smoke run can cover it, and covering the export
 * surface is the whole claim this step makes.
 *
 * @param {{ exports?: Record<string, unknown> }} manifest A packed manifest.
 * @returns {string[]} Each pattern key, in declaration order.
 */
export const patternExportKeys = (manifest) =>
  Object.keys(manifest.exports ?? {}).filter((key) =>
    key.includes(EXPORT_PATTERN_KEY)
  );

/**
 * The exact version the consumer fixture pins each external dependency to, and
 * every reason a pin would prove the wrong thing.
 *
 * The fixture pins rather than resolves so it can install offline, inside the
 * supply-chain policy. That pin is only honest while it also satisfies what the
 * packed manifest declares: without this check a package could ship
 * `"zod": "^99"` and still be proved against the 4.x the workspace happens to
 * have installed. Two workspaces resolving one dependency differently is the
 * same problem from the other side, and is reported rather than silently
 * settled by whichever was read last.
 *
 * @param {{
 *   workspace: string, name: string, dependency: string,
 *   range: string, installed: string | null,
 * }[]} declared Every external dependency edge across the packed manifests.
 * @returns {{
 *   externals: Record<string, string>,
 *   problems: { workspace: string, message: string }[],
 * }} The pins, and any edge that must be fixed before they mean anything.
 */
export const pinExternals = (declared) => {
  const externals = {};
  const problems = [];
  const add = (edge, message) =>
    problems.push({ workspace: edge.workspace, message });

  for (const edge of declared) {
    if (edge.installed === null) {
      add(
        edge,
        `"${edge.name}" declares "${edge.dependency}", which is not installed. Run \`pnpm install\` so the consumer fixture can pin and resolve it offline.`
      );
      continue;
    }
    if (!satisfies(edge.installed, edge.range)) {
      add(
        edge,
        `"${edge.name}" declares "${edge.dependency}": "${edge.range}", but the workspace installed ${edge.installed}. The consumer fixture pins the installed version, so this package would be proved against a version its own manifest does not accept.`
      );
      continue;
    }
    const pinned = externals[edge.dependency];
    if (pinned !== undefined && pinned !== edge.installed) {
      add(
        edge,
        `"${edge.name}" resolves "${edge.dependency}" to ${edge.installed}, but another package resolves it to ${pinned}. A consumer installs one copy, so the fixture cannot prove both. A catalog entry is the usual way to settle it.`
      );
      continue;
    }
    externals[edge.dependency] = edge.installed;
  }

  return { externals, problems };
};

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
 * The directory one package's consumer occupies inside the fixture.
 *
 * @param {string} name A package name.
 * @returns {string} A directory name unique across the publishable set.
 */
export const consumerDirectory = (name) => name.replace(SCOPE_PREFIX, "");

/**
 * The tsconfig every consumer type-checks under. The repository base config
 * skips lib checking for build speed; here the opposite is the point, that the
 * shipped declarations themselves compile for a consumer rather than merely the
 * consumer's own file.
 */
const CONSUMER_TSCONFIG = {
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
    skipLibCheck: false,
    noEmit: true,
  },
  include: ["consumer.ts"],
};

/**
 * The whole consumer fixture as text, generated from the packed manifests so no
 * list of packages, subpaths or dependencies is maintained by hand.
 *
 * **One consumer package per published package**, each depending on its own
 * tarball and nothing else. A single consumer depending on all eight would not
 * prove isolation, however the store is laid out: Node and TypeScript resolve
 * by walking *up* from the importing file, so a package installed beside the
 * others reaches them through the fixture root's own `node_modules` and an
 * undeclared dependency resolves anyway. Separate consumer packages put a
 * different set of siblings above each one, which is what makes an undeclared
 * dependency fail. `hoistPattern` and `publicHoistPattern` are emptied for the
 * same reason: pnpm's default `["*"]` builds a `node_modules/.pnpm/node_modules`
 * that sits on exactly that walk-up path.
 *
 * They share one `pnpm install`, because they are one pnpm workspace.
 *
 * **Every edge is pinned, not just the packed packages' own dependencies.**
 * `--offline` restricts the tarballs pnpm may use, not the versions it may
 * choose: it resolves each range against cached registry metadata and then
 * demands whatever it picked. A transitive range left unpinned therefore
 * re-resolves here, and picks a version published after the lockfile was
 * written - one no `pnpm install` at the root ever put in the store, so the
 * fixture fails on a tarball it cannot download (issue #47). `resolutions`
 * carries the workspace's own answer for those edges, keyed by the parent that
 * declares each one so a package the workspace holds at two versions keeps
 * both.
 *
 * @param {{
 *   packages: { tarball: string, manifest: Record<string, unknown> }[],
 *   externals: Record<string, string>,
 *   resolutions: { parent: string, dependency: string, version: string }[],
 *   nodeTypes: string,
 * }} options The packed packages, exact external pins, every transitive edge as
 *   the workspace resolved it, and the `@types/node` version it installed.
 * @returns {Record<string, string>} Path within the fixture to contents.
 */
export const consumerFixture = ({
  packages,
  externals,
  resolutions,
  nodeTypes,
}) => {
  const ordered = packages.toSorted((a, b) =>
    byText(a.manifest.name, b.manifest.name)
  );
  const overrides = {
    ...Object.fromEntries(
      ordered.map((entry) => [entry.manifest.name, `file:${entry.tarball}`])
    ),
    ...externals,
    ...Object.fromEntries(
      resolutions.map((edge) => [
        `${edge.parent}>${edge.dependency}`,
        edge.version,
      ])
    ),
  };

  const consumers = ordered.flatMap((entry) => {
    const { name } = entry.manifest;
    const dir = `consumers/${consumerDirectory(name)}`;
    const subpaths = exportSubpaths(entry.manifest);
    const manifest = {
      name: `consumer-${consumerDirectory(name)}`,
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: { [name]: `file:${entry.tarball}` },
      devDependencies: { "@types/node": nodeTypes },
    };

    return [
      [`${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`],
      [
        `${dir}/tsconfig.json`,
        `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`,
      ],
      [
        `${dir}/consumer.ts`,
        [
          `// Generated by tools/verify-packages.mjs. What an outside consumer of`,
          `// "${name}" would write, resolved through the packed export map.`,
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
      ],
      [
        `${dir}/smoke.mjs`,
        [
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
      ],
    ];
  });

  const root = {
    name: "reprove-consumer-fixture",
    version: "0.0.0",
    private: true,
    type: "module",
  };

  return {
    "package.json": `${JSON.stringify(root, null, 2)}\n`,
    "pnpm-workspace.yaml": [
      "# Generated by tools/verify-packages.mjs.",
      "# The root declares no dependencies and hoisting is off, so nothing sits",
      "# on a consumer's module resolution walk-up except what it declared.",
      "# Every version is pinned exactly - the packed packages' own dependencies",
      "# by name, and every transitive edge by the parent that declares it - so",
      "# `pnpm install --offline` resolves the graph the repository install",
      "# already put in the store rather than resolving ranges afresh.",
      "packages:",
      '  - "consumers/*"',
      "nodeLinker: isolated",
      "hoistPattern: []",
      "publicHoistPattern: []",
      "overrides:",
      ...Object.keys(overrides)
        .toSorted(byText)
        .map((key) => `  "${key}": "${overrides[key]}"`),
      "",
    ].join("\n"),
    ...Object.fromEntries(consumers),
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
 * The text is tokenized rather than matched with a regex, because these
 * packages are precisely the ones whose doc comments have reason to name the
 * types they are forbidden to expose, and a comment explaining the rule must
 * not read as a violation of it. The scanner skips trivia, so only real
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
const packWorkspace = (workspace, packDir, unpackRoot, violations) => {
  const add = (message) =>
    violations.push({
      workspace: workspace.workspace,
      rule: "package-pack",
      message,
    });

  let report;
  try {
    const output = execFileSync(
      "pnpm",
      ["pack", "--json", "--pack-destination", packDir],
      {
        cwd: workspace.dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      }
    );
    report = JSON.parse(output);
  } catch (error) {
    add(`\`pnpm pack\` failed: ${String(error)}`);
    return null;
  }

  // The domain value this step needs is a tarball on disk, so that is what the
  // payload is read for. `existsSync` answers it for anything pnpm might have
  // printed, which keeps a surprising payload a violation rather than a crash.
  const { filename } = report;
  if (!existsSync(filename)) {
    add(
      `\`pnpm pack --json\` named no tarball on disk. It reported ${JSON.stringify(report)}, which this step cannot follow.`
    );
    return null;
  }

  const unpackDir = path.join(unpackRoot, path.basename(filename, ".tgz"));
  mkdirSync(unpackDir, { recursive: true });
  const unpacked = run("tar", ["-xzf", filename, "-C", unpackDir]);
  if (unpacked !== RAN) {
    add(
      unpacked === ABSENT
        ? notOnPath("tar", "unpacks every tarball with it")
        : `the tarball ${path.basename(filename)} could not be unpacked.`
    );
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
    tarball: filename,
    manifest: readJson(manifestFile),
    declarations,
    source: workspace,
  };
};

const checkApiReport = (packed, update, violations) => {
  const { name } = packed.manifest;
  const file = path.join(packed.source.dir, API_REPORT_FILE);
  const report = apiReport({ name, files: packed.declarations });

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
      `"${name}" has no checked-in ${API_REPORT_FILE}. Run \`pnpm verify:packages --update\` and commit it.`
    );
    return;
  }
  if (readFileSync(file, "utf-8") !== report) {
    add(
      `"${name}" has a public API change its ${API_REPORT_FILE} does not record. Run \`pnpm verify:packages --update\` and review the diff.`
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
        message: `"${packed.manifest.name}" exposes ${offenders.join(", ")} in ${declaration.path}. ADR 0005 keeps upstream implementation types off the public declaration surface.`,
      });
    }
  }
};

const checkPackedArtifact = (rootDir, packed, violations) => {
  const add = (message) =>
    violations.push({
      workspace: packed.source.workspace,
      rule: "packed-artifact",
      message,
    });
  const rejected = (tool) =>
    `${tool} rejected ${path.basename(packed.tarball)}; its own output is above.`;

  for (const key of patternExportKeys(packed.manifest)) {
    add(
      `"${packed.manifest.name}" declares the pattern export "${key}". This step proves one concrete specifier per subpath, and a pattern names a set only the file system knows, so it would be neither imported nor smoke-checked. Declare each subpath explicitly.`
    );
  }

  // `--strict` promotes publint's warnings to failures. A warning about a
  // published package is a defect a consumer would meet; nothing here is
  // waiting to be triaged later.
  const linted = run(localBin(rootDir, "publint"), [
    packed.tarball,
    "--strict",
  ]);
  if (linted !== RAN) {
    add(linted === ABSENT ? notInstalled("publint") : rejected("publint"));
  }

  const analysed = run(localBin(rootDir, "attw"), [
    packed.tarball,
    "--profile",
    ATTW_PROFILE,
  ]);
  if (analysed !== RAN) {
    add(analysed === ABSENT ? notInstalled("attw") : rejected("attw"));
  }
};

/**
 * Every external dependency edge across the packed manifests, each paired with
 * the version its own workspace installed, in the shape `pinExternals` judges.
 */
const declaredExternals = (packages) =>
  packages.flatMap((packed) =>
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.entries(packed.manifest[field] ?? {})
        .filter(([dependency]) => !dependency.startsWith("@reprove/"))
        .map(([dependency, range]) => ({
          workspace: packed.source.workspace,
          name: packed.manifest.name,
          dependency,
          range,
          installed: installedVersion(packed.source.dir, dependency),
        }))
    )
  );

/**
 * The dependency names a consumer install of a package would have to resolve.
 *
 * Optional peers are excluded because pnpm only installs a peer it is asked
 * for; `drizzle-orm` declaring an optional peer on `next` does not put Next.js
 * in a consumer's graph, and pinning it would describe an install nobody
 * performs.
 *
 * @param {Record<string, unknown>} manifest An installed `package.json`.
 * @returns {string[]} Each dependency name, once.
 */
export const resolvableDependencies = (manifest) => {
  const meta = manifest.peerDependenciesMeta ?? {};
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => meta[name]?.optional !== true
      ),
    ]),
  ];
};

/**
 * Every dependency edge underneath the packed packages, as the workspace
 * install actually resolved it.
 *
 * Read off `node_modules` rather than the lockfile: the lockfile states the
 * resolution in pnpm's peer-suffixed notation, while what the fixture has to
 * pin is the plain `name@version` an override key is written in, and the linked
 * tree already answers that with no parsing. `@types/node` is a root of the
 * walk because every consumer declares it, so its own dependencies drift the
 * same way (issue #47).
 *
 * A package reached twice through different peer resolutions is visited once
 * per directory; the versions it declares are identical either way, so the
 * edges collapse.
 *
 * @param {{
 *   rootDir: string,
 *   packages: { manifest: Record<string, unknown>, source: { dir: string } }[],
 * }} options The repository root and the packed packages.
 * @returns {{ parent: string, dependency: string, version: string }[]} Each
 *   edge, `parent` written `name@version`, sorted for a stable fixture.
 */
export const installedResolutions = ({ rootDir, packages }) => {
  const edges = new Map();
  const visited = new Set();

  const visit = (dir) => {
    const real = realpathSync(dir);
    if (visited.has(real)) {
      return;
    }
    visited.add(real);

    const manifest = readJson(path.join(real, "package.json"));
    // A package's own dependencies sit in the `node_modules` directory it sits
    // in, in pnpm's isolated layout as much as in a flat one.
    const nodeModules = path.resolve(
      real,
      manifest.name.startsWith("@") ? "../.." : ".."
    );

    for (const dependency of resolvableDependencies(manifest)) {
      const childDir = path.join(nodeModules, dependency);
      const childManifest = path.join(childDir, "package.json");
      if (!existsSync(childManifest)) {
        continue;
      }
      const parent = `${manifest.name}@${manifest.version}`;
      edges.set(`${parent}>${dependency}`, {
        parent,
        dependency,
        version: readJson(childManifest).version,
      });
      visit(childDir);
    }
  };

  const roots = [
    [rootDir, "@types/node"],
    ...packages.flatMap((packed) =>
      DEPENDENCY_FIELDS.flatMap((field) =>
        Object.keys(packed.manifest[field] ?? {})
          .filter((dependency) => !dependency.startsWith("@reprove/"))
          .map((dependency) => [packed.source.dir, dependency])
      )
    ),
  ];
  for (const [dir, dependency] of roots) {
    const start = path.join(dir, "node_modules", dependency);
    if (existsSync(path.join(start, "package.json"))) {
      visit(start);
    }
  }

  return [...edges.values()].toSorted((a, b) =>
    byText(`${a.parent}>${a.dependency}`, `${b.parent}>${b.dependency}`)
  );
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

  const { externals, problems } = pinExternals(declaredExternals(packages));
  for (const problem of problems) {
    violations.push({ ...problem, rule: "consumer-fixture" });
  }
  if (problems.length > 0) {
    add(
      "the consumer fixture did not run, because the versions it would pin do not agree with what the packed manifests declare."
    );
    return;
  }

  for (const [file, contents] of Object.entries(
    consumerFixture({
      packages,
      externals,
      resolutions: installedResolutions({ rootDir, packages }),
      nodeTypes,
    })
  )) {
    const target = path.join(fixtureDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  // One install for the whole fixture: the consumers are one pnpm workspace.
  const installed = run("pnpm", ["install", "--ignore-scripts", "--offline"], {
    cwd: fixtureDir,
  });
  if (installed !== RAN) {
    add(
      installed === ABSENT
        ? notOnPath("pnpm", "installs the packed tarballs with it")
        : "the consumer fixture did not install from the local store. Run `pnpm install` at the repository root so every packed dependency is in the store, then run this step again."
    );
    return;
  }

  for (const packed of packages) {
    const { name } = packed.manifest;
    const consumerDir = path.join(
      fixtureDir,
      "consumers",
      consumerDirectory(name)
    );
    const blame = (message) =>
      violations.push({
        workspace: packed.source.workspace,
        rule: "consumer-fixture",
        message,
      });

    const checked = run(localBin(rootDir, "tsc"), [
      "--noEmit",
      "-p",
      path.join(consumerDir, "tsconfig.json"),
    ]);
    if (checked !== RAN) {
      blame(
        checked === ABSENT
          ? notInstalled("tsc")
          : `"${name}" did not type-check in a consumer that installed only it; tsc's own output is above. An unresolved import here is a dependency the package uses but does not declare.`
      );
    }

    if (run(process.execPath, ["smoke.mjs"], { cwd: consumerDir }) !== RAN) {
      blame(
        `"${name}" did not import at runtime in a consumer that installed only it; node's own output is above. An unresolved specifier here is a dependency the package uses but does not declare.`
      );
    }
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
    } else {
      // Said out loud, because "not run" and "passed" must not read the same.
      violations.push({
        workspace: "<root>",
        rule: "consumer-fixture",
        message: `the consumer fixture did not run: ${found.length - packages.length} of ${found.length} publishable packages could not be packed. A fixture missing a package proves nothing about it, so fix the pack failures above and run the step again.`,
      });
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
