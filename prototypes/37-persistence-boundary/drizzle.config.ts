import { defineConfig } from 'drizzle-kit';
import { ADMIN_URL } from './src/env.js';

// Migrations are generated and applied over the ADMIN connection only, per
// ADR 0008: "The admin credential is never the application's runtime credential."
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: ADMIN_URL },
  // ADR 0008 rule 4: the runtime role is provisioned as SQL through the admin
  // connection. Drizzle-kit is told about it so policies can name it, but role
  // management stays in bootstrap.ts where the privilege flags are explicit.
  entities: { roles: false },
});
