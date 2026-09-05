/**
 * The generator itself: it appends the FORCE delta, and it appends only.
 *
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md) makes
 * that a hard invariant rather than a style: `PgDialect.migrate` writes a hash
 * it never reads, so a rewritten migration is correct in the repository and
 * **inert in every database already carrying it**, with no error, warning or
 * drift signal anywhere. A generator that edited its own prior output would be
 * actively harmful.
 *
 * So the delta is derived from the effective state of the whole journal rather
 * than from the last file it wrote, and an empty delta emits nothing: running it
 * twice in a row produces one migration, not two.
 *
 * It never runs on its own. A failing check tells the developer to invoke it,
 * and the classification change and the generated statements land in the same
 * pull request - which is what keeps a tenant to non-tenant reclassification
 * reviewable rather than automatic.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Classification } from "./classification.js";
import { CLASSIFICATION } from "./classification.js";
import type { ForceOperation } from "./force.js";
import {
  forceDelta,
  readJournal,
  renderForceMigration,
  snapshotFile,
} from "./force.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";

/** What the generator wrote, for the caller that has to report it. */
export interface ForceMigration {
  /** The journal tag, which is also the `.sql` file's basename. */
  readonly tag: string;
  readonly operations: readonly ForceOperation[];
}

export interface EmitOptions {
  /** The migration folder to append to. Defaults to this package's own. */
  readonly folder?: string;
  /** The classification the delta is derived from. */
  readonly classification?: Classification;
  /**
   * The journal timestamp. Drizzle applies only migrations whose `when` exceeds
   * the newest applied one, so it is taken as strictly later than the last entry
   * rather than trusted from the clock.
   */
  readonly now?: number;
}

/** The tag's suffix, in the same shape drizzle-kit gives a named migration. */
const MIGRATION_NAME = "force_row_level_security";

/** A snapshot's identity, which is the only part a custom migration changes. */
interface Snapshot {
  id: string;
  prevId: string;
}

/**
 * Appends one custom migration carrying the FORCE delta, or nothing at all.
 *
 * The three artifacts are the three drizzle-kit writes for a `generate --custom`
 * migration, and they are written together because a journal entry naming a
 * missing file, or a snapshot chain with a hole in it, is a migration folder
 * every other reader of it would refuse.
 *
 * @param options See {@link EmitOptions}.
 * @returns What was appended, or `null` when the history already agrees with the
 *   classification.
 * @throws {Error} If the folder holds no migration to chain a snapshot onto.
 *   The initial schema is drizzle-kit's to generate, never this generator's.
 */
export const emitForceMigration = (
  options: EmitOptions = {}
): ForceMigration | null => {
  const folder = options.folder ?? MIGRATIONS_FOLDER;
  const classification = options.classification ?? CLASSIFICATION;

  const operations = forceDelta(classification, folder);
  if (operations.length === 0) {
    return null;
  }

  const entries = readJournal(folder);
  const last = entries.at(-1);
  if (last === undefined) {
    throw new Error(
      `${folder} holds no migration to append to. The initial schema is drizzle-kit's to generate.`
    );
  }

  const idx = last.idx + 1;
  const tag = `${String(idx).padStart(4, "0")}_${MIGRATION_NAME}`;
  // Strictly later than the last entry, because Drizzle applies only migrations
  // whose `folderMillis` exceeds the newest `created_at` in the ledger: an entry
  // appended with an older timestamp is skipped there and reported as pending by
  // the boot assertion forever.
  const when = Math.max(options.now ?? Date.now(), last.when + 1);

  // SAFETY: the previous snapshot is drizzle-kit's own output, and
  // `readJournal` has already established that the entry naming it exists.
  const previous = JSON.parse(
    readFileSync(snapshotFile(folder, last.idx), "utf-8")
  ) as Snapshot;

  writeFileSync(
    path.join(folder, `${tag}.sql`),
    renderForceMigration(operations)
  );
  writeFileSync(
    snapshotFile(folder, idx),
    `${JSON.stringify({ ...previous, id: randomUUID(), prevId: previous.id }, null, 2)}\n`
  );
  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    `${JSON.stringify(
      {
        version: "7",
        dialect: "postgresql",
        entries: [
          ...entries,
          { idx, version: "7", when, tag, breakpoints: true },
        ],
      },
      null,
      2
    )}\n`
  );

  return { tag, operations };
};

const main = () => {
  const emitted = emitForceMigration();
  if (emitted === null) {
    process.stdout.write(
      "The migration history already forces exactly the tenant tables. Nothing to append.\n"
    );
    return;
  }
  process.stdout.write(
    `${emitted.tag}: ${emitted.operations
      .map(
        (operation) =>
          `${operation.table} ${operation.forced ? "FORCE" : "NO FORCE"}`
      )
      .join(", ")}\n`
  );
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
