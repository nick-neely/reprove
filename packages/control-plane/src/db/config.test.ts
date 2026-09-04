/**
 * The three entry points refusing their own configuration, with no database
 * anywhere.
 *
 * That is the point rather than a convenience. Every case below is a call that
 * would otherwise **connect** - to a database nobody named, through `pg`'s
 * fallback to the ambient `PG*` variables - so what is being asserted is that
 * the rejection happens before a pool exists, and a test that needed the local
 * stack could not say that.
 */
import { describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import type { SuppliedField } from "./config.js";
import { migrate } from "./migrate.js";
import { createRuntimeDb } from "./runtime.js";

/** Unreachable on purpose: nothing here may get as far as dialling it. */
const NOWHERE = "postgres://postgres@127.0.0.1:1/nowhere";

/** The three shapes a caller produces without meaning to. */
const UNUSABLE: [string, SuppliedField][] = [
  ["absent", undefined],
  ["null", null],
  ["empty", ""],
];

/**
 * The field in the type the published signature declares, which is the mismatch
 * the whole file is about. It lives in one place rather than at each call site,
 * because it is the premise rather than an inconvenience.
 */
const supplied = (value: SuppliedField): string =>
  // SAFETY: deliberately unsound. The published types say these fields are
  // strings and the package ships as JavaScript, so nothing enforces that at
  // the boundary - which is exactly what the guards under test are for.
  value as string;

describe("an entry point handed a field it cannot use", () => {
  it.each(UNUSABLE)(
    "refuses a %s bootstrap connection string",
    async (_label, value) => {
      await expect(
        bootstrap({
          connectionString: supplied(value),
          runtimePassword: "s3cret",
        })
      ).rejects.toThrow(/BootstrapConfig\.connectionString/u);
    }
  );

  it.each(UNUSABLE)("refuses a %s runtime password", async (_label, value) => {
    // The one that would otherwise succeed. `format('%L', NULL)` renders the
    // bare token `NULL`, so this provisions the restricted role with no password
    // at all - and reports nothing, because nothing failed.
    await expect(
      bootstrap({
        connectionString: NOWHERE,
        runtimePassword: supplied(value),
      })
    ).rejects.toThrow(/BootstrapConfig\.runtimePassword/u);
  });

  it.each(UNUSABLE)(
    "refuses a %s migrate connection string",
    async (_label, value) => {
      await expect(
        migrate({ connectionString: supplied(value) })
      ).rejects.toThrow(/MigrateConfig\.connectionString/u);
    }
  );

  it.each(UNUSABLE)(
    "refuses a %s runtime connection string",
    async (_label, value) => {
      await expect(
        createRuntimeDb({ connectionString: supplied(value) })
      ).rejects.toThrow(/RuntimeDbConfig\.connectionString/u);
    }
  );

  it("names the field and shows what arrived", async () => {
    await expect(
      bootstrap({ connectionString: NOWHERE, runtimePassword: "" })
    ).rejects.toThrow(
      new TypeError(
        'BootstrapConfig.runtimePassword must be a non-empty string, not ""'
      )
    );
  });
});
