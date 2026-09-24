// Mirrors tools/build-codex-image.mjs, but tags per lock so the shared
// reprove-codex:0.153.4-1.0.104 image is never overwritten.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { VARIANTS } from "./variants.mjs";

const execute = promisify(execFile);

for (const variant of Object.values(VARIANTS)) {
  const { codexImageFiles, CODEX_CLI_VERSION } = await import(variant.adapters);
  if (CODEX_CLI_VERSION !== variant.cli) {
    throw new Error(`${variant.adapters} is ${CODEX_CLI_VERSION}`);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "reprove-131-build-"));
  try {
    for (const file of await codexImageFiles()) {
      if (path.basename(file.path) !== file.path) {
        throw new Error("unexpected bootstrap path");
      }
      await writeFile(path.join(directory, file.path), file.content);
    }
    await execute("docker", ["build", "--tag", variant.image, directory], {
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    process.stdout.write(`Built ${variant.image}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
