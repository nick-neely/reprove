#!/usr/bin/env node
/**
 * Migration history is append-only, and
 * [ADR 0017](../docs/adr/0017-authoring-time-tenancy-boundary.md) makes that a
 * hard invariant rather than a convention.
 *
 * `PgDialect.migrate` reads only the newest `created_at` from
 * `__drizzle_migrations` and applies every migration past it. It writes a `hash`
 * column and **never reads it**:
 *
 * ```text
 * applied migration edited
 *   -> Drizzle does not compare the stored hash
 *   -> does not reapply
 *   -> every existing database silently retains the old DDL, indefinitely
 * ```
 *
 * No error, no warning, no drift signal. `drizzle-kit check` does not catch it
 * either - it validates snapshot version, well-formedness and parent-id
 * collisions, with no database connection. So a journaled migration may not be
 * modified, deleted, reordered or replaced, and this is where that is measured.
 *
 * It is a **repository-history** property rather than package behaviour, which
 * is why it is a Git-aware verifier of its own rather than a Vitest file: the
 * question is what the diff did, and a test that imported the migration folder
 * could only see where it ended up. It does not live in
 * `tools/verify-workspace.mjs` either, whose charter is ADR 0010's package
 * graph.
 *
 * Run as `node tools/verify-migrations.mjs`. It prints every violation, then
 * exits 1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The migration folders under this rule, relative to the repository root. Named
 * rather than discovered: a folder Drizzle manages is a decision, and one that
 * appeared without an edit here is one nobody made.
 */
const MIGRATION_DIRECTORIES = ["packages/control-plane/drizzle"];

/** drizzle-kit's own index of what has been journaled, and in what order. */
const JOURNAL = "meta/_journal.json";

/** A `before` SHA GitHub sends when there is no preceding commit. */
const EMPTY_SHA = "0".repeat(40);

/**
 * What a failure says to do about it. The verifier **fails closed**: an
 * unresolvable baseline is a violation rather than a skipped check, so a shallow
 * clone produces an actionable failure instead of a green run that proved
 * nothing.
 */
const FETCH_INSTRUCTION =
  "Fetch the base branch history and rerun: `git fetch --no-tags origin +refs/heads/*:refs/remotes/origin/*` locally, or `fetch-depth: 0` on actions/checkout in CI.";

const git = (rootDir, args) =>
  execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A git invocation whose failure is an answer rather than an error. */
const gitOrNull = (rootDir, args) => {
  try {
    return git(rootDir, args);
  } catch {
    return null;
  }
};

/**
 * The commit a push started from, as the event payload spells it.
 *
 * Parsed to an object-id-shaped string or to nothing, rather than narrowed with
 * a `typeof`: the payload is the runner's, this process did not write it, and
 * the only value it may act on is one that could name a commit. GitHub sends the
 * all-zero SHA where there is no preceding commit, which is a payload that
 * parses and still says nothing.
 *
 * @param {string} file The path GITHUB_EVENT_PATH names.
 * @returns {string | null} The `before` SHA, or null where there is none.
 */
const pushedFrom = (file) => {
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
  const before = String(payload?.before ?? "");
  return /^[\da-f]{40}$/u.test(before) && before !== EMPTY_SHA ? before : null;
};

const revision = (rootDir, name) => {
  const resolved = gitOrNull(rootDir, [
    "rev-parse",
    "--verify",
    `${name}^{commit}`,
  ]);
  return resolved === null ? null : resolved.trim();
};

/**
 * The commit this branch's migration folder must still agree with.
 *
 * Three sources, because the right baseline is a different commit in each
 * context, and `HEAD^` is wrong in all of them - a push may carry several
 * commits, and a pull request's first parent is not its base:
 *
 * ```text
 * pull_request   merge-base with the base ref
 * push to main   the push event's `before` SHA
 * local          merge-base with origin/main, or main
 * ```
 *
 * @param {string} rootDir The repository to resolve in.
 * @param {Record<string, string | undefined>} env The environment to read the
 *   GitHub Actions context from.
 * @returns {{ commit: string, source: string } | { problem: string }} The
 *   baseline, or why there is none.
 */
export const resolveBaseline = (rootDir, env) => {
  if (revision(rootDir, "HEAD") === null) {
    return {
      problem: `${rootDir} is not a Git repository with a commit in it, so the migration history cannot be compared against anything. ${FETCH_INSTRUCTION}`,
    };
  }

  // Unconditional on the event name, never on the payload being readable: a
  // push whose payload is missing would otherwise fall through to the
  // merge-base branch, where on `main` the baseline is HEAD itself and the
  // check compares the history against itself.
  if (env.GITHUB_EVENT_NAME === "push") {
    const before = env.GITHUB_EVENT_PATH
      ? pushedFrom(env.GITHUB_EVENT_PATH)
      : null;
    if (before === null) {
      return {
        problem: `the push event carries no usable \`before\` SHA, so there is nothing to compare this push against. ${FETCH_INSTRUCTION}`,
      };
    }
    const commit = revision(rootDir, before);
    return commit === null
      ? {
          problem: `the push event's \`before\` SHA ${before} is not in this clone. ${FETCH_INSTRUCTION}`,
        }
      : { commit, source: `the push event's before SHA ${before}` };
  }

  const candidates =
    env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_BASE_REF
      ? [`origin/${env.GITHUB_BASE_REF}`, env.GITHUB_BASE_REF]
      : ["origin/main", "main"];

  for (const candidate of candidates) {
    if (revision(rootDir, candidate) === null) {
      continue;
    }
    const mergeBase = gitOrNull(rootDir, ["merge-base", "HEAD", candidate]);
    if (mergeBase !== null) {
      return {
        commit: mergeBase.trim(),
        source: `the merge-base with ${candidate}`,
      };
    }
  }

  return {
    problem: `no merge-base could be established with ${candidates.join(" or ")}. ${FETCH_INSTRUCTION}`,
  };
};

/** One file as of the baseline, or `null` where it did not exist. */
const fileAt = (rootDir, commit, file) =>
  gitOrNull(rootDir, ["show", `${commit}:${file}`]);

/** Every file the baseline tracked under one directory. */
const filesAt = (rootDir, commit, directory) => {
  const listed = gitOrNull(rootDir, [
    "ls-tree",
    "-r",
    "--name-only",
    commit,
    "--",
    directory,
  ]);
  return listed === null
    ? []
    : listed.split("\n").filter((line) => line.trim() !== "");
};

const listFiles = (dir, prefix) => {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );
};

const parseJournal = (text) => {
  try {
    return JSON.parse(text).entries ?? null;
  } catch {
    return null;
  }
};

/**
 * The journal's own rule, which the byte comparison beside it cannot state: the
 * baseline's entries must still be there, in order, and every entry appended
 * after them must be newer than all of them.
 *
 * The timestamp clause is not decoration. Drizzle applies only migrations whose
 * `folderMillis` exceeds the newest `created_at` in the ledger, so an entry
 * appended with an older timestamp is skipped at `migrate()` and reported as
 * pending by the boot assertion forever, with no recovery from that side.
 */
const checkJournal = (directory, baseText, headText, add) => {
  const before = parseJournal(baseText);
  const after = parseJournal(headText);

  if (after === null) {
    add(
      "journal",
      `${directory}/${JOURNAL} is missing or is not readable JSON.`
    );
    return;
  }
  if (before === null) {
    return;
  }

  for (const [index, entry] of before.entries()) {
    const now = after[index];
    if (now === undefined) {
      add(
        "journal",
        `${directory}/${JOURNAL} has ${after.length} entries where the baseline had ${before.length}; a journaled migration was removed. History is append-only.`
      );
      return;
    }
    if (
      now.idx !== entry.idx ||
      now.tag !== entry.tag ||
      now.when !== entry.when
    ) {
      add(
        "journal",
        `${directory}/${JOURNAL} entry ${index} is now ${now.tag} at ${now.when} where the baseline had ${entry.tag} at ${entry.when}; a journaled migration was reordered or replaced. History is append-only.`
      );
      return;
    }
  }

  const newest = Math.max(0, ...before.map((entry) => entry.when));
  for (const entry of after.slice(before.length)) {
    if (entry.when <= newest) {
      add(
        "journal",
        `${directory}/${JOURNAL} appends ${entry.tag} at ${entry.when}, which is not later than the ${newest} already journaled. Drizzle applies only migrations newer than the newest applied one, so this would never run and would be reported as pending forever.`
      );
    }
  }
};

/**
 * Checks that no journaled migration was modified, deleted, reordered or
 * replaced since the baseline.
 *
 * @param {{ rootDir: string, env?: Record<string, string | undefined> }} options
 *   The repository to verify, and the environment its CI context is read from.
 * @returns {{ rule: string, message: string }[]} Every violation found, empty
 *   when history was only appended to.
 */
export const verifyMigrations = ({ rootDir, env = process.env }) => {
  const violations = [];
  const add = (rule, message) => violations.push({ rule, message });

  const baseline = resolveBaseline(rootDir, env);
  if ("problem" in baseline) {
    add("baseline", baseline.problem);
    return violations;
  }

  for (const directory of MIGRATION_DIRECTORIES) {
    const tracked = filesAt(rootDir, baseline.commit, directory);
    const present = new Set(
      listFiles(path.join(rootDir, directory), `${directory}/`)
    );

    for (const file of tracked) {
      const baseText = fileAt(rootDir, baseline.commit, file);
      const headText = present.has(file)
        ? readFileSync(path.join(rootDir, file), "utf-8")
        : null;

      if (file === `${directory}/${JOURNAL}`) {
        checkJournal(directory, baseText ?? "", headText ?? "", add);
        continue;
      }
      if (headText === null) {
        add(
          "migration-file",
          `${file} was journaled at ${baseline.source} and is now gone. An applied migration that no longer exists cannot be reconciled with the hash every existing database recorded for it.`
        );
        continue;
      }
      if (headText !== baseText) {
        add(
          "migration-file",
          `${file} differs from ${baseline.source}. Drizzle writes a migration hash it never reads, so an edited applied migration is silently ignored and every existing database keeps the old DDL. Append a new migration instead.`
        );
      }
    }
  }

  return violations;
};

const main = () => {
  const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const violations = verifyMigrations({ rootDir });

  if (violations.length > 0) {
    for (const { rule, message } of violations) {
      process.stderr.write(`${rule}  ${message}\n`);
    }
    process.stderr.write(
      `\n${violations.length} migration history violation(s). Migration history is append-only (ADR 0017).\n`
    );
    process.exit(1);
  }

  process.stdout.write(
    `Migration history holds: ${MIGRATION_DIRECTORIES.join(", ")} was only appended to.\n`
  );
};

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
