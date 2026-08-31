// THROWAWAY. The runtime half of ADR 0008, and the place ADR 0010 put the boot
// assertion: "inside the connection factory rather than in application startup
// makes it unskippable by construction: there is no path to a client that
// bypasses it."
//
// So `createRuntimeDb()` either returns a client that has proved the tenant
// boundary is live, or it throws. There is no third outcome and no flag.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { NON_TENANT_TABLES, TENANT_TABLES } from './schema.js';

export class BootRefusal extends Error {
  constructor(public readonly checks: CheckResult[]) {
    const failed = checks.filter((c) => !c.ok);
    super(
      `refusing to serve: ${failed.length} of ${checks.length} tenancy assertions failed\n` +
        failed.map((c) => `      x ${c.name}: ${c.detail}`).join('\n'),
    );
    this.name = 'BootRefusal';
  }
}

export type CheckResult = { name: string; ok: boolean; detail: string };

export type RuntimeDb = {
  pool: pg.Pool;
  checks: CheckResult[];
  /** The single entry point. A tenant-scoped query outside one is hard to write by accident. */
  withOwner<T>(ownerId: number, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Deliberately available, so scenarios can show what happens WITHOUT a tenant context. */
  withoutOwner<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

async function runChecks(pool: pg.Pool): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const one = async (name: string, fn: () => Promise<string | null>) => {
    try {
      const bad = await fn();
      out.push({ name, ok: bad === null, detail: bad ?? 'ok' });
    } catch (e) {
      out.push({ name, ok: false, detail: `check itself failed: ${(e as Error).message}` });
    }
  };

  // Rule 4. The one that fails SILENTLY, which is why it is checked at all.
  await one('role is not superuser and has no BYPASSRLS', async () => {
    const r = await pool.query(
      `select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    const row = r.rows[0];
    if (!row) return 'current_user has no pg_roles row';
    const flags = [row.rolsuper && 'SUPERUSER', row.rolbypassrls && 'BYPASSRLS'].filter(Boolean);
    return flags.length ? `${row.rolname} carries ${flags.join(' + ')}; every policy would be ignored with no error` : null;
  });

  // A table's owner is exempt from its own RLS unless FORCE is set. Belt and
  // braces: the role must not own tables AND the tables must be forced.
  await one('role owns no table in the schema', async () => {
    const r = await pool.query(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles o on o.oid = c.relowner
        where n.nspname = 'public' and c.relkind = 'r' and o.rolname = current_user`,
    );
    return r.rowCount ? `owns ${r.rows.map((x) => x.relname).join(', ')}` : null;
  });

  // The check that makes the exemption list safe: every table must be
  // CLASSIFIED, so a table nobody thought about refuses boot rather than
  // silently landing outside the tenant boundary.
  await one('every table is classified as tenant or non-tenant', async () => {
    const r = await pool.query(
      `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const live = new Set<string>(r.rows.map((x) => x.relname));
    const known = new Set<string>([...TENANT_TABLES, ...NON_TENANT_TABLES]);
    const unclassified = [...live].filter((t) => !known.has(t));
    const missing = [...known].filter((t) => !live.has(t));
    const problems = [
      unclassified.length && `unclassified in the database: ${unclassified.join(', ')}`,
      missing.length && `declared but absent: ${missing.join(', ')}`,
    ].filter(Boolean);
    return problems.length ? problems.join('; ') : null;
  });

  await one('every tenant table has RLS enabled AND forced', async () => {
    const r = await pool.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])`,
      [[...TENANT_TABLES]],
    );
    const bad = r.rows
      .filter((x) => !x.relrowsecurity || !x.relforcerowsecurity)
      .map((x) => `${x.relname}(${x.relrowsecurity ? '' : 'no RLS'}${x.relforcerowsecurity ? '' : ' not FORCEd'})`);
    return bad.length ? bad.join(', ') : null;
  });

  await one('every tenant table has a policy reaching this role', async () => {
    const r = await pool.query(
      `select tablename, count(*)::int as n from pg_policies
        where schemaname = 'public' and tablename = any($1::text[])
          and (current_user = any(roles) or 'public' = any(roles))
        group by tablename`,
      [[...TENANT_TABLES]],
    );
    const have = new Set<string>(r.rows.map((x) => x.tablename));
    const bare = TENANT_TABLES.filter((t) => !have.has(t));
    // A tenant table with RLS on and no applicable policy denies everything,
    // which is safe but is a bug, not a boundary. Refuse either way.
    return bare.length ? `no applicable policy on ${bare.join(', ')}` : null;
  });

  // ADR 0008: the runtime "refuses to serve if it is behind, naming the pending
  // migration, rather than degrading."
  await one('schema is not behind the migration journal', async () => {
    const journal = JSON.parse(readFileSync('./drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const r = await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`);
    const applied = r.rows[0].n as number;
    if (applied >= journal.entries.length) return null;
    const pending = journal.entries.slice(applied).map((e) => e.tag);
    return `${pending.length} pending: ${pending.join(', ')}`;
  });

  // Behavioural, not catalog. Catalog flags can be right while the predicate is
  // wrong, so the last check actually reads a tenant table with no context set.
  await one('a tenant table reads empty with no Owner context', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Deliberately the SAME expression the policies use. If the assertion and
      // the policy disagree about what "no context" means, the assertion is
      // measuring something the boundary does not depend on - and `RESET ALL`
      // leaves an empty string rather than NULL, so the two really can disagree.
      const ctx = await client.query(`select nullif(current_setting('app.owner_id', true), '') as v`);
      const n = await client.query(`select count(*)::int as n from "run"`);
      await client.query('commit');
      if (ctx.rows[0].v !== null) return `stale tenant context leaked onto a fresh connection: ${ctx.rows[0].v}`;
      return n.rows[0].n === 0 ? null : `${n.rows[0].n} rows visible with no tenant context`;
    } finally {
      client.release();
    }
  });

  return out;
}

export async function createRuntimeDb(connectionString: string, max = 8): Promise<RuntimeDb> {
  const pool = new pg.Pool({ connectionString, max });
  const checks = await runChecks(pool);
  if (checks.some((c) => !c.ok)) {
    await pool.end();
    throw new BootRefusal(checks);
  }

  async function inTransaction<T>(setOwner: number | null, fn: (tx: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      if (setOwner !== null) {
        // Rule 2, and the reason it is set_config rather than `SET LOCAL`:
        // Postgres will not bind a parameter into a SET statement, so `SET LOCAL`
        // forces string interpolation of a value that arrives from a webhook.
        // set_config(..., is_local => true) is the parameterized equivalent and
        // is scoped to the transaction identically.
        await client.query(`select set_config('app.owner_id', $1::text, true)`, [setOwner]);
      }
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    pool,
    checks,
    withOwner: (ownerId, fn) => inTransaction(ownerId, fn),
    withoutOwner: (fn) => inTransaction(null, fn),
    close: () => pool.end(),
  };
}
