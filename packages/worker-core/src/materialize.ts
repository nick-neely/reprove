import type { Materialize } from "./run.js";

/** Author bytes travel on stdin. The protected writer establishes root ownership. */
export const materializeNarrative: Materialize = async (sandbox, file) => {
  if (!sandbox.access?.streaming) {
    throw new Error("the Sandbox has no protected file I/O");
  }
  await sandbox.access.protect(file.path, new TextEncoder().encode(file.bytes));
  const actual = await sandbox.access.read(file.path);
  if (actual === null || new TextDecoder().decode(actual) !== file.bytes) {
    throw new Error(
      "the protected narrative differs from its encoded representation"
    );
  }
};
