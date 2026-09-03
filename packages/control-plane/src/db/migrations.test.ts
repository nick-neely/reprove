/**
 * The migration folder as a **runtime asset of this package**
 * ([ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)).
 *
 * The boot assertion joins the hashes Drizzle stored against the files that
 * produced them, so the files have to travel with the package and be findable
 * from wherever it was installed. The prototype read them relative to
 * `process.cwd()`, which is already fragile and would break in the deployed
 * Next.js application.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER, readCommittedMigrations } from "./migrations.js";

const packageRoot = path.resolve(import.meta.dirname, "..", "..");

describe("the committed migrations", () => {
  it("resolve against the package rather than the working directory", () => {
    expect(path.isAbsolute(MIGRATIONS_FOLDER)).toBeTruthy();
    expect(MIGRATIONS_FOLDER).toBe(path.join(packageRoot, "drizzle"));
  });

  it("are the drizzle-kit generation followed by the generated FORCE delta", () => {
    const committed = readCommittedMigrations();

    expect(committed.map((migration) => migration.tag)).toStrictEqual([
      "0000_initial_schema",
      "0001_force_row_level_security",
    ]);
    // The hash is `sha256(entire raw .sql file)`, which is what `migrate()`
    // writes as the ledger's `hash` and what check six joins against.
    for (const migration of committed) {
      expect(migration.hash).toMatch(/^[\da-f]{64}$/u);
      expect(migration.folderMillis).toBeGreaterThan(0);
    }
  });
});
