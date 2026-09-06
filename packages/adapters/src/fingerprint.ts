import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Hash executable package contents, including the embedded bridge and lockfile. */
const fingerprintDirectory = (entry: string): string => {
  const directory = path.dirname(fileURLToPath(entry));
  const files = readdirSync(directory, { recursive: true, encoding: "utf-8" })
    .filter(
      (file) =>
        /\.(?:m?js|ts|json|ya?ml)$/u.test(file) &&
        !/\.(?:d|test|test-support)\.ts$/u.test(file)
    )
    .toSorted();
  const hash = createHash("sha256").update(
    readFileSync(path.join(directory, "../package.json"))
  );
  for (const file of files) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(path.join(directory, file)))
      .update("\0");
  }
  return hash.digest("hex");
};

export const ARTIFACT_FINGERPRINT = [
  fingerprintDirectory(import.meta.url),
  fingerprintDirectory(import.meta.resolve("@ai-sdk/harness-codex")),
  fingerprintDirectory(import.meta.resolve("@ai-sdk/harness")),
].join(":");
