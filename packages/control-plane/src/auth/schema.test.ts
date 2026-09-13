/**
 * The adopted tables against Better Auth's own model, field for field.
 *
 * "Better Auth is composed against the adopted tables, sharing Reprove's
 * migration history rather than managing its own" is only true while the two
 * definitions agree, and the way they stop agreeing is silent: the Drizzle
 * adapter resolves each field against the schema object at **write** time, so a
 * field Better Auth's model gained and this schema did not surfaces as a failed
 * sign-in in production rather than as anything at authoring time.
 *
 * So the expectation is read from Better Auth rather than written down here.
 * `auth.$context.tables` is the same model the adapter resolves against, which
 * is what makes this a comparison rather than a second spelling: a Better Auth
 * upgrade that adds a column fails here, on the pull request that bumps it.
 *
 * No database: `$context` builds the model and the adapter, and neither issues
 * a query.
 */
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { tableName } from "../db/classification.js";
import * as schema from "../db/schema.js";
import { createAuth } from "./auth.js";

/** Never dialled. Nothing in this file opens a connection. */
const UNREACHABLE = "postgres://nobody@127.0.0.1:1/nowhere";

const auth = createAuth({
  database: drizzle(new Pool({ connectionString: UNREACHABLE }), { schema }),
  secret: "schema-conformance-secret",
  baseURL: "http://127.0.0.1:3000",
  github: { clientId: "Iv1.test", clientSecret: "github-client-secret" },
});

/** The four models, and the table each is adopted onto. */
const ADOPTED = [
  ["user", schema.user],
  ["session", schema.session],
  ["account", schema.account],
  ["verification", schema.verification],
] as const;

/**
 * Columns a Better Auth upgrade removed from its model that an expand migration
 * has relaxed and a contract migration has yet to drop.
 *
 * ADR 0008 rolls a destructive change out as expand and backfill, then contract
 * and drop, so between those two releases an adopted table legitimately carries
 * a column Better Auth's model does not. That window is the only thing this
 * allows, and it allows it by name: anything else extra is still the failure the
 * comparison below exists to catch.
 *
 * Every entry has to be nullable, which is asserted rather than trusted. A
 * required column Better Auth never writes is what breaks a sign-in, so an entry
 * that was still `NOT NULL` would be this list hiding the actual fault.
 *
 * Emptying this is part of the contract migration, not a separate cleanup.
 */
const RETIRING: Partial<Record<(typeof ADOPTED)[number][0], string[]>> = {
  // Better Auth 1.7.3 restored the 1.6 `(providerId, accountId)` account key and
  // dropped `issuer`. 0011 relaxed it; #98 drops it.
  account: ["issuer"],
};

describe("the four tables Reprove adopted from Better Auth", () => {
  it("are the only models Better Auth expects", async () => {
    const { tables } = await auth.$context;

    expect(Object.keys(tables).toSorted()).toStrictEqual([
      "account",
      "session",
      "user",
      "verification",
    ]);
  });

  it.each(ADOPTED)(
    "carries every field Better Auth's %s model has",
    async (model, table) => {
      const { tables } = await auth.$context;
      const retiring = RETIRING[model] ?? [];
      // `fieldName` is the name the adapter looks up on the Drizzle table object,
      // which is the property key rather than the SQL column name. `id` is not in
      // the field list because Better Auth handles it separately, and it is still
      // a column the adapter reads.
      const expected = [
        "id",
        ...retiring,
        ...Object.values(tables[model]?.fields ?? {}).map(
          (field) => field.fieldName
        ),
      ].toSorted();

      const nullable = new Map(
        Object.entries(getTableColumns(table)).map(([name, column]) => [
          name,
          !column.notNull,
        ])
      );

      // Set equality in both directions. A missing field breaks a write; an extra
      // one means Reprove quietly took over part of a definition it does not own,
      // unless `RETIRING` names it as mid-contraction.
      expect([...nullable.keys()].toSorted()).toStrictEqual(expected);

      // What makes a retiring column harmless: Better Auth rejects a *required*
      // column it never writes, so the allowance above is only true while every
      // column it names is nullable.
      for (const column of retiring) {
        expect(nullable.get(column)).toBeTruthy();
      }
    }
  );

  it("maps every model onto a table the schema module manages", async () => {
    const { tables } = await auth.$context;
    const adopted = new Map<string, string>(
      ADOPTED.map(([model, table]) => [model, tableName(table)])
    );

    for (const [model, definition] of Object.entries(tables)) {
      expect(adopted.get(model)).toBe(definition.modelName);
    }
  });
});
