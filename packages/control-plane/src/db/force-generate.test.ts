/**
 * The generator, held to the one property that makes it safe to run at all:
 * **it appends**.
 *
 * A rewritten migration is correct in the repository and inert in every database
 * already carrying it, because `PgDialect.migrate` writes a hash it never reads
 * ([ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)). So
 * "running it twice produces one migration" is not a convenience here; it is the
 * invariant, and the second run below is what measures it.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { Classification } from "./classification.js";
import { CLASSIFICATION } from "./classification.js";
import { emitForceMigration } from "./force-generate.js";
import {
  checkMigrationGrammar,
  effectiveForceState,
  forceStateProblems,
  readJournal,
  readMigrationSources,
} from "./force.js";
import {
  buildMigrationFolder,
  discardMigrationFolders,
  generated,
  INITIAL,
} from "./force.test-support.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";
import * as schema from "./schema.js";

discardMigrationFolders();

/** `run` Owner-scoped, `user` deliberately outside the Owner boundary. */
const classification: Classification = {
  managed: [schema.run, schema.user],
  tenant: [schema.run],
  nonTenant: [schema.user],
};

const read = (folder: string, tag: string): string =>
  readFileSync(path.join(folder, `${tag}.sql`), "utf-8");

/** A table as a snapshot holds it. Nothing here reads inside one. */
interface SnapshotTable {
  readonly name?: string;
}

/** A snapshot in the only detail the chain is about: its identity and content. */
interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<string, SnapshotTable>;
}

const readSnapshot = (folder: string, idx: string): Snapshot =>
  // SAFETY: the fixture builder and the generator both write this file, and
  // neither writes anything else into it.
  JSON.parse(
    readFileSync(path.join(folder, "meta", `${idx}_snapshot.json`), "utf-8")
  ) as Snapshot;

describe(emitForceMigration, () => {
  it("appends nothing when the history already agrees with the classification", () => {
    // The committed history, and therefore the case that matters most: the
    // generator must never rewrite `0001_force_row_level_security`. It runs
    // against a copy, because a test that proved this by writing into the
    // package would be the defect it exists to catch.
    const folder = mkdtempSync(path.join(tmpdir(), "reprove-committed-"));
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });

      expect(
        emitForceMigration({ folder, classification: CLASSIFICATION })
      ).toBeNull();
    } finally {
      rmSync(folder, { force: true, recursive: true });
    }
  });

  it("appends the FORCE statement a newly tenant table needs", () => {
    const folder = buildMigrationFolder([INITIAL]);

    const emitted = emitForceMigration({ folder, classification });

    expect(emitted?.tag).toBe("0001_force_row_level_security");
    expect(read(folder, "0001_force_row_level_security")).toBe(
      '-- reprove:force-row-level-security\nALTER TABLE "run" FORCE ROW LEVEL SECURITY;\n'
    );
    expect(forceStateProblems(classification, folder)).toStrictEqual([]);
    expect(checkMigrationGrammar(folder)).toStrictEqual([]);
  });

  it("appends NO FORCE for a table that stopped being tenant", () => {
    const folder = buildMigrationFolder([
      INITIAL,
      generated(
        'ALTER TABLE "run" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "user" FORCE ROW LEVEL SECURITY;'
      ),
    ]);

    const emitted = emitForceMigration({ folder, classification });

    expect(emitted?.operations).toStrictEqual([
      { table: "user", forced: false },
    ]);
    expect(effectiveForceState(folder).get("user")).toBeFalsy();
  });

  it("appends once, not twice, when run again", () => {
    const folder = buildMigrationFolder([INITIAL]);

    expect(emitForceMigration({ folder, classification })).not.toBeNull();
    expect(emitForceMigration({ folder, classification })).toBeNull();
    expect(readJournal(folder)).toHaveLength(2);
    // The file it wrote the first time is still the file it wrote, byte for
    // byte, because the second run read the effective state and had nothing to
    // say rather than rewriting its own prior output.
    expect(read(folder, "0001_force_row_level_security")).toContain(
      'ALTER TABLE "run" FORCE ROW LEVEL SECURITY;'
    );
  });

  it("writes a migration the reader attributes to the generator", () => {
    const folder = buildMigrationFolder([INITIAL]);
    emitForceMigration({ folder, classification });

    expect(
      readMigrationSources(folder).map((migration) => migration.kind)
    ).toStrictEqual(["drizzle", "generator"]);
  });

  it("chains the snapshot onto its parent", () => {
    const folder = buildMigrationFolder([INITIAL]);
    emitForceMigration({ folder, classification });

    // SAFETY: both files are snapshots this test's own fixture and the call
    // under test wrote, one line above, in exactly this shape.
    const snapshot = readSnapshot(folder, "0001");
    const parent = readSnapshot(folder, "0000");

    expect(snapshot.prevId).toBe(parent.id);
    expect(snapshot.id).not.toBe(parent.id);
    expect(snapshot.tables).toStrictEqual(parent.tables);
  });

  it("timestamps the entry after the last one, whatever the clock says", () => {
    // Drizzle applies only migrations whose `folderMillis` exceeds the newest
    // applied `created_at`, so an entry appended with an older timestamp would
    // never apply and would be reported as pending forever.
    const folder = buildMigrationFolder([INITIAL]);
    emitForceMigration({ folder, classification, now: 0 });

    const entries = readJournal(folder);

    expect(entries[1]?.when).toBeGreaterThan(entries[0]?.when ?? 0);
  });

  it("refuses to be the first migration in a folder", () => {
    const folder = buildMigrationFolder([]);

    expect(() => emitForceMigration({ folder, classification })).toThrow(
      "drizzle-kit's to generate"
    );
  });
});
