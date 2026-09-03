/**
 * Where a workspace directory is, and nothing about what it is allowed to
 * contain.
 *
 * ADR 0010's allowlist stays in `tools/verify-workspace.mjs`, which is the only
 * file that says which workspaces may exist and what each may depend on. This
 * module owns the mechanical half of that job - reading `pnpm-workspace.yaml`
 * and expanding its globs - so a second tool can find the same directories
 * without carrying a second copy of the table (issue #43).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const PACKAGES_KEY = /^packages:\s*$/u;

/**
 * The three line shapes both readers of `pnpm-workspace.yaml` share. One
 * definition, so a correction to how a line is read cannot half-apply: the
 * workspace globs and the supply-chain exceptions are parsed the same way.
 */
export const YAML_LIST_ITEM = /^\s+-\s+(?<item>.+?)\s*$/u;
export const YAML_QUOTES = /^['"]|['"]$/gu;
export const YAML_COMMENT = /#.*$/u;

/**
 * Reads the `packages:` list out of `pnpm-workspace.yaml`. A YAML parser is not
 * worth a runtime dependency for one fixed-shape list; anything this misreads
 * surfaces as a workspace-set violation rather than as silence.
 *
 * @param {string} rootDir The repository root to read from.
 * @returns {string[] | null} The declared globs, or null when the file is absent.
 */
export const readWorkspaceGlobs = (rootDir) => {
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
export const expandGlobs = (rootDir, globs) => {
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
 * Every workspace the declared globs reach, with its manifest already read.
 *
 * @param {{ rootDir: string }} options The repository root to discover from.
 * @returns {{ workspace: string, dir: string, manifest: Record<string, unknown> }[]}
 *   One entry per workspace, ordered by workspace path.
 */
export const discoverWorkspaces = ({ rootDir }) => {
  const globs = readWorkspaceGlobs(rootDir);
  if (globs === null) {
    return [];
  }
  return expandGlobs(rootDir, globs).map((workspace) => {
    const dir = path.join(rootDir, workspace);
    return {
      workspace,
      dir,
      manifest: JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf-8")
      ),
    };
  });
};

/**
 * The workspaces a consumer could install, decided the way npm decides it:
 * anything not marked `private`. It is deliberately not read off ADR 0010's
 * table. `checkPublishability` in tools/verify-workspace.mjs already asserts
 * both directions of that flag against the table, so the two answers cannot
 * disagree without the workspace check failing first.
 *
 * @param {{ rootDir: string }} options The repository root to discover from.
 * @returns {{ workspace: string, dir: string, manifest: Record<string, unknown> }[]}
 *   One entry per publishable workspace, ordered by workspace path.
 */
export const publishableWorkspaces = ({ rootDir }) =>
  discoverWorkspaces({ rootDir }).filter(
    (found) => found.manifest.private !== true
  );
