import { describe, expect, it } from "vitest";

import {
  foreignSpecifiers,
  missingFromTrace,
} from "./verify-workflow-build.mjs";

/**
 * The two decisions the real-builder gate makes about text it did not produce:
 * which specifiers a workflow bundle is allowed to reach for, and what an
 * output trace has to carry. Both are pure, and both are the part of the gate
 * that can be wrong while the expensive build around them still passes - a
 * pattern that matched nothing would report every bundle clean.
 */
describe(foreignSpecifiers, () => {
  it("accepts a bundle that reaches only the workflow runtime", () => {
    const bundle = [
      'import { defineWorkflow } from "workflow";',
      'import { serve } from "workflow/next";',
      'import { World } from "@workflow/world";',
      'import { local } from "./chunk-2f1a.js";',
      "export const runtime = 'nodejs';",
    ].join("\n");

    expect(foreignSpecifiers(bundle)).toStrictEqual([]);
  });

  it("reports a Node built-in a workflow body dragged in", () => {
    const bundle = 'const { randomUUID } = require("node:crypto");';

    expect(foreignSpecifiers(bundle)).toStrictEqual(["node:crypto"]);
  });

  it("reports a bare import of a driver the workflow VM cannot load", () => {
    const bundle = 'import pg from "pg";\nimport "dotenv/config";';

    expect(foreignSpecifiers(bundle)).toStrictEqual(["dotenv/config", "pg"]);
  });

  it("reports a driver a workflow body reached behind a dynamic import", () => {
    // The form that compiles cleanly and fails only when the VM evaluates that
    // path, which is the arrangement this check exists to catch.
    const bundle = [
      'const { Pool } = await import("pg");',
      'const { serve } = await import("workflow/next");',
      'const chunk = await import("./chunk-2f1a.js");',
    ].join("\n");

    expect(foreignSpecifiers(bundle)).toStrictEqual(["pg"]);
  });

  it("deduplicates and sorts what it found, across import forms", () => {
    const bundle = [
      'import { Pool } from "pg";',
      'const again = require("pg");',
      'const later = await import("pg");',
      'export { migrate } from "@reprove/control-plane";',
    ].join("\n");

    expect(foreignSpecifiers(bundle)).toStrictEqual([
      "@reprove/control-plane",
      "pg",
    ]);
  });
});

describe(missingFromTrace, () => {
  const required = {
    "the Postgres driver": "/node_modules/pg/",
    "the migration journal": "/drizzle/meta/_journal.json",
  };

  it("finds nothing missing when every fragment is traced", () => {
    const files = [
      "../../../node_modules/.pnpm/pg@8.16.3/node_modules/pg/lib/index.js",
      "../../../packages/control-plane/drizzle/meta/_journal.json",
    ];

    expect(missingFromTrace(files, required)).toStrictEqual([]);
  });

  it("names what a trace lacks rather than only failing", () => {
    const files = [
      "../../../packages/control-plane/drizzle/meta/_journal.json",
    ];

    expect(missingFromTrace(files, required)).toStrictEqual([
      "the Postgres driver",
    ]);
  });

  it("names everything an empty trace lacks", () => {
    expect(missingFromTrace([], required)).toStrictEqual([
      "the Postgres driver",
      "the migration journal",
    ]);
  });
});
