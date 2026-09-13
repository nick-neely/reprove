/** The contract preserves accounts written on either side of the 0011 release. */
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { bootstrap } from "./bootstrap.js";
import {
  createTestDatabase,
  RUNTIME_PASSWORD,
} from "./local-stack.test-support.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS_FOLDER } from "./migrations.js";

describe("the account issuer contract", () => {
  it("drops issuer while preserving accounts and enforcing the provider account key", async () => {
    const database = await createTestDatabase("reprove_test_account_contract");
    const folder = mkdtempSync(
      path.join(tmpdir(), "reprove-account-contract-")
    );
    const pool = new Pool({ connectionString: database.adminUrl });
    try {
      await bootstrap({
        connectionString: database.adminUrl,
        runtimePassword: RUNTIME_PASSWORD,
      });
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      const journalPath = path.join(folder, "meta", "_journal.json");
      // SAFETY: the committed Drizzle journal, copied into this test's own folder.
      const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter(({ idx }) => idx <= 11);
      writeFileSync(journalPath, JSON.stringify(journal));
      await applyMigrations(drizzle(pool), { migrationsFolder: folder });
      await pool.query(`
      INSERT INTO "user" (id, name, email) VALUES ('person', 'Person', 'person@example.test');
      INSERT INTO account (id, user_id, provider_id, account_id, issuer, access_token)
      VALUES ('old', 'person', 'github', '123', 'local:oauth:github', 'old-ciphertext'),
             ('new', 'person', 'github', '456', NULL, 'new-ciphertext');
    `);

      await expect(
        migrate({ connectionString: database.adminUrl })
      ).resolves.toStrictEqual(["0012_drop_account_issuer"]);
      const columns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'account' AND column_name = 'issuer'
    `);
      expect(columns.rows).toStrictEqual([]);
      const accounts = await pool.query(`
      SELECT id, user_id, provider_id, account_id, access_token FROM account ORDER BY id
    `);
      expect(accounts.rows).toStrictEqual([
        {
          id: "new",
          user_id: "person",
          provider_id: "github",
          account_id: "456",
          access_token: "new-ciphertext",
        },
        {
          id: "old",
          user_id: "person",
          provider_id: "github",
          account_id: "123",
          access_token: "old-ciphertext",
        },
      ]);
      await expect(
        pool.query(`
      INSERT INTO account (id, user_id, provider_id, account_id)
      VALUES ('duplicate', 'person', 'github', '123')
    `)
      ).rejects.toMatchObject({ code: "23505" });
      await pool.query(`
      INSERT INTO account (id, user_id, provider_id, account_id)
      VALUES ('another-provider', 'person', 'other', '123')
    `);
      await expect(
        migrate({ connectionString: database.adminUrl })
      ).resolves.toStrictEqual([]);
    } finally {
      await pool.end();
      await database.drop();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
