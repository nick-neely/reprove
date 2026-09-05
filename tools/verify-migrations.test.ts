/**
 * The append-only invariant, measured against real Git repositories rather than
 * against a stubbed history: the property is what the diff did, and only Git
 * knows that.
 *
 * Each case builds a throwaway repository holding one journaled migration,
 * branches, and then does to it the thing the verifier exists to catch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyMigrations } from "./verify-migrations.mjs";

interface Violation {
  rule: string;
  message: string;
}

interface Entry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

const DIRECTORY = "packages/control-plane/drizzle";

const repositories: string[] = [];

/** Git with an identity of its own, so no contributor's config can change it. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=verify@example.invalid",
      "-c",
      "user.name=verify",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );

const entry = (idx: number, when: number): Entry => ({
  idx,
  version: "7",
  when,
  tag: `${String(idx).padStart(4, "0")}_fixture`,
  breakpoints: true,
});

const write = (root: string, file: string, contents: string): void => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};

const writeJournal = (root: string, entries: Entry[]): void => {
  write(
    root,
    `${DIRECTORY}/meta/_journal.json`,
    `${JSON.stringify({ version: "7", dialect: "postgresql", entries }, null, 2)}\n`
  );
};

/** A repository whose `main` holds one journaled migration, checked out on a branch. */
const buildRepository = (branch = "feature"): string => {
  const root = mkdtempSync(path.join(tmpdir(), "reprove-history-"));
  repositories.push(root);

  git(root, "init", "-b", "main");
  write(root, `${DIRECTORY}/0000_fixture.sql`, 'CREATE TABLE "run" ();\n');
  write(root, `${DIRECTORY}/meta/0000_snapshot.json`, '{"id":"a"}\n');
  writeJournal(root, [entry(0, 1_700_000_000_000)]);
  git(root, "add", "-A");
  git(root, "commit", "-m", "the initial schema");
  git(root, "checkout", "-b", branch);

  return root;
};

const commit = (root: string, message: string): void => {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
};

const broke = (violations: Violation[], rule: string, fragment = ""): boolean =>
  violations.some(
    (violation) =>
      violation.rule === rule && violation.message.includes(fragment)
  );

describe(verifyMigrations, () => {
  afterEach(() => {
    while (repositories.length > 0) {
      const root = repositories.pop();
      if (root) {
        rmSync(root, { force: true, recursive: true });
      }
    }
  });

  it("passes on the repository it verifies", () => {
    // The real one, against its own merge-base. This is the case CI runs.
    expect(
      verifyMigrations({ rootDir: path.join(import.meta.dirname, "..") })
    ).toStrictEqual([]);
  });

  it("accepts an appended migration", () => {
    const root = buildRepository();
    write(root, `${DIRECTORY}/0001_fixture.sql`, "-- appended\n");
    write(root, `${DIRECTORY}/meta/0001_snapshot.json`, '{"id":"b"}\n');
    writeJournal(root, [
      entry(0, 1_700_000_000_000),
      entry(1, 1_700_000_000_001),
    ]);
    commit(root, "append a migration");

    expect(verifyMigrations({ rootDir: root, env: {} })).toStrictEqual([]);
  });

  it("rejects a modified journaled migration", () => {
    const root = buildRepository();
    write(root, `${DIRECTORY}/0000_fixture.sql`, 'CREATE TABLE "run2" ();\n');
    commit(root, "edit an applied migration");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "migration-file",
        "0000_fixture.sql differs from"
      )
    ).toBeTruthy();
  });

  it("rejects a deleted journaled migration", () => {
    const root = buildRepository();
    rmSync(path.join(root, DIRECTORY, "0000_fixture.sql"));
    commit(root, "delete an applied migration");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "migration-file",
        "is now gone"
      )
    ).toBeTruthy();
  });

  it("rejects a reordered journal", () => {
    const root = buildRepository();
    write(root, `${DIRECTORY}/0001_fixture.sql`, "-- appended\n");
    writeJournal(root, [
      entry(1, 1_700_000_000_001),
      entry(0, 1_700_000_000_000),
    ]);
    commit(root, "reorder the journal");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "journal",
        "reordered or replaced"
      )
    ).toBeTruthy();
  });

  it("rejects a replaced journal entry", () => {
    const root = buildRepository();
    rmSync(path.join(root, DIRECTORY, "0000_fixture.sql"));
    write(root, `${DIRECTORY}/0000_replacement.sql`, "-- different\n");
    writeJournal(root, [
      { ...entry(0, 1_700_000_000_000), tag: "0000_replacement" },
    ]);
    commit(root, "replace the first migration");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "journal",
        "reordered or replaced"
      )
    ).toBeTruthy();
  });

  it("rejects an entry appended with an older timestamp", () => {
    // Drizzle would never apply it, and the boot assertion would call it
    // pending forever.
    const root = buildRepository();
    write(root, `${DIRECTORY}/0001_fixture.sql`, "-- appended\n");
    writeJournal(root, [
      entry(0, 1_700_000_000_000),
      entry(1, 1_600_000_000_000),
    ]);
    commit(root, "append an older migration");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "journal",
        "which is not later than"
      )
    ).toBeTruthy();
  });

  it("rejects two appended entries that are out of order with each other", () => {
    // Both are newer than the baseline, and the second would still never apply:
    // Drizzle compares each migration against the newest `created_at` in the
    // ledger at the moment it runs, which by then is the first of these two.
    const root = buildRepository();
    write(root, `${DIRECTORY}/0001_fixture.sql`, "-- appended\n");
    write(root, `${DIRECTORY}/0002_fixture.sql`, "-- appended too\n");
    writeJournal(root, [
      entry(0, 1_700_000_000_000),
      entry(1, 1_700_000_000_050),
      entry(2, 1_700_000_000_010),
    ]);
    commit(root, "append two migrations out of order");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "journal",
        "which is not later than the 1700000000050 already journaled"
      )
    ).toBeTruthy();
  });

  it("accepts a working tree the checkout gave CRLF line endings", () => {
    // `git show` returns the blob as the repository stores it and `readFileSync`
    // returns the working tree as the checkout wrote it, so under
    // `core.autocrlf=true` an untouched migration would otherwise differ on
    // every line.
    const root = buildRepository();
    write(root, `${DIRECTORY}/0000_fixture.sql`, 'CREATE TABLE "run" ();\r\n');

    expect(verifyMigrations({ rootDir: root, env: {} })).toStrictEqual([]);
  });

  it("rejects a truncated journal", () => {
    const root = buildRepository();
    writeJournal(root, []);
    commit(root, "empty the journal");

    expect(
      broke(
        verifyMigrations({ rootDir: root, env: {} }),
        "journal",
        "a journaled migration was removed"
      )
    ).toBeTruthy();
  });

  it("fails closed when no baseline can be resolved", () => {
    // A shallow clone, a detached checkout with no base branch, a repository
    // with no `main`: each produces an actionable failure rather than a skipped
    // check that proved nothing.
    const root = buildRepository();
    git(root, "branch", "-D", "main");

    const violations = verifyMigrations({ rootDir: root, env: {} });

    expect(
      broke(violations, "baseline", "Fetch the base branch history and rerun")
    ).toBeTruthy();
  });

  it("compares against the merge-base with the pull request's base ref", () => {
    const root = buildRepository();
    // A commit on `main` after the branch point, so `main` itself is the wrong
    // baseline and only the merge-base is the right one.
    git(root, "checkout", "main");
    write(root, "README.md", "unrelated\n");
    commit(root, "an unrelated change on main");
    git(root, "checkout", "feature");
    write(root, `${DIRECTORY}/0000_fixture.sql`, "-- edited\n");
    commit(root, "edit an applied migration");

    const violations = verifyMigrations({
      rootDir: root,
      env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
    });

    expect(broke(violations, "migration-file", "differs from")).toBeTruthy();
  });

  it("compares against the push event's before SHA on a push", () => {
    // `HEAD^` is wrong here: a push may carry several commits, and only the
    // event says where it started.
    const root = buildRepository("main-line");
    const before = git(root, "rev-parse", "HEAD").trim();
    write(root, `${DIRECTORY}/0000_fixture.sql`, "-- edited\n");
    commit(root, "edit an applied migration");
    write(root, "README.md", "and another commit on top\n");
    commit(root, "a second commit in the same push");

    const event = path.join(root, "event.json");
    writeFileSync(event, JSON.stringify({ before }));

    const violations = verifyMigrations({
      rootDir: root,
      env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event },
    });

    expect(broke(violations, "migration-file", "differs from")).toBeTruthy();
  });

  it("fails closed on a push whose event payload is not readable", () => {
    // Without this the run would fall through to the merge-base branch, where
    // on `main` the baseline is HEAD and the history is compared against
    // itself.
    const root = buildRepository("main-line");

    const violations = verifyMigrations({
      rootDir: root,
      env: { GITHUB_EVENT_NAME: "push" },
    });

    expect(
      broke(violations, "baseline", "no usable `before` SHA")
    ).toBeTruthy();
  });

  it("fails closed on a push whose before SHA is the empty one", () => {
    const root = buildRepository();
    const event = path.join(root, "event.json");
    writeFileSync(event, JSON.stringify({ before: "0".repeat(40) }));

    const violations = verifyMigrations({
      rootDir: root,
      env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event },
    });

    expect(
      broke(violations, "baseline", "no usable `before` SHA")
    ).toBeTruthy();
  });

  it("fails closed on a push whose before SHA is not in the clone", () => {
    const root = buildRepository();
    const event = path.join(root, "event.json");
    writeFileSync(event, JSON.stringify({ before: "a".repeat(40) }));

    const violations = verifyMigrations({
      rootDir: root,
      env: { GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event },
    });

    expect(broke(violations, "baseline", "is not in this clone")).toBeTruthy();
  });
});
