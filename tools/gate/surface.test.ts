import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  LINEAGE_ISSUE_TITLE,
  readLineageState,
  surfaceLineage,
} from "./surface.mjs";

const REPOSITORY = "nick-neely/reprove";
const RUN_URL = "https://github.com/nick-neely/reprove/actions/runs/1";

/** A `gh` that records its argv and answers the issue search with `open`. */
const recordingGh = (open: string) => {
  const calls: string[][] = [];
  return {
    calls,
    gh: (args: readonly string[]) => {
      calls.push([...args]);
      return Promise.resolve({ stdout: args[1] === "list" ? open : "" });
    },
  };
};

const execFileAsync = promisify(execFile);

/** Run the CLI, however it ends: a refusal is an exit status, not a crash. */
const runCli = async (args: readonly string[]) => {
  const argv = [path.join(import.meta.dirname, "surface.mjs"), ...args];
  try {
    const ran = await execFileAsync(process.execPath, argv);
    return { code: 0, ...ran };
  } catch (error) {
    // SAFETY: `execFile` rejects only with its own failure, which carries the
    // exit status and both captured streams.
    return error as { code: number; stdout: string; stderr: string };
  }
};

const jsonFile = (body: string) => {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "gate-status-")),
    "status.json"
  );
  writeFileSync(file, body);
  return file;
};

describe(surfaceLineage, () => {
  it("opens one issue while the lineage is not current", async () => {
    const { calls, gh } = recordingGh("");
    const surfaced = await surfaceLineage({
      status: "stale",
      repository: REPOSITORY,
      runUrl: RUN_URL,
      gh,
    });
    expect(surfaced).toStrictEqual({ status: "stale", action: "created" });
    expect(calls[0]).toStrictEqual([
      "issue",
      "list",
      "--repo",
      REPOSITORY,
      "--state",
      "open",
      "--search",
      `"${LINEAGE_ISSUE_TITLE}" in:title`,
      "--json",
      "number",
      "--jq",
      ".[0].number // empty",
    ]);
    expect(calls[1]?.slice(0, 6)).toStrictEqual([
      "issue",
      "create",
      "--repo",
      REPOSITORY,
      "--title",
      LINEAGE_ISSUE_TITLE,
    ]);
    expect(calls[1]?.at(-1)).toContain("**stale**");
    expect(calls[1]?.at(-1)).toContain(RUN_URL);
  });

  it("comments on the issue that is already open", async () => {
    const { calls, gh } = recordingGh("42\n");
    const surfaced = await surfaceLineage({
      status: "invalid",
      repository: REPOSITORY,
      runUrl: RUN_URL,
      gh,
    });
    expect(surfaced).toStrictEqual({ status: "invalid", action: "commented" });
    expect(calls[1]?.slice(0, 5)).toStrictEqual([
      "issue",
      "comment",
      "42",
      "--repo",
      REPOSITORY,
    ]);
  });

  it("closes the issue once the lineage is current again", async () => {
    const { calls, gh } = recordingGh("42\n");
    const surfaced = await surfaceLineage({
      status: "current",
      repository: REPOSITORY,
      runUrl: RUN_URL,
      gh,
    });
    expect(surfaced).toStrictEqual({ status: "current", action: "closed" });
    expect(calls[1]?.slice(0, 5)).toStrictEqual([
      "issue",
      "close",
      "42",
      "--repo",
      REPOSITORY,
    ]);
    expect(calls[1]?.at(-1)).toContain("returned to current");
  });

  it("says nothing when the lineage is current and no issue is open", async () => {
    const { calls, gh } = recordingGh("");
    const surfaced = await surfaceLineage({
      status: "current",
      repository: REPOSITORY,
      gh,
    });
    expect(surfaced).toStrictEqual({ status: "current", action: "none" });
    expect(calls).toHaveLength(1);
  });
});

describe(readLineageState, () => {
  it("reads the state `status` printed", () => {
    expect(
      readLineageState({ statusFile: jsonFile('{"status":"stale"}') })
    ).toBe("stale");
  });

  it("reads the state a score summary carries", () => {
    expect(
      readLineageState({ statusFile: jsonFile('{"lineageStatus":"failed"}') })
    ).toBe("failed");
  });

  it("throws on a status file it cannot read or understand", () => {
    // A broken tool is not a lineage state: publishing `invalid` here would
    // report drift the evidence never showed.
    expect(() =>
      readLineageState({ statusFile: "/nowhere/status.json" })
    ).toThrow(/could not be read as the printed lineage state/u);
    expect(() => readLineageState({ statusFile: jsonFile("") })).toThrow(
      /could not be read as the printed lineage state/u
    );
    expect(() =>
      readLineageState({ statusFile: jsonFile('{"lineage":"codex/brokered"}') })
    ).toThrow(/carries no lineage state/u);
    expect(() =>
      readLineageState({ statusFile: jsonFile('{"status":"promotable"}') })
    ).toThrow(/carries no lineage state/u);
  });

  it("computes the state from a ledger when no status was printed", () => {
    expect(
      readLineageState({
        ledger: mkdtempSync(path.join(tmpdir(), "gate-ledger-")),
      })
    ).toBe("unqualified");
  });
});

describe("the command line", () => {
  it("exits 2 on an unreadable status file without touching the issue", async () => {
    // `gh` is never reached: the failure happens before the first call, so no
    // issue is created, commented on or closed.
    const failed = await runCli([
      "--repository",
      REPOSITORY,
      "--status-file",
      "/nowhere/status.json",
    ]);
    expect(failed.code).toBe(2);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain(
      "could not be read as the printed lineage state"
    );
  });
});
