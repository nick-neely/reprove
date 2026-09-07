#!/usr/bin/env node
/**
 * The one issue a non-current lineage keeps open.
 *
 * ```text
 * node tools/gate/surface.mjs --status-file status.json --repository owner/name
 * node tools/gate/surface.mjs --ledger tools/gate/ledger --repository owner/name
 * ```
 *
 * #34 requires exactly one maintained issue while a supported lineage is not
 * current, and that visibility cannot depend on a paid evaluation making
 * progress: an approval nobody grants is precisely how a qualification goes
 * stale. So this reads a lineage state - either the state `qualify.mjs status`
 * printed, the one a score summary carries, or one computed from the ledger -
 * and maintains the issue through `gh`. It needs no Provider credential and no
 * build; the scheduled `qualification-status` workflow runs it on its own.
 *
 * Nothing here Refuses a Run. Drift surfaces as this issue and as a blocked
 * promotion, and nowhere in the runtime.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import {
  lineageId,
  lineageStatus,
  PHASE0_LINEAGE,
  readLedger,
} from "./report.mjs";

const execFileAsync = promisify(execFile);

/** The title the lineage's issue is found and kept under. */
export const LINEAGE_ISSUE_TITLE =
  "Qualification: codex/brokered lineage is not current";

const DEFAULT_LEDGER = path.join(import.meta.dirname, "ledger");

/** Everything `lineageStatus` can conclude, and the only states publishable. */
const LINEAGE_STATES = new Set([
  "current",
  "stale",
  "failed",
  "invalid",
  "unqualified",
]);

const usage = () => {
  process.stderr.write(
    "usage: surface.mjs --repository <owner/name> [--status-file <file>] [--ledger <dir>] [--run-url <url>]\n"
  );
  process.exit(2);
};

/** `gh` itself, invoked as an argv array so no argument is ever parsed as shell. */
export const ghCommand = (args) => execFileAsync("gh", [...args]);

/**
 * The lineage state to publish.
 *
 * A status file that cannot be read, parsed or understood is a broken tool,
 * not a lineage state: `invalid` is a thing the ledger says about a lineage,
 * and publishing it for a file this could not open would report drift the
 * evidence never showed. So this throws, the CLI exits without touching the
 * issue, and the workflow step fails where a maintainer can see it.
 *
 * @param {object} input Where to read the state from.
 * @param {string} [input.statusFile] JSON carrying `status` or `lineageStatus`.
 * @param {string} [input.ledger] The ledger root, when no status file is given.
 * @param {number} [input.now] The instant freshness is judged at.
 * @returns {string} `current`, `stale`, `failed`, `invalid` or `unqualified`.
 * @throws {Error} When the status file is unreadable, malformed or says nothing.
 */
export const readLineageState = ({
  statusFile,
  ledger = DEFAULT_LEDGER,
  now = Date.now(),
}) => {
  if (statusFile === undefined) {
    return lineageStatus(readLedger(ledger, PHASE0_LINEAGE).reports, now)
      .status;
  }
  let printed;
  try {
    printed = JSON.parse(readFileSync(statusFile, "utf-8"));
  } catch (error) {
    throw new Error(
      `${statusFile} could not be read as the printed lineage state: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const printedState = printed?.status ?? printed?.lineageStatus;
  if (!LINEAGE_STATES.has(printedState)) {
    throw new Error(
      `${statusFile} carries no lineage state: ${String(printedState)}`
    );
  }
  return printedState;
};

/**
 * Keep exactly one issue for the lineage's state.
 *
 * @param {object} input What to publish and how.
 * @param {string} input.status The lineage state.
 * @param {string} input.repository The `owner/name` the issue lives in.
 * @param {string | null} [input.runUrl] The run that observed the state, when there was one.
 * @param {(args: readonly string[]) => Promise<{ stdout: string }>} [input.gh] The `gh` runner, injected by tests.
 * @returns {Promise<{ status: string, action: "created" | "commented" | "closed" | "none" }>} What it did.
 */
export const surfaceLineage = async ({
  status,
  repository,
  runUrl = null,
  gh = ghCommand,
}) => {
  const { stdout } = await gh([
    "issue",
    "list",
    "--repo",
    repository,
    "--state",
    "open",
    "--search",
    `"${LINEAGE_ISSUE_TITLE}" in:title`,
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  const existing = stdout.trim();
  const where = runUrl === null ? "" : ` in ${runUrl}`;
  if (status === "current") {
    if (existing === "") {
      return { status, action: "none" };
    }
    await gh([
      "issue",
      "close",
      existing,
      "--repo",
      repository,
      "--comment",
      `Qualification returned to current${where}.`,
    ]);
    return { status, action: "closed" };
  }
  const observed = runUrl === null ? "" : ` after ${runUrl}`;
  const body = `The ${lineageId(PHASE0_LINEAGE)} lineage is **${status}**${observed}. Promotion is blocked until a scheduled absolute-floor requalification passes. Ordinary Runs are unaffected.`;
  if (existing === "") {
    await gh([
      "issue",
      "create",
      "--repo",
      repository,
      "--title",
      LINEAGE_ISSUE_TITLE,
      "--body",
      body,
    ]);
    return { status, action: "created" };
  }
  await gh([
    "issue",
    "comment",
    existing,
    "--repo",
    repository,
    "--body",
    body,
  ]);
  return { status, action: "commented" };
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      repository: { type: "string" },
      "status-file": { type: "string" },
      ledger: { type: "string" },
      "run-url": { type: "string" },
    },
  });
  if (!values.repository) {
    usage();
  }
  const status = readLineageState({
    statusFile: values["status-file"],
    ledger: values.ledger ?? DEFAULT_LEDGER,
  });
  const surfaced = await surfaceLineage({
    status,
    repository: values.repository,
    runUrl: values["run-url"] || null,
  });
  process.stdout.write(`${JSON.stringify(surfaced)}\n`);
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${String(error instanceof Error ? (error.stack ?? error.message) : error)}\n`
    );
    // Every failure here is a broken tool rather than a lineage state, so it
    // exits the way a bad invocation does. Nothing this command prints is
    // read as a state, so no exit code needs to carry one.
    process.exit(2);
  }
}
