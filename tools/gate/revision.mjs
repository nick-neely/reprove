/**
 * A revision, as the gate sees one: a built checkout of this repository whose
 * packages the gate loads, whose Codex image it builds, and whose identity it
 * records exactly.
 *
 * #34 names the Revision as the qualification Lineage plus
 * the Harness artifact fingerprint, the Adapter build, the Reviewer
 * instruction and policy digest, the instruction-boundary version and the
 * narrative schema version. Each of those is read off the revision's own
 * built packages rather than off this checkout, so a baseline reconstructed
 * from an older commit describes itself, and a candidate that changed only
 * its policy text gets a new revision id even though no dependency moved.
 *
 * The gate never imports `@reprove/*` by bare name for a revision under
 * evaluation: both arms are loaded by file URL from their own `dist`, which is
 * what lets a baseline and a candidate with different pins run side by side
 * in one process.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { lineageId, PHASE0_LINEAGE } from "./report.mjs";

const execute = promisify(execFile);

/**
 * The reasoning effort the Phase 0 Lineage runs at. One definition, because
 * the identity recorded for a Revision and the effort its trials run at must
 * be the same value.
 */
export const DEFAULT_REASONING_EFFORT = "medium";

/** @typedef {import("./report.mjs").Lineage} Lineage */
/** @typedef {import("./report.mjs").Revision} Revision */

/**
 * A built checkout, with its own packages already loaded by file URL.
 *
 * @typedef {object} LoadedRevision
 * @property {string} root Absolute path of the built checkout.
 * @property {string} gitSha The commit it is checked out at.
 * @property {typeof import("@reprove/adapters")} adapters Its Adapter package.
 * @property {typeof import("@reprove/worker-core")} workerCore Its Worker core.
 * @property {typeof import("@reprove/sandbox-container")} sandboxContainer Its Sandbox package.
 */

/**
 * The commit a checkout is at.
 *
 * @param {string} root The checkout to read.
 * @returns {Promise<string>} The resolved commit sha.
 */
export const gitShaOf = async (root) => {
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], { cwd: root });
  return stdout.trim();
};

/**
 * Check out, install and build one commit in a disposable worktree.
 *
 * Reproduction requires exact packages, artifacts and lock, which is what a
 * frozen install of the commit's own lockfile gives. The worktree is created
 * from this repository, so the commit must be reachable here.
 *
 * @param {object} input Where the worktree comes from and goes.
 * @param {string} input.repository The repository to take the worktree from.
 * @param {string} input.gitSha The commit to build.
 * @param {string} input.workRoot Where worktrees are placed.
 * @param {(line: string) => void} [input.log] Progress lines, if wanted.
 * @returns {Promise<string>} The worktree's absolute path.
 */
export const prepareWorktree = async ({
  repository,
  gitSha,
  workRoot,
  log,
}) => {
  await mkdir(workRoot, { recursive: true });
  const root = path.join(workRoot, gitSha.slice(0, 12));
  log?.(`preparing ${gitSha} in ${root}`);
  await execute(
    "git",
    ["worktree", "add", "--detach", "--force", root, gitSha],
    {
      cwd: repository,
    }
  );
  await execute("pnpm", ["install", "--frozen-lockfile"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  await execute("pnpm", ["exec", "turbo", "run", "build"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  return root;
};

/**
 * Load a built checkout's packages by file URL.
 *
 * @param {string} root The built checkout to load.
 * @returns {Promise<LoadedRevision>} Its packages, root and commit.
 */
export const loadRevision = async (root) => {
  const load = (relative) =>
    import(pathToFileURL(path.join(root, relative)).href);
  const [adapters, workerCore, sandboxContainer, gitSha] = await Promise.all([
    load("packages/adapters/dist/index.js"),
    load("packages/worker-core/dist/index.js"),
    load("packages/sandbox-container/dist/index.js"),
    gitShaOf(root),
  ]);
  return {
    root: path.resolve(root),
    gitSha,
    adapters,
    workerCore,
    sandboxContainer,
  };
};

/**
 * The exact identity #34 requires, read from the revision's own packages.
 *
 * @param {LoadedRevision} loaded The revision's own built packages.
 * @param {Lineage} [lineage] The Lineage; Phase 0 by default.
 * @param {"low" | "medium" | "high" | "xhigh" | "max"} [reasoningEffort] The reasoning effort the Lineage runs at.
 * @returns {Revision} The identity a report and a baseline pointer quote.
 */
export const describeRevision = (
  loaded,
  lineage = PHASE0_LINEAGE,
  reasoningEffort = DEFAULT_REASONING_EFFORT
) => {
  if (lineage.route !== "brokered" || lineage.harness !== "codex") {
    throw new Error(
      `${lineageId(lineage)} is not a lineage this gate qualifies`
    );
  }
  // The key is not part of the fingerprint; only the Route and Provider are.
  const harnessArtifact = loaded.adapters.codexFingerprint(
    { kind: "api-key", provider: lineage.provider, key: "fingerprint-only" },
    lineage.model,
    reasoningEffort
  );
  const instructionDigest = createHash("sha256")
    .update(
      loaded.workerCore.renderInstructions(
        loaded.workerCore.composeInstructions({
          autonomy: lineage.autonomy,
          conventions: [],
        })
      )
    )
    .digest("hex");
  const encoded = loaded.workerCore.encodeNarrative({
    title: "revision identity",
    description: null,
  });
  if (encoded.file === null) {
    throw new Error("the revision could not encode a narrative");
  }
  const narrativeSchemaVersion = Number(
    JSON.parse(encoded.file.bytes).schemaVersion
  );
  const identity = {
    lineage,
    gitSha: loaded.gitSha,
    harnessArtifact,
    instructionDigest,
    narrativeSchemaVersion,
    narrativePath: loaded.workerCore.NARRATIVE_PATH,
    protocolVersion: loaded.workerCore.composedFrom.protocolVersion,
  };
  return {
    revisionId: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex")
      .slice(0, 24),
    gitSha: loaded.gitSha,
    lineage,
    harnessArtifact,
    instructionDigest,
    narrativeSchemaVersion,
    protocolVersion: identity.protocolVersion,
    reasoningEffort,
    workerBuildVersion: `gate-${loaded.gitSha.slice(0, 12)}`,
  };
};

/**
 * The image tag a revision's Codex runtime is built under.
 *
 * @param {string} gitSha The commit the revision was built from.
 * @returns {string} A tag no other revision's pins can collide with.
 */
export const imageTagFor = (gitSha) =>
  `reprove-codex-gate:${gitSha.slice(0, 12)}`;

/**
 * Build the revision's own pinned Codex image under its own tag, so two
 * revisions with different pins never share one.
 *
 * @param {LoadedRevision} loaded The revision whose image to build.
 * @param {object} [options] How to run the build.
 * @param {string} [options.runtime] The container CLI, `docker` by default.
 * @param {(line: string) => void} [options.log] Progress lines, if wanted.
 * @returns {Promise<import("@reprove/worker-core").SandboxProfile>} The profile pinned to the built image.
 */
export const buildRevisionImage = async (loaded, options = {}) => {
  const tag = imageTagFor(loaded.gitSha);
  const directory = await mkdtemp(path.join(tmpdir(), "reprove-gate-image-"));
  try {
    const files = await loaded.adapters.codexImageFiles();
    await Promise.all(
      files.map(async (file) => {
        if (path.basename(file.path) !== file.path) {
          throw new Error("unexpected bootstrap path");
        }
        await writeFile(path.join(directory, file.path), file.content);
      })
    );
    options.log?.(`building ${tag}`);
    await execute(
      options.runtime ?? "docker",
      ["build", "--tag", tag, directory],
      {
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { ...loaded.workerCore.CODEX_SANDBOX_PROFILE, image: tag };
};
