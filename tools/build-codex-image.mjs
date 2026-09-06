import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { codexImageFiles } from "@reprove/adapters";
import { CODEX_SANDBOX_PROFILE } from "@reprove/worker-core";

const execute = promisify(execFile);

/** Build only pinned upstream bootstrap inputs, before any repository or credential. */
export const buildCodexImage = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "reprove-codex-build-"));
  try {
    const files = await codexImageFiles();
    await Promise.all(
      files.map(async (file) => {
        if (path.basename(file.path) !== file.path) {
          throw new Error("unexpected bootstrap path");
        }
        await writeFile(path.join(directory, file.path), file.content);
      })
    );
    await execute(
      "docker",
      ["build", "--tag", CODEX_SANDBOX_PROFILE.image, directory],
      {
        timeout: 240_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await buildCodexImage();
  process.stdout.write(`Built ${CODEX_SANDBOX_PROFILE.image}\n`);
}
