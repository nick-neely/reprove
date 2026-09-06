/**
 * The committed migration files, as the boot assertion and the `migrate`
 * command both need to see them.
 *
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md) makes
 * the migration folder a **runtime asset of this package**: the boot assertion
 * joins the hashes Drizzle stored against the files that produced them, so the
 * files have to travel with the package. It is therefore resolved relative to
 * this module rather than to `process.cwd()`, which would break in the deployed
 * Next.js application and in any consumer that runs from another directory.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * Where this module sits, which is what the migration folder is resolved from.
 *
 * **Three spellings of "beside this module" exist and only this one works
 * under a bundler**, which is why the long form is written out rather than
 * tidied:
 *
 * - `new URL("../../drizzle", import.meta.url)` is read by a bundler as a
 *   reference to a single asset it should copy into its output, and the build
 *   fails on a reference that names a directory.
 * - `import.meta.dirname` is `undefined` in a Turbopack-compiled module, so the
 *   join throws `ERR_INVALID_ARG_TYPE` while the page's configuration is being
 *   collected. Measured against Next.js 16.3; the lint rule that prefers it is
 *   disabled below for exactly that reason.
 * - `path.dirname(fileURLToPath(import.meta.url))` survives, because the
 *   bundler rewrites `import.meta.url` to the module's original location. The
 *   folder is then found beside the shipped `dist/` whether the module runs
 *   from the package or from a bundle.
 *
 * The deployment still has to ship the folder, which is a file-tracing concern
 * the app's `next.config.ts` states and the real-builder gate asserts.
 */
// oxlint-disable-next-line unicorn/prefer-import-meta-properties -- `import.meta.dirname` is undefined under Turbopack; see above.
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

/**
 * The folder `drizzle-kit generate` writes to, resolved from this module's own
 * location. `src/db/` and `dist/db/` sit the same distance below the package
 * root, so one expression serves the source tree and the packed artifact.
 */
export const MIGRATIONS_FOLDER = path.join(
  MODULE_DIRECTORY,
  "..",
  "..",
  "drizzle"
);

/** One committed migration, joined to the journal entry that names it. */
export interface CommittedMigration {
  /** The journal tag, which is what a refusal names. */
  readonly tag: string;
  /** `journal.when`, written verbatim as `created_at` when the migration applies. */
  readonly folderMillis: number;
  /** `sha256` of the entire raw `.sql` file, as Drizzle computes and stores it. */
  readonly hash: string;
}

interface Journal {
  entries: { idx: number; tag: string; when: number }[];
}

/**
 * Every committed migration in journal order.
 *
 * The hash and `folderMillis` come from Drizzle's own `readMigrationFiles`, so
 * they are the exact values `migrate()` writes into
 * `drizzle.__drizzle_migrations`; the tag comes from the journal beside them.
 * Computing either independently would be a reimplementation that could drift
 * from the thing it is supposed to be comparing against.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One entry per journal entry, in journal order.
 */
export const readCommittedMigrations = (
  folder: string = MIGRATIONS_FOLDER
): CommittedMigration[] => {
  // SAFETY: the journal is `drizzle-kit`'s own output, committed to this
  // repository and shipped inside the package. `readMigrationFiles` below reads
  // the same file and throws first if it is missing or malformed.
  const journal = JSON.parse(
    readFileSync(path.join(folder, "meta", "_journal.json"), "utf-8")
  ) as Journal;

  return readMigrationFiles({ migrationsFolder: folder }).map(
    (file, index) => ({
      tag: journal.entries[index]?.tag ?? `#${index}`,
      folderMillis: file.folderMillis,
      hash: file.hash,
    })
  );
};
