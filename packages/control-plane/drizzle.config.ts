import { defineConfig } from "drizzle-kit";

/**
 * Generation only. `drizzle-kit generate` needs no database, and this package
 * reads no environment variables, so no connection string appears here: the
 * admin URL an operator migrates with is passed to `migrate()` explicitly, or
 * read from the environment by the bin.
 *
 * `entities.roles: false` keeps role management out of drizzle-kit's hands.
 * `bootstrap()` provisions `reprove_runtime` as SQL over the admin connection
 * with every privilege flag spelled out; drizzle-kit only needs to know the
 * name, so the policies it emits can be granted to it.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  entities: { roles: false },
});
