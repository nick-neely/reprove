/**
 * The generated half of the tenant boundary, measured over migration folders
 * built for the purpose.
 *
 * The committed folder is one correct history, and a correct history cannot
 * demonstrate a refusal. The failures
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)
 * names - a `FORCE` later withdrawn by a `NO FORCE`, a hand-authored migration
 * reaching for the tenant boundary, a second statement riding into a file that
 * claims the generator's marker - are therefore each assembled here as a
 * throwaway folder in the same shape drizzle-kit writes.
 */
import { describe, expect, it } from "vitest";

import type { Classification } from "./classification.js";
import { CLASSIFICATION, tableNames, TENANT_TABLES } from "./classification.js";
import {
  boundaryProblems,
  checkMigrationGrammar,
  effectiveForceState,
  forceDelta,
  forceStateProblems,
  parseForceMigration,
  readMigrationSources,
  renderForceMigration,
} from "./force.js";
import {
  buildMigrationFolder,
  discardMigrationFolders,
  generated,
  INITIAL,
  RUN_TENANT_POLICY,
} from "./force.test-support.js";
import * as schema from "./schema.js";

discardMigrationFolders();

/** `run` is Owner-scoped and `user` is Better Auth's, deliberately outside it. */
const classification: Classification = {
  managed: [schema.run, schema.user],
  tenant: [schema.run],
  nonTenant: [schema.user],
};

describe("the committed migration history", () => {
  it("is drizzle-kit generations and the generated FORCE delta, in order", () => {
    expect(
      readMigrationSources().map((migration) => [migration.tag, migration.kind])
    ).toStrictEqual([
      ["0000_initial_schema", "drizzle"],
      ["0001_force_row_level_security", "generator"],
      // Better Auth's `account` model gained `issuer`, `id_token` and
      // `password`; the tables were already classified, so the generator had
      // nothing to append after it.
      ["0002_better_auth_account_model", "drizzle"],
    ]);
  });

  it("conforms to the grammar each of its authors owns", () => {
    expect(checkMigrationGrammar()).toStrictEqual([]);
  });

  it("leaves exactly the Owner-scoped tables forced", () => {
    expect(
      [...effectiveForceState()]
        .filter(([, forced]) => forced)
        .map(([table]) => table)
        .toSorted()
    ).toStrictEqual(tableNames(TENANT_TABLES));
  });

  it("has nothing left for the generator to append", () => {
    expect(forceStateProblems(CLASSIFICATION)).toStrictEqual([]);
    expect(forceDelta(CLASSIFICATION)).toStrictEqual([]);
  });

  it("leaves every tenant table carrying exactly the declared policy", () => {
    // The committed migrations against the schema module, with no database
    // between them: what drizzle-kit emitted in 0000 is compared to what the
    // pinned dialect renders for the classification today.
    expect(boundaryProblems(CLASSIFICATION)).toStrictEqual([]);
  });
});

describe(boundaryProblems, () => {
  it("passes on a history that says what the schema module says", () => {
    expect(
      boundaryProblems(classification, buildMigrationFolder([INITIAL]))
    ).toStrictEqual([]);
  });

  it("fails a DROP POLICY edited into a drizzle-generated migration", () => {
    // The grammar cannot catch this: a drizzle-attributed file is allowed to
    // carry policy statements, because that is what drizzle-kit emits. Only the
    // effective state knows the schema module never asked for the drop.
    const folder = buildMigrationFolder([
      { sql: `${INITIAL.sql}DROP POLICY "run_tenant" ON "run" CASCADE;\n` },
    ]);

    expect(checkMigrationGrammar(folder)).toStrictEqual([]);
    expect(boundaryProblems(classification, folder).join("; ")).toContain(
      "run is tenant-scoped and the migration history leaves 0 policies on it"
    );
  });

  it("fails a DISABLE ROW LEVEL SECURITY edited into one", () => {
    const folder = buildMigrationFolder([
      {
        sql: `${INITIAL.sql}ALTER TABLE "run" DISABLE ROW LEVEL SECURITY;\n`,
      },
    ]);

    expect(boundaryProblems(classification, folder).join("; ")).toContain(
      "does not leave row-level security enabled on it"
    );
  });

  it("fails a second permissive policy created beside the canonical one", () => {
    const folder = buildMigrationFolder([
      {
        sql: `${INITIAL.sql}CREATE POLICY "run_admin" ON "run" AS PERMISSIVE FOR ALL TO "reprove_runtime" USING (true) WITH CHECK (true);\n`,
      },
    ]);

    expect(boundaryProblems(classification, folder).join("; ")).toContain(
      "leaves 2 policies on it, not exactly the canonical one"
    );
  });

  it("fails a policy re-created with ADR 0008's bare cast", () => {
    const folder = buildMigrationFolder([
      {
        sql: `${INITIAL.sql}DROP POLICY "run_tenant" ON "run" CASCADE;--> statement-breakpoint\n${RUN_TENANT_POLICY.replaceAll(
          "nullif(current_setting('app.owner_id', true), '')::bigint",
          "current_setting('app.owner_id', true)::bigint"
        )}\n`,
      },
    ]);

    expect(boundaryProblems(classification, folder).join("; ")).toContain(
      "where the schema module declares"
    );
  });

  it("fails a policy left on a non-tenant table", () => {
    const folder = buildMigrationFolder([
      {
        sql: `${INITIAL.sql}${RUN_TENANT_POLICY.replaceAll('"run"', '"user"').replaceAll("run_tenant", "user_tenant")}\n`,
      },
    ]);

    expect(boundaryProblems(classification, folder).join("; ")).toContain(
      "user is non-tenant and the migration history leaves user_tenant on it"
    );
  });

  it("refuses to skip a boundary statement it cannot read", () => {
    // A form nobody anticipated is exactly where a silent gap would sit, so an
    // unreadable statement is a failure rather than a statement that did
    // nothing.
    const folder = buildMigrationFolder([
      { sql: `${INITIAL.sql}CREATE POLICY "run_odd" ON "run" FOR SELECT;\n` },
    ]);

    expect(boundaryProblems(classification, folder).join("; ")).toContain(
      "carries a boundary statement this walk cannot read"
    );
  });
});

describe(parseForceMigration, () => {
  it("is the exact inverse of what the generator renders", () => {
    const operations = [
      { table: "run", forced: true },
      { table: "user", forced: false },
    ];

    expect(parseForceMigration(renderForceMigration(operations))).toStrictEqual(
      {
        operations,
      }
    );
  });

  it("refuses a second statement riding into a generated file", () => {
    const parsed = parseForceMigration(
      '-- reprove:force-row-level-security\nALTER TABLE "run" FORCE ROW LEVEL SECURITY;\nDROP POLICY "run_tenant" ON "run";\n'
    );

    expect(parsed).toHaveProperty("problem");
  });

  it("refuses a file carrying the marker and nothing else", () => {
    expect(
      parseForceMigration("-- reprove:force-row-level-security\n")
    ).toHaveProperty("problem");
  });
});

describe(effectiveForceState, () => {
  it("takes the last operation in journal order, not the first", () => {
    // Effective final state is the property, not textual occurrence: a `FORCE`
    // is present in this history and the table is not forced.
    const folder = buildMigrationFolder([
      INITIAL,
      generated('ALTER TABLE "run" FORCE ROW LEVEL SECURITY;'),
      generated('ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;'),
    ]);

    expect(effectiveForceState(folder).get("run")).toBeFalsy();
    expect(forceStateProblems(classification, folder).join("; ")).toContain(
      "the last generated operation on it is NO FORCE ROW LEVEL SECURITY"
    );
  });

  it("distinguishes a table nobody forced from one somebody unforced", () => {
    const folder = buildMigrationFolder([INITIAL]);

    expect(forceStateProblems(classification, folder).join("; ")).toContain(
      "no generated migration forces row-level security on it"
    );
  });

  it("fails a non-tenant table the history leaves forced", () => {
    const folder = buildMigrationFolder([
      INITIAL,
      generated(
        'ALTER TABLE "run" FORCE ROW LEVEL SECURITY;',
        'ALTER TABLE "user" FORCE ROW LEVEL SECURITY;'
      ),
    ]);

    expect(forceStateProblems(classification, folder).join("; ")).toContain(
      "user is non-tenant and the last generated operation on it is FORCE"
    );
  });

  it("names the delta the generator would append, in both directions", () => {
    const folder = buildMigrationFolder([
      INITIAL,
      generated('ALTER TABLE "user" FORCE ROW LEVEL SECURITY;'),
    ]);

    expect(forceDelta(classification, folder)).toStrictEqual([
      { table: "run", forced: true },
      { table: "user", forced: false },
    ]);
  });
});

describe(checkMigrationGrammar, () => {
  it("accepts a hand-authored migration that stays away from the boundary", () => {
    const folder = buildMigrationFolder([
      INITIAL,
      { sql: 'UPDATE "run" SET "status" = \'queued\';\n', custom: true },
    ]);

    expect(checkMigrationGrammar(folder)).toStrictEqual([]);
  });

  it.each([
    ['CREATE TABLE "extra" ("id" uuid PRIMARY KEY);', "CREATE TABLE"],
    [
      'ALTER TABLE "extra" ENABLE ROW LEVEL SECURITY;',
      "ENABLE/DISABLE ROW LEVEL SECURITY",
    ],
    [
      'ALTER TABLE "run" DISABLE ROW LEVEL SECURITY;',
      "ENABLE/DISABLE ROW LEVEL SECURITY",
    ],
    [
      'ALTER TABLE "run" NO FORCE ROW LEVEL SECURITY;',
      "FORCE/NO FORCE ROW LEVEL SECURITY",
    ],
    ['DROP POLICY "run_tenant" ON "run";', "CREATE/ALTER/DROP POLICY"],
  ])("rejects a hand-authored migration containing %s", (statement, named) => {
    const folder = buildMigrationFolder([
      INITIAL,
      { sql: `${statement}\n`, custom: true },
    ]);

    expect(checkMigrationGrammar(folder).join("; ")).toContain(
      `is hand-authored and contains ${named}`
    );
  });

  it("rejects a generator-owned migration that breaks the grammar", () => {
    const folder = buildMigrationFolder([
      INITIAL,
      {
        sql: '-- reprove:force-row-level-security\nALTER TABLE "run" FORCE ROW LEVEL SECURITY;\nTRUNCATE "run";\n',
        custom: true,
      },
    ]);

    expect(checkMigrationGrammar(folder).join("; ")).toContain(
      "claims the generator's marker but line 3"
    );
  });

  it("attributes a migration that changed only a column named id to drizzle-kit", () => {
    // A snapshot nests column names as object keys, so stripping `id` at every
    // depth would delete the changed column from both sides and read this as a
    // migration that changed nothing - which would hold drizzle-kit's own
    // output to a hand-authored file's rules.
    const folder = buildMigrationFolder([
      {
        sql: 'CREATE TABLE "run" ("id" uuid PRIMARY KEY);\n',
        tables: { "public.run": { columns: { id: { type: "uuid" } } } },
      },
      {
        sql: 'ALTER TABLE "run" ALTER COLUMN "id" SET DATA TYPE text;\n',
        tables: { "public.run": { columns: { id: { type: "text" } } } },
      },
    ]);

    expect(
      readMigrationSources(folder).map((migration) => migration.kind)
    ).toStrictEqual(["drizzle", "drizzle"]);
    expect(checkMigrationGrammar(folder)).toStrictEqual([]);
  });

  it("still reads a snapshot that changed nothing at all as custom", () => {
    // The other side of the same rule: identity aside, an unchanged snapshot is
    // what makes a migration a custom one.
    const folder = buildMigrationFolder([
      {
        sql: 'CREATE TABLE "run" ("id" uuid PRIMARY KEY);\n',
        tables: { "public.run": { columns: { id: { type: "uuid" } } } },
      },
      {
        sql: 'UPDATE "run" SET "id" = "id";\n',
        tables: { "public.run": { columns: { id: { type: "uuid" } } } },
      },
    ]);

    expect(
      readMigrationSources(folder).map((migration) => migration.kind)
    ).toStrictEqual(["drizzle", "hand-authored"]);
  });

  it("rejects a FORCE hand-edited into a drizzle-kit generated migration", () => {
    // drizzle-kit cannot emit `FORCE ROW LEVEL SECURITY` - the measurement ADR
    // 0017 rests on - so finding one in a generated file means the file was
    // edited, which the append-only invariant forbids outright.
    const folder = buildMigrationFolder([
      { sql: `${INITIAL.sql}ALTER TABLE "run" FORCE ROW LEVEL SECURITY;\n` },
    ]);

    expect(checkMigrationGrammar(folder).join("; ")).toContain(
      "is drizzle-kit generated and contains FORCE/NO FORCE ROW LEVEL SECURITY"
    );
  });
});
