// THROWAWAY. The admin half of ADR 0008's two-connection design.
//
//   admin / migration connection      runtime connection
//     owner-or-admin role               restricted non-BYPASSRLS role
//     direct endpoint                   pooled endpoint
//     migrations and bootstrap only     all application traffic
//
// Everything here runs over the direct endpoint as the table owner. Nothing here
// is reachable from the runtime path.

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { ADMIN_URL, BYPASSRLS_ROLE, RUNTIME_ROLE } from './env.js';
import { NON_TENANT_TABLES, TENANT_TABLES } from './schema.js';

export function adminPool() {
  return new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
}

/**
 * ADR 0008: "Provisioning the restricted runtime role is part of the supported
 * database bootstrap flow, executed as SQL through the admin connection - not
 * 'create a role in the Neon Console', because Neon-created roles inherit the
 * privileges that defeat this design."
 *
 * The negative flags are spelled out rather than relied on as defaults, because
 * a default that changes is exactly the silent failure the boot assertion exists
 * to catch.
 */
export async function createRoles(pool: pg.Pool) {
  await pool.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${RUNTIME_ROLE}') then
        create role ${RUNTIME_ROLE}
          login
          nosuperuser
          nobypassrls
          nocreatedb
          nocreaterole
          noreplication;
      end if;
    end $$;
  `);

  // Exists ONLY so a scenario can prove the boot assertion refuses it. This is
  // the shape Neon hands you when a role is created through the console, since
  // neon_superuser carries BYPASSRLS and is granted to console-created roles.
  await pool.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${BYPASSRLS_ROLE}') then
        create role ${BYPASSRLS_ROLE} login nosuperuser bypassrls;
      end if;
    end $$;
  `);
}

/** Drizzle-generated SQL, committed to Git, applied by an explicit command. */
export async function applyMigrations(pool: pg.Pool) {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
}

/**
 * Grants, plus the one thing drizzle-kit cannot emit.
 *
 * FORCE ROW LEVEL SECURITY is a DDL alteration with no Drizzle representation at
 * 0.45.2, so it lives in hand-written SQL. In the real package this belongs in a
 * `drizzle-kit generate --custom` migration rather than in bootstrap, so that a
 * table added later cannot reach production un-forced; it is here because a
 * prototype has no migration history worth preserving.
 */
export async function grantAndForce(pool: pg.Pool, roles = [RUNTIME_ROLE, BYPASSRLS_ROLE]) {
  for (const role of roles) {
    await pool.query(`grant connect on database reprove_proto to ${role}`);
    await pool.query(`grant usage on schema public to ${role}`);
    await pool.query(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await pool.query(`grant usage, select on all sequences in schema public to ${role}`);
    // The runtime role must not be able to create a table, because a table it
    // created would be a table it owns, and a table owner is exempt from RLS
    // unless FORCE is set. Removing the ability closes that route entirely.
    await pool.query(`revoke create on schema public from ${role}`);
    // Read access to the migration ledger, so the runtime can refuse to serve
    // when it is behind without needing the admin credential to find out.
    await pool.query(`grant usage on schema drizzle to ${role}`);
    await pool.query(`grant select on all tables in schema drizzle to ${role}`);
  }

  for (const table of TENANT_TABLES) {
    await pool.query(`alter table "${table}" force row level security`);
  }
}

/** What the admin connection sees, for scenarios that need a tenant-blind view. */
export async function adminCount(pool: pg.Pool, table: string, where = '') {
  const r = await pool.query(`select count(*)::int as n from "${table}" ${where}`);
  return r.rows[0].n as number;
}

export { NON_TENANT_TABLES, TENANT_TABLES, sql };
