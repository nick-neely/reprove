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
 * The folder `drizzle-kit generate` writes to, resolved from this module's own
 * location. `src/db/` and `dist/db/` sit the same distance below the package
 * root, so one expression serves the source tree and the packed artifact.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
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
export function readCommittedMigrations(
  folder: string = MIGRATIONS_FOLDER
): CommittedMigration[] {
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
}
