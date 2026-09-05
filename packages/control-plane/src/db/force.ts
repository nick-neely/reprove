/**
 * `FORCE ROW LEVEL SECURITY`: the one statement the tenant boundary needs and
 * Drizzle cannot express.
 *
 * [ADR 0017](../../../../docs/adr/0017-authoring-time-tenancy-boundary.md)
 * measured the negative across both packages' `dist` and `.d.ts`: there is no
 * builder method, config field or snapshot field for it in `drizzle-orm@0.45.2`
 * or `drizzle-kit@0.31.10`. So it is **generated from the classification** and
 * appended as a delta into a `generate --custom` migration, and no human ever
 * restates in SQL a fact the classification already carries.
 *
 * Three properties live here, and each is a walk of the committed migration
 * folder rather than an interpretation of arbitrary SQL:
 *
 * ```text
 * kind      which of the three authors owns each migration
 * grammar   a generator-owned file conforms exactly; a hand-authored one may
 *           not touch the tenant boundary at all
 * effect    what the whole journal leaves behind, in order, last write wins:
 *           each table's FORCE state, its RLS enablement, and its policy set
 * ```
 *
 * Effective final state is the property, not textual occurrence: `0001 FORCE`
 * followed by `0002 NO FORCE` leaves the table unforced and fails, which is why
 * this is a walk rather than a search.
 *
 * The effect walk reads **every** migration, whoever wrote it, and that is what
 * closes the gap the grammar alone leaves. The grammar can only say that a
 * drizzle-attributed file is allowed to carry `CREATE POLICY` and `ENABLE ROW
 * LEVEL SECURITY`, because that is what drizzle-kit emits; it cannot say whether
 * the ones in front of it are the ones the schema module asked for. A
 * `DROP POLICY` or a `DISABLE ROW LEVEL SECURITY` edited into a generated file
 * is exactly that shape, and the walk below is where it fails - by leaving a
 * tenant table with a policy set the schema does not justify.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Classification } from "./classification.js";
import { tableName, tableNames } from "./classification.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";
import type { Policy } from "./policy.js";
import {
  canonicalPolicy,
  comparablePolicy,
  describePolicy,
  samePolicy,
} from "./policy.js";

/**
 * The first line of every migration this generator owns. It is what separates a
 * generated file from a hand-authored custom one, and the verifier holds
 * everything under it to the grammar below.
 */
export const FORCE_MARKER = "-- reprove:force-row-level-security";

/**
 * The whole grammar. One statement per line, one table each, no expression and
 * no second clause - which is what lets the walk below be a walk rather than a
 * SQL parser.
 */
const FORCE_STATEMENT =
  /^ALTER TABLE "(?<table>[^"]+)" (?<no>NO )?FORCE ROW LEVEL SECURITY;$/u;

/** One table left forced, or explicitly not, by one generated statement. */
export interface ForceOperation {
  readonly table: string;
  readonly forced: boolean;
}

/** One journaled migration, as the three checks below need to see it. */
export interface MigrationSource {
  readonly idx: number;
  readonly tag: string;
  /** The raw file text, which is also what Drizzle hashes. */
  readonly sql: string;
  /**
   * Who wrote it. `drizzle` advanced the snapshot, so drizzle-kit generated it
   * from the schema module; the other two share their parent's snapshot, and
   * the marker separates them.
   */
  readonly kind: "drizzle" | "generator" | "hand-authored";
}

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface Journal {
  entries: JournalEntry[];
}

/** What a `.json` file holds, which is the only contract a snapshot has here. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * One JSON value in a canonical form, so two snapshots can be compared by
 * content rather than by text.
 *
 * Key order alone is not content: drizzle-kit's `generate --custom` path writes
 * the parent snapshot's own values back out with two top-level keys in a
 * different order, and a comparison over the raw text would read that as a
 * schema change.
 */
const canonical = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  // JSON has no third composite: whatever survives the array branch is either a
  // plain object or a primitive, and `instanceof` separates the two without
  // probing the representation of a value this walker never decoded.
  if (value instanceof Object) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, nested]) => [key, canonical(nested)])
    );
  }
  return value;
};

/** The two fields chained one snapshot to the next, and no two of them share. */
const IDENTITY = new Set(["id", "prevId"]);

/**
 * A snapshot without its identity, which is the only part that differs by
 * construction on every one of them.
 *
 * **Top level only, and that is the whole point of it being a separate step.**
 * A snapshot nests column names as object keys - `tables["public.run"].columns
 * .id` - so a filter applied at every depth would delete the `id` column from
 * both sides of the comparison. A migration whose only change was to that column
 * would then canonicalise equal to its parent, be attributed as custom, and be
 * held to a hand-authored file's rules by a walk that never saw the change.
 *
 * @param snapshot One parsed snapshot.
 * @returns Its content, with `id` and `prevId` removed from the root object.
 */
const withoutIdentity = (snapshot: JsonValue): JsonValue =>
  snapshot instanceof Object && !Array.isArray(snapshot)
    ? Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => !IDENTITY.has(key))
      )
    : snapshot;

/** One snapshot file, reduced to what a comparison of two of them is about. */
const readSnapshot = (file: string): string => {
  // SAFETY: the snapshot is drizzle-kit's own output, committed to this
  // repository. A malformed one throws here, which is a failed check rather
  // than a check that passed over nothing.
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as JsonValue;
  return JSON.stringify(canonical(withoutIdentity(parsed)));
};

/** Who a migration is held to the rules of, from what the folder says about it. */
const kindOf = (custom: boolean, sql: string): MigrationSource["kind"] => {
  if (!custom) {
    return "drizzle";
  }
  return sql.startsWith(FORCE_MARKER) ? "generator" : "hand-authored";
};

/** The journal, which is drizzle-kit's own output and the order of record. */
export const readJournal = (folder: string): JournalEntry[] => {
  // SAFETY: the journal is `drizzle-kit`'s output, committed to this repository
  // and shipped inside the package. A malformed one throws here, which is a
  // failed check rather than a check that passed over nothing.
  const journal = JSON.parse(
    readFileSync(path.join(folder, "meta", "_journal.json"), "utf-8")
  ) as Journal;
  return journal.entries;
};

/** The snapshot drizzle-kit chained to one journal entry. */
export const snapshotFile = (folder: string, idx: number): string =>
  path.join(folder, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`);

/**
 * Every journaled migration in order, each attributed to the author whose rules
 * it is then held to.
 *
 * The attribution is measured rather than declared, because drizzle-kit marks
 * nothing: `generate` writes a snapshot reflecting the new schema, and
 * `generate --custom` writes its parent's content back out unchanged apart from
 * the snapshot's own identity. A migration whose snapshot did not advance is
 * therefore a custom one, and the marker separates the generator's from a
 * human's.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One entry per journal entry, in journal order.
 */
export const readMigrationSources = (
  folder: string = MIGRATIONS_FOLDER
): MigrationSource[] => {
  let previous: string | null = null;

  return readJournal(folder).map((entry) => {
    const sql = readFileSync(path.join(folder, `${entry.tag}.sql`), "utf-8");
    const snapshot = readSnapshot(snapshotFile(folder, entry.idx));
    const custom = previous !== null && snapshot === previous;
    previous = snapshot;

    return { idx: entry.idx, tag: entry.tag, sql, kind: kindOf(custom, sql) };
  });
};

// --- the grammar -------------------------------------------------------------

/**
 * What a hand-authored migration may not contain. This is ADR 0017's denylist,
 * which generalises "may not introduce a table" to "may not touch the tenant
 * boundary": `DROP POLICY` and `DISABLE ROW LEVEL SECURITY` are the same hole in
 * a different doorway.
 *
 * The scan is deliberately blunt - it reads a comment as it reads a statement -
 * because a false rejection here costs a developer one `drizzle-kit generate`
 * and a false acceptance costs an Owner their tenancy.
 */
const FORBIDDEN = [
  [/\bcreate\s+table\b/iu, "CREATE TABLE"],
  [
    /\b(?:enable|disable)\s+row\s+level\s+security\b/iu,
    "ENABLE/DISABLE ROW LEVEL SECURITY",
  ],
  [/\bforce\s+row\s+level\s+security\b/iu, "FORCE/NO FORCE ROW LEVEL SECURITY"],
  [/\b(?:create|alter|drop)\s+policy\b/iu, "CREATE/ALTER/DROP POLICY"],
] as const;

/**
 * The generated file, which is the only thing that ever writes this grammar.
 * {@link parseForceMigration} is its exact inverse, and `force.test.ts` holds
 * the two to that.
 *
 * @param operations The operations to emit, in the order they should apply.
 * @returns The migration file text, trailing newline included.
 */
export const renderForceMigration = (
  operations: readonly ForceOperation[]
): string =>
  `${[
    FORCE_MARKER,
    ...operations.map(
      (operation) =>
        `ALTER TABLE "${operation.table}" ${operation.forced ? "" : "NO "}FORCE ROW LEVEL SECURITY;`
    ),
  ].join("\n")}\n`;

/**
 * A generator-owned migration reduced to the operations it performs, or the
 * reason it is not one.
 *
 * "Exactly", not "contains": a second arbitrary statement may not ride into a
 * file that claims to be generated, because everything downstream of this walk
 * trusts the file to say only what the grammar can say.
 *
 * @param sql The raw file text.
 * @returns The operations in file order, or the first line that broke the
 *   grammar.
 */
export const parseForceMigration = (
  sql: string
): { operations: ForceOperation[] } | { problem: string } => {
  // Line endings are the checkout's business, not the grammar's: a repository
  // cloned with `core.autocrlf` would otherwise fail every generated migration
  // over a carriage return.
  const [marker, ...rest] = sql.split("\n").map((line) => line.trimEnd());
  if (marker !== FORCE_MARKER) {
    return {
      problem: `the first line is ${JSON.stringify(marker ?? "")} rather than the generator marker ${JSON.stringify(FORCE_MARKER)}`,
    };
  }

  const operations: ForceOperation[] = [];
  for (const [offset, line] of rest.entries()) {
    // One trailing newline ends the file; a blank line anywhere else is not
    // something the generator emits, so it is not something this accepts.
    if (line === "" && offset === rest.length - 1) {
      continue;
    }
    const match = FORCE_STATEMENT.exec(line);
    if (!match?.groups) {
      return {
        problem: `line ${offset + 2} is ${JSON.stringify(line)}, which is not a statement the generator emits`,
      };
    }
    operations.push({
      table: match.groups.table ?? "",
      forced: match.groups.no === undefined,
    });
  }

  return operations.length > 0
    ? { operations }
    : { problem: "it carries the marker and no statement" };
};

/**
 * Every migration held to its author's rules.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One message per migration that broke them, empty when the history is
 *   one drizzle-kit generated the schema and one the generator forced it.
 */
export const checkMigrationGrammar = (
  folder: string = MIGRATIONS_FOLDER
): string[] => {
  const problems: string[] = [];

  for (const migration of readMigrationSources(folder)) {
    if (migration.kind === "generator") {
      const parsed = parseForceMigration(migration.sql);
      if ("problem" in parsed) {
        problems.push(
          `${migration.tag} claims the generator's marker but ${parsed.problem}`
        );
      }
      continue;
    }

    for (const [pattern, construct] of FORBIDDEN) {
      // A drizzle-kit generated migration is the schema module's own output, so
      // the first three constructs are exactly what it is for. `FORCE` is not:
      // drizzle-kit cannot emit it, so finding one in a generated file means the
      // file was edited by hand.
      if (
        migration.kind === "drizzle" &&
        construct !== "FORCE/NO FORCE ROW LEVEL SECURITY"
      ) {
        continue;
      }
      if (pattern.test(migration.sql)) {
        problems.push(
          migration.kind === "drizzle"
            ? `${migration.tag} is drizzle-kit generated and contains ${construct}, which drizzle-kit does not emit`
            : `${migration.tag} is hand-authored and contains ${construct}; a hand-authored migration may not touch the tenant boundary. Change the classification and run the FORCE generator instead`
        );
      }
    }
  }

  return problems;
};

// --- the effective state -----------------------------------------------------

/**
 * The FORCE state each table is left in once the whole journal has been applied,
 * in order, with the last relevant operation winning.
 *
 * A table absent from the result was never named by any generated migration.
 * That is a different fact from being named and left `NO FORCE`, and
 * {@link forceStateProblems} reports it differently, because "nobody generated
 * it" and "somebody unforced it" are different mistakes.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns The final state per table, keyed by SQL name.
 */
export const effectiveForceState = (
  folder: string = MIGRATIONS_FOLDER
): Map<string, boolean> => {
  const state = new Map<string, boolean>();

  for (const migration of readMigrationSources(folder)) {
    if (migration.kind !== "generator") {
      continue;
    }
    const parsed = parseForceMigration(migration.sql);
    if ("problem" in parsed) {
      // A file the grammar refuses is reported by `checkMigrationGrammar`, and
      // reading operations out of it here would be reading a file that has
      // already been established to mean nothing.
      continue;
    }
    for (const operation of parsed.operations) {
      state.set(operation.table, operation.forced);
    }
  }

  return state;
};

/**
 * The delta between what the classification says and what the migration history
 * has already established, which is the whole of what a new generated migration
 * would contain.
 *
 * Symmetric in both directions, because a tenant to non-tenant reclassification
 * is security-significant and leaving the old `FORCE` in place would be the
 * classification and the database disagreeing:
 *
 * ```text
 * tenant     && !forced  ->  FORCE ROW LEVEL SECURITY
 * non-tenant &&  forced  ->  NO FORCE ROW LEVEL SECURITY
 * already matching       ->  nothing
 * ```
 *
 * @param classification The classification the delta is derived from.
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns The operations to append, sorted by table name, empty when the
 *   history already agrees with the classification.
 */
export const forceDelta = (
  classification: Classification,
  folder: string = MIGRATIONS_FOLDER
): ForceOperation[] => {
  const state = effectiveForceState(folder);
  const wanted = new Map<string, boolean>([
    ...tableNames(classification.nonTenant).map((table): [string, boolean] => [
      table,
      false,
    ]),
    ...tableNames(classification.tenant).map((table): [string, boolean] => [
      table,
      true,
    ]),
  ]);

  return [...wanted]
    .filter(([table, forced]) => (state.get(table) ?? false) !== forced)
    .map(([table, forced]) => ({ table, forced }))
    .toSorted((a, b) => (a.table < b.table ? -1 : 1));
};

/**
 * The classification and the migration history, cross-checked.
 *
 * This is the authoring-time half of ADR 0008's fourth boot check. The boot
 * assertion reads `relforcerowsecurity` and sees what a database actually has;
 * this one reads the history and sees whether the pull request would ever have
 * given it one.
 *
 * @param classification The classification to measure against.
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One message per table whose forced state does not follow from its
 *   classification, empty when the delta is empty.
 */
export const forceStateProblems = (
  classification: Classification,
  folder: string = MIGRATIONS_FOLDER
): string[] => {
  const state = effectiveForceState(folder);

  const unforced = tableNames(classification.tenant)
    .filter((table) => state.get(table) !== true)
    .map((table) =>
      state.has(table)
        ? `${table} is tenant-scoped and the last generated operation on it is NO FORCE ROW LEVEL SECURITY`
        : `${table} is tenant-scoped and no generated migration forces row-level security on it`
    );

  const forced = tableNames(classification.nonTenant)
    .filter((table) => state.get(table) === true)
    .map(
      (table) =>
        `${table} is non-tenant and the last generated operation on it is FORCE ROW LEVEL SECURITY`
    );

  const problems = [...unforced, ...forced];
  return problems.length > 0
    ? problems.map(
        (problem) =>
          `${problem}. Run \`pnpm --filter @reprove/control-plane db:force\` to append the delta`
      )
    : problems;
};

// --- the boundary the whole history leaves behind ----------------------------

/**
 * One SQL expression's worth of quoting rules, applied to a whole file: string
 * literals and quoted identifiers are copied verbatim, `--` comments are
 * dropped, and every run of whitespace outside a literal becomes one space.
 *
 * Statements are then split on `;`, which is safe **because** the split happens
 * after the scan: a semicolon inside a literal never reaches it. Collapsing
 * whitespace outside literals rather than everywhere is the same distinction
 * `predicate.ts` draws, and for the same reason - what is inside a literal is
 * data, and two spaces there are not one.
 *
 * @param sql One migration file.
 * @returns Its statements, whitespace-normalised, without their terminators.
 */
const statements = (sql: string): string[] => {
  let flattened = "";
  let index = 0;

  const copyQuoted = (quote: string) => {
    let end = index + 1;
    while (end < sql.length) {
      if (sql[end] === quote) {
        if (sql[end + 1] === quote) {
          end += 2;
          continue;
        }
        break;
      }
      end += 1;
    }
    flattened += sql.slice(index, Math.min(end + 1, sql.length));
    index = end + 1;
  };

  while (index < sql.length) {
    const character = sql[index] ?? "";
    if (character === "'" || character === '"') {
      copyQuoted(character);
    } else if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
    } else if (/\s/u.test(character)) {
      if (!flattened.endsWith(" ")) {
        flattened += " ";
      }
      index += 1;
    } else {
      flattened += character;
      index += 1;
    }
  }

  return flattened
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
};

/** The statements that move the tenant boundary, in the forms drizzle-kit emits. */
const CREATE_POLICY =
  /^CREATE POLICY "(?<name>[^"]+)" ON "(?<table>[^"]+)" AS (?<as>PERMISSIVE|RESTRICTIVE) FOR (?<command>[A-Z]+) TO (?<roles>.+?) USING \((?<using>.*)\) WITH CHECK \((?<withCheck>.*)\)$/iu;
const ALTER_POLICY =
  /^ALTER POLICY "(?<name>[^"]+)" ON "(?<table>[^"]+)" TO (?<roles>.+?) USING \((?<using>.*)\) WITH CHECK \((?<withCheck>.*)\)$/iu;
const DROP_POLICY =
  /^DROP POLICY "(?<name>[^"]+)" ON "(?<table>[^"]+)"(?: CASCADE| RESTRICT)?$/iu;
const ROW_SECURITY =
  /^ALTER TABLE "(?<table>[^"]+)" (?<action>ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY$/iu;

/** Anything naming one of them, which is the set the walk may not skip. */
const TOUCHES_BOUNDARY = /\bpolicy\b|\brow level security\b/iu;

/** The role list a policy statement grants to, as the catalog would hold it. */
const parseRoles = (roles: string): string[] =>
  roles
    .split(",")
    .map((role) => role.trim().replace(/^"(?<bare>.*)"$/u, "$<bare>"));

/** Where the boundary stands once every migration has been read, in order. */
interface EffectiveBoundary {
  /** Every policy in force at the end of history, keyed by SQL table name. */
  readonly policies: Map<string, Policy[]>;
  /** Whether row-level security is enabled, keyed by SQL table name. */
  readonly enabled: Map<string, boolean>;
  /** Statements the walk could not interpret, which are failures, not skips. */
  readonly problems: string[];
}

/** A policy as a migration spells it, before the predicates are reduced. */
interface WrittenPolicy {
  readonly name: string;
  readonly table: string;
  /** Absent on `ALTER POLICY`, which carries no `AS` or `FOR` clause. */
  readonly permissive?: boolean;
  readonly command?: string;
  readonly roles: string[];
  readonly using: string;
  readonly withCheck: string;
}

/** One statement, as the effective state needs to see it. */
type BoundaryStatement =
  | { readonly rowSecurity: { table: string; enabled: boolean } }
  | { readonly dropped: { table: string; name: string } }
  | { readonly written: WrittenPolicy }
  | { readonly touches: boolean };

/**
 * `ALTER TABLE ... ROW LEVEL SECURITY`, which is two statements wearing one
 * shape. `FORCE` and `NO FORCE` are read by {@link effectiveForceState}; they
 * are matched here only so they are not mistaken for something unreadable.
 */
const readRowSecurity = (
  groups: Record<string, string | undefined>
): BoundaryStatement => {
  const action = (groups.action ?? "").toUpperCase();
  if (action === "ENABLE" || action === "DISABLE") {
    return {
      rowSecurity: { table: groups.table ?? "", enabled: action === "ENABLE" },
    };
  }
  return { touches: false };
};

/** `CREATE POLICY` or `ALTER POLICY`, which differ only in what they carry. */
const readWrittenPolicy = (statement: string): WrittenPolicy | null => {
  const created = CREATE_POLICY.exec(statement)?.groups;
  const groups = created ?? ALTER_POLICY.exec(statement)?.groups;
  if (!groups) {
    return null;
  }
  return {
    name: groups.name ?? "",
    table: groups.table ?? "",
    permissive: created && (created.as ?? "").toUpperCase() !== "RESTRICTIVE",
    command: created?.command?.toLowerCase(),
    roles: parseRoles(groups.roles ?? ""),
    using: groups.using ?? "",
    withCheck: groups.withCheck ?? "",
  };
};

/**
 * One statement read as an operation on the boundary, or as something that does
 * not touch it.
 *
 * `touches: true` is the fail-closed case: the statement names a policy or
 * row-level security in a form none of the four patterns matched, and the caller
 * reports it rather than passing over it.
 */
const readBoundaryStatement = (statement: string): BoundaryStatement => {
  const security = ROW_SECURITY.exec(statement)?.groups;
  if (security) {
    return readRowSecurity(security);
  }

  const dropped = DROP_POLICY.exec(statement)?.groups;
  if (dropped) {
    return {
      dropped: { table: dropped.table ?? "", name: dropped.name ?? "" },
    };
  }

  const written = readWrittenPolicy(statement);
  return written === null
    ? { touches: TOUCHES_BOUNDARY.test(statement) }
    : { written };
};

/**
 * The policy set one statement leaves on its table, or the reason the statement
 * could not be reduced to one.
 *
 * `ALTER POLICY` carries no `AS` or `FOR` clause, so those two facts come from
 * the policy it alters. A policy altered before it exists is SQL that would fail
 * to apply, and its missing halves are reported rather than invented.
 */
const applyWrittenPolicy = (
  existing: Policy[],
  written: WrittenPolicy
): { policies: Policy[] } | { problem: string } => {
  const kept = existing.filter((policy) => policy.name !== written.name);
  const previous = existing.find((policy) => policy.name === written.name);
  const permissive = written.permissive ?? previous?.permissive;
  const command = written.command ?? previous?.command;

  if (permissive === undefined || command === undefined) {
    return {
      problem: `${written.table}'s policy ${written.name} is altered before it is created, so what it is being altered from is not in this history`,
    };
  }

  const built = comparablePolicy(written.table, {
    name: written.name,
    permissive,
    command,
    roles: written.roles,
    using: written.using,
    withCheck: written.withCheck,
  });
  return "problem" in built ? built : { policies: [...kept, built.policy] };
};

/**
 * The policy set and RLS enablement the whole journal leaves behind.
 *
 * Every migration is read, whoever wrote it. Attribution decides which rules a
 * *file* is held to; it does not decide whether a statement counts, because a
 * `DROP POLICY` drops the policy just as thoroughly in a file drizzle-kit
 * generated as in one nobody should have written.
 *
 * A boundary statement the walk cannot parse is a **problem**, never a skip.
 * The measurement is only worth what its coverage is worth, and a form nobody
 * anticipated is exactly where a silent gap would sit.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns The state at the end of history, and every statement that refused to
 *   be read.
 */
export const effectiveBoundary = (
  folder: string = MIGRATIONS_FOLDER
): EffectiveBoundary => {
  const policies = new Map<string, Policy[]>();
  const enabled = new Map<string, boolean>();
  const problems: string[] = [];

  for (const migration of readMigrationSources(folder)) {
    for (const statement of statements(migration.sql)) {
      const read = readBoundaryStatement(statement);

      if ("rowSecurity" in read) {
        enabled.set(read.rowSecurity.table, read.rowSecurity.enabled);
      } else if ("dropped" in read) {
        const { table, name } = read.dropped;
        policies.set(
          table,
          (policies.get(table) ?? []).filter((policy) => policy.name !== name)
        );
      } else if ("written" in read) {
        const applied = applyWrittenPolicy(
          policies.get(read.written.table) ?? [],
          read.written
        );
        if ("problem" in applied) {
          problems.push(`${migration.tag}: ${applied.problem}`);
        } else {
          policies.set(read.written.table, applied.policies);
        }
      } else if (read.touches) {
        problems.push(
          `${migration.tag} carries a boundary statement this walk cannot read: ${statement}. Every statement that moves a policy or row-level security has to be one the check can compare against the schema module`
        );
      }
    }
  }

  return { policies, enabled, problems };
};

/**
 * The migration history and the schema module, cross-checked on the two facts
 * `FORCE` is defense in depth beside.
 *
 * This is what makes a drizzle-attributed migration trustworthy rather than
 * trusted. `checkMigrationGrammar` lets such a file carry `CREATE POLICY` and
 * `ENABLE ROW LEVEL SECURITY`, because that is drizzle-kit's own output; only
 * this check knows whether the statements in it are the ones the schema module
 * asked for. A `DROP POLICY` or `DISABLE ROW LEVEL SECURITY` edited into one
 * fails here, at authoring time, rather than waiting for the live-catalog check
 * at boot.
 *
 * @param classification The classification to measure against.
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One message per table the history leaves outside its classification.
 */
export const boundaryProblems = (
  classification: Classification,
  folder: string = MIGRATIONS_FOLDER
): string[] => {
  const { policies, enabled, problems } = effectiveBoundary(folder);
  const found = [...problems];

  for (const table of classification.tenant) {
    const name = tableName(table);
    const applied = policies.get(name) ?? [];
    const [only, ...extra] = applied;

    if (only === undefined || extra.length > 0) {
      found.push(
        `${name} is tenant-scoped and the migration history leaves ${applied.length} policies on it, not exactly the canonical one: ${applied.map((policy) => policy.name).join(", ") || "none"}`
      );
    } else if (!samePolicy(only, canonicalPolicy(table))) {
      found.push(
        `${name} is left carrying ${describePolicy(only)} where the schema module declares ${describePolicy(canonicalPolicy(table))}`
      );
    }

    if (enabled.get(name) !== true) {
      found.push(
        `${name} is tenant-scoped and the migration history does not leave row-level security enabled on it`
      );
    }
  }

  for (const table of classification.nonTenant) {
    const name = tableName(table);
    const applied = policies.get(name) ?? [];
    if (applied.length > 0) {
      found.push(
        `${name} is non-tenant and the migration history leaves ${applied.map((policy) => policy.name).join(", ")} on it`
      );
    }
    if (enabled.get(name) === true) {
      found.push(
        `${name} is non-tenant and the migration history leaves row-level security enabled on it, which the schema module does not ask for`
      );
    }
  }

  return found;
};
