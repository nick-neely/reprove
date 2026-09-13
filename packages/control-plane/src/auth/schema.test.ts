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
      // `fieldName` is the name the adapter looks up on the Drizzle table object,
      // which is the property key rather than the SQL column name. `id` is not in
      // the field list because Better Auth handles it separately, and it is still
      // a column the adapter reads.
      const expected = [
        "id",
        ...Object.values(tables[model]?.fields ?? {}).map(
          (field) => field.fieldName
        ),
      ].toSorted();

      // Set equality in both directions. A missing field breaks a write; an extra
      // one means Reprove quietly took over part of a definition it does not own.
      expect(Object.keys(getTableColumns(table)).toSorted()).toStrictEqual(
        expected
      );
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
