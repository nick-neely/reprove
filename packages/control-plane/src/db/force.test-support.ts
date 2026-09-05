/**
 * Migration folders in drizzle-kit's shape, built for a test to break.
 *
 * Shared by `force.test.ts` and `force-generate.test.ts` rather than written
 * twice, and not shipped: `tsconfig.build.json` keeps it out of `dist`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

/** A column as a snapshot holds it, in as much detail as a fixture needs. */
interface SnapshotColumn {
  readonly type?: string;
  readonly default?: string;
}

/** A table as a snapshot holds it, with its columns keyed by name. */
interface SnapshotTable {
  readonly columns?: Record<string, SnapshotColumn>;
}

/** One migration as a fixture writes it: its text, and whether it is custom. */
export interface Fixture {
  readonly sql: string;
  /** A custom migration shares its parent's snapshot; a generated one does not. */
  readonly custom?: boolean;
  /**
   * The snapshot's `tables`, spelled out. Only a fixture that cares what
   * *changed* inside the snapshot needs this; every other one lets `custom`
   * decide whether the snapshot advances.
   */
  readonly tables?: Record<string, SnapshotTable>;
}

const temporaryFolders: string[] = [];

/**
 * A migration folder in drizzle-kit's shape: a journal, one snapshot per entry
 * chained by id, and one `.sql` file each. The snapshot's `tables` is what
 * separates a generated migration from a custom one, because that is the
 * distinction the reader measures rather than a marker it trusts.
 */
export const buildMigrationFolder = (fixtures: readonly Fixture[]): string => {
  const folder = mkdtempSync(path.join(tmpdir(), "reprove-migrations-"));
  temporaryFolders.push(folder);
  mkdirSync(path.join(folder, "meta"));

  const entries = fixtures.map((fixture, idx) => ({
    idx,
    version: "7",
    when: 1_700_000_000_000 + idx,
    tag: `${String(idx).padStart(4, "0")}_fixture`,
    breakpoints: true,
  }));

  let generations = 0;
  for (const [idx, fixture] of fixtures.entries()) {
    if (!fixture.custom) {
      generations += 1;
    }
    writeFileSync(path.join(folder, `${entries[idx]?.tag}.sql`), fixture.sql);
    writeFileSync(
      path.join(
        folder,
        "meta",
        `${String(idx).padStart(4, "0")}_snapshot.json`
      ),
      JSON.stringify({
        id: `id-${idx}`,
        prevId: `id-${idx - 1}`,
        version: "7",
        dialect: "postgresql",
        tables:
          fixture.tables ??
          Object.fromEntries(
            Array.from({ length: generations }, (_, n) => [`public.t${n}`, {}])
          ),
      })
    );
  }

  writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries })
  );
  return folder;
};

/**
 * The canonical tenant policy on `run`, **copied verbatim** from
 * `0000_initial_schema.sql`. It is drizzle-kit's own output rather than a
 * rendering, which is what makes a fixture built from it a fixture about the
 * real statement shape rather than about this file's idea of one.
 */
export const RUN_TENANT_POLICY = `CREATE POLICY "run_tenant" ON "run" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING ("run"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint) WITH CHECK ("run"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint);`;

/** The initial drizzle-kit generation, in the details that matter here. */
export const INITIAL: Fixture = {
  sql: [
    'CREATE TABLE "run" (\n\t"id" uuid PRIMARY KEY,\n\t"owner_id" bigint NOT NULL\n);',
    "--> statement-breakpoint",
    'CREATE TABLE "user" (\n\t"id" text PRIMARY KEY\n);',
    "--> statement-breakpoint",
    'ALTER TABLE "run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint',
    RUN_TENANT_POLICY,
    "",
  ].join("\n"),
};

/** One generated migration, in the canonical grammar the generator emits. */
export const generated = (...lines: string[]): Fixture => ({
  sql: `-- reprove:force-row-level-security\n${lines.join("\n")}\n`,
  custom: true,
});

/**
 * Removes every folder built during the file that calls it. A test file opts in
 * once at the top level, so a folder cannot outlive the run that made it.
 */
export const discardMigrationFolders = (): void => {
  afterEach(() => {
    while (temporaryFolders.length > 0) {
      const folder = temporaryFolders.pop();
      if (folder) {
        rmSync(folder, { force: true, recursive: true });
      }
    }
  });
};
