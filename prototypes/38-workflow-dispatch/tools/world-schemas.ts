// What Vercel Workflow's Postgres world actually creates, and where.
//
// ADR 0010 asserts that "Workflow's storage stays opaque ... its tables are
// never part of @reprove/control-plane's Drizzle model, never covered by ADR
// 0008's migrations, and never subject to its RLS policies." That is a claim
// about someone else's migrations, so it is worth reading rather than trusting.
import { Client } from 'pg';

const url = process.env.WORKFLOW_POSTGRES_URL ?? 'postgres://world:world@localhost:55438/world';
const c = new Client({ connectionString: url });
await c.connect();
const t = await c.query(`
  select table_schema, table_name from information_schema.tables
   where table_schema not in ('pg_catalog','information_schema')
   order by 1,2`);
console.log('\nTables in the Workflow world database:\n');
for (const r of t.rows) console.log(`  ${r.table_schema}.${r.table_name}`);
const inPublic = t.rows.filter((r) => r.table_schema === 'public');
console.log(
  `\n  ${inPublic.length === 0 ? '[OK]  ' : '[BAD] '}tables in public: ${inPublic.length}`,
);
console.log(
  '  [NOTE] every table lives in workflow / workflow_drizzle / graphile_worker.\n' +
    '         So ADR 0008\'s "every table is classified" boot assertion must be\n' +
    "         scoped to Reprove's own schema, not to the database. Scoped to the\n" +
    '         database, sharing a server with Workflow would refuse boot.\n',
);
await c.end();
