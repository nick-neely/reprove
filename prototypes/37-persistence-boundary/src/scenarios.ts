// THROWAWAY. Drives the cases that were hard to settle on paper and prints what
// the database actually does. Every scenario exists because it decides something.
//
//   npm run prototype     wipe, bring the stack up, run this
//
// Read the output top to bottom; nothing here is a unit test and nothing asserts
// silently. Where a scenario proves a REFUSAL, the refusal is the pass.

import pg from 'pg';
import {
  ADMIN_URL, BYPASSRLS_ROLE, BYPASSRLS_URL, RUNTIME_ROLE, RUNTIME_URL, RUNTIME_URL_PINNED_POOL,
} from './env.js';
import { adminPool, applyMigrations, createRoles, grantAndForce } from './bootstrap.js';
import { BootRefusal, createRuntimeDb, type RuntimeDb } from './runtime.js';
import { commitEnvelope, processDelivery, redriveOnce, type CanonicalPull, type Delivery, type Phase0RunProfile } from './ingress.js';

const ACME = 1001;   // github.com/acme        (organization)
const GLOBEX = 2002; // github.com/globex      (organization)

let section = 0;
const head = (t: string) => console.log(`\n\n${'='.repeat(78)}\n${String(++section).padStart(2, '0')}  ${t}\n${'='.repeat(78)}`);
const sub = (t: string) => console.log(`\n--- ${t}`);
const line = (k: string, v: unknown) => console.log(`    ${k.padEnd(46)} ${v}`);
const good = (m: string) => console.log(`    [ok]   ${m}`);
const bad = (m: string) => console.log(`    [BAD]  ${m}`);
const note = (m: string) => console.log(`    ${m}`);

const PROFILE: Phase0RunProfile = {
  harness: 'codex', model: 'gpt-5-codex', strategy: 'single-pass',
  autonomy: 'read-only', placement: 'hosted', configDigest: 'sha256:fixed-phase0-profile',
  claimableForMs: 15 * 60 * 1000,
};

async function main() {
  const admin = adminPool();

  // -------------------------------------------------------------------------
  head('Bootstrap from a clean database, over the admin connection only');

  await createRoles(admin);
  await applyMigrations(admin);
  await grantAndForce(admin);

  const roles = await admin.query(
    `select rolname, rolsuper, rolbypassrls, rolcreaterole from pg_roles
      where rolname in ($1, $2, 'postgres') order by rolname`, [RUNTIME_ROLE, BYPASSRLS_ROLE]);
  for (const r of roles.rows) {
    line(r.rolname, `superuser=${r.rolsuper}  bypassrls=${r.rolbypassrls}  createrole=${r.rolcreaterole}`);
  }
  const owners = await admin.query(
    `select o.rolname, count(*)::int n from pg_class c
       join pg_namespace ns on ns.oid=c.relnamespace join pg_roles o on o.oid=c.relowner
      where ns.nspname='public' and c.relkind='r' group by o.rolname`);
  line('tables by owner', owners.rows.map((r) => `${r.rolname}=${r.n}`).join(', '));
  note(`the runtime role owns nothing, so it is not exempt from RLS even before FORCE`);

  const forced = await admin.query(
    `select count(*) filter (where relrowsecurity)::int e, count(*) filter (where relforcerowsecurity)::int f,
            count(*)::int total from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r'`);
  line('tables with RLS enabled / forced / total', `${forced.rows[0].e} / ${forced.rows[0].f} / ${forced.rows[0].total}`);
  note(`the 4 uncovered tables are Better Auth's, which are deliberately outside Owner tenancy`);

  // -------------------------------------------------------------------------
  head('createRuntimeDb() proves the boundary before it hands back a client');

  const rt = await createRuntimeDb(RUNTIME_URL);
  for (const c of rt.checks) console.log(`    ${c.ok ? '[ok]  ' : '[FAIL]'} ${c.name}${c.ok ? '' : ` -> ${c.detail}`}`);
  note(`ADR 0010 puts this inside the factory, so there is no path to a client that skips it`);

  // -------------------------------------------------------------------------
  head('Two tenants cannot see or write each other, under identical code');

  await seed(rt, ACME, 'acme', 8801, 'acme/api');
  await seed(rt, GLOBEX, 'globex', 9901, 'globex/web');

  for (const [name, id] of [['acme', ACME], ['globex', GLOBEX]] as const) {
    const seen = await rt.withOwner(id, async (tx) => ({
      owner: (await tx.query(`select login from owner`)).rows.map((r) => r.login),
      repos: (await tx.query(`select name_with_owner from repository`)).rows.map((r) => r.name_with_owner),
      runs: (await tx.query(`select count(*)::int n from run`)).rows[0].n,
    }));
    line(`withOwner(${name}) sees`, `owner=${JSON.stringify(seen.owner)} repos=${JSON.stringify(seen.repos)} runs=${seen.runs}`);
  }
  const adminTotal = await admin.query(`select count(*)::int n from run`);
  line('the admin connection sees', `${adminTotal.rows[0].n} runs across both tenants`);

  sub('the query a reviewer would miss: a SELECT with no WHERE owner_id');
  const leaky = await rt.withOwner(ACME, async (tx) =>
    (await tx.query(`select count(*)::int n from finding`)).rows[0].n);
  line('select count(*) from finding  (no scoping at all)', leaky);
  good(`RLS turned a forgotten WHERE into ${leaky} rows instead of ${adminTotal.rows[0].n === 0 ? '?' : 'every tenant'}`);

  sub('writing INTO another tenant, with the right ids and the wrong context');
  try {
    await rt.withOwner(GLOBEX, async (tx) => {
      await tx.query(`insert into repository (id, owner_id, name_with_owner) values (7777, $1, 'acme/stolen')`, [ACME]);
    });
    bad('cross-tenant insert succeeded');
  } catch (e) {
    good(`WITH CHECK rejected it: ${(e as Error).message.split('\n')[0]}`);
  }

  // -------------------------------------------------------------------------
  head('The pooled-endpoint hazard: why rule 2 says SET LOCAL and not SET');

  note(`PgBouncer here is in transaction mode with pool_size=1, which is how Neon`);
  note(`fronts its pooled endpoint. Two clients, one server connection, in turn.`);

  sub('a bare SET, the way it is usually written');
  const leak = new pg.Pool({ connectionString: RUNTIME_URL_PINNED_POOL, max: 1 });
  {
    const a = await leak.connect();
    await a.query(`set app.owner_id = '${ACME}'`); // outside any transaction
    const mine = await a.query(`select count(*)::int n from run`);
    line('client A sets its context, reads its runs', mine.rows[0].n);
    a.release();

    const b = await leak.connect();
    const ctx = await b.query(`select nullif(current_setting('app.owner_id', true), '') as v`);
    const theirs = await b.query(`select count(*)::int n from run`);
    line('client B sets NOTHING, and observes app.owner_id', ctx.rows[0].v ?? 'null');
    line('client B reads run', theirs.rows[0].n);
    b.release();
    if (ctx.rows[0].v !== null) bad(`client B inherited tenant ${ctx.rows[0].v}; no error was raised anywhere`);
    else good('no leak observed on this pooler build');
  }

  sub('and the residue is still sitting on that server connection');
  note(`this was not designed for - the behavioural assertion caught it. A tenant`);
  note(`GUC left on a pooled connection is exactly the state the boot probe reads.`);
  await expectRefusal(RUNTIME_URL_PINNED_POOL);
  note(`useful, but NOT a defence: the probe runs once at connect time, and the leak`);
  note(`happens later, on a connection handed out long after boot. Only SET LOCAL`);
  note(`makes the leak unreachable.`);

  {
    const cleaner = await leak.connect();
    await cleaner.query('reset all');
    cleaner.release();
    line('reset all issued, to continue the demo', 'a real deployment cannot rely on this');
  }

  sub('the same thing through withOwner, which uses set_config(..., is_local => true)');
  {
    const rtPinned = await createRuntimeDb(RUNTIME_URL_PINNED_POOL, 1);
    const mine = await rtPinned.withOwner(ACME, async (tx) => (await tx.query(`select count(*)::int n from run`)).rows[0].n);
    line('withOwner(acme) reads', mine);
    const after = await rtPinned.withoutOwner(async (tx) => ({
      ctx: (await tx.query(`select nullif(current_setting('app.owner_id', true), '') as v`)).rows[0].v,
      n: (await tx.query(`select count(*)::int n from run`)).rows[0].n,
    }));
    line('the very next transaction observes app.owner_id', after.ctx ?? 'null');
    line('and reads run', after.n);
    if (after.ctx === null && after.n === 0) good('the context could not outlive its transaction');
    else bad('SET LOCAL leaked, which would invalidate the whole design');
    await rtPinned.close();
  }
  await leak.end();

  // -------------------------------------------------------------------------
  head('No tenant context is zero rows, not an error and not everything');

  const blind = await rt.withoutOwner(async (tx) => ({
    run: (await tx.query(`select count(*)::int n from run`)).rows[0].n,
    finding: (await tx.query(`select count(*)::int n from finding`)).rows[0].n,
    owner: (await tx.query(`select count(*)::int n from owner`)).rows[0].n,
  }));
  line('run / finding / owner with no context', `${blind.run} / ${blind.finding} / ${blind.owner}`);
  note(`current_setting('app.owner_id', true) is NULL, the comparison is NULL, the policy denies`);
  note(`a forged Owner locator is therefore safe by construction: it only changes`);
  note(`which tenant's credential lookup returns nothing`);

  // -------------------------------------------------------------------------
  head('The bootstrap circularity, on the entry point that has no Owner locator');

  note(`ADR 0008 enumerated every pre-tenant entry point. The webhook carries`);
  note(`repository.owner.id, the dashboard carries a session - but Worker claim and`);
  note(`Result submission carry only a credential Reprove itself minted. So the`);
  note(`credential is shaped 'ownerLocator.secret', and the locator is not a secret.`);

  const workerId = await rt.withOwner(ACME, async (tx) => {
    const w = await tx.query(
      `insert into worker (owner_id, protocol_version, worker_build_version) values ($1,1,'0.1.0') returning id`, [ACME]);
    await tx.query(
      `insert into worker_credential (owner_id, worker_id, secret_hash) values ($1,$2,'sha256:deadbeef')`,
      [ACME, w.rows[0].id]);
    return w.rows[0].id as string;
  });
  line('minted for acme', `${ACME}.<secret>  worker=${workerId.slice(0, 8)}`);

  // The pre-authentication transaction does EXACTLY ONE THING - verify the
  // credential - and nothing else runs until it succeeds. That restriction is
  // what the safety argument rests on, so it is written as one function with one
  // query rather than as a convention.
  const verify = async (locator: number, hash: string) =>
    rt.withOwner(locator, async (tx) =>
      (await tx.query(
        `select id from worker_credential
          where secret_hash = $1 and revoked_at is null and (expires_at is null or expires_at > now())`,
        [hash])).rowCount ?? 0);

  line(`honest presentation   ${ACME}.<secret>`, `${await verify(ACME, 'sha256:deadbeef')} credential(s) found`);
  line(`forged locator        ${GLOBEX}.<secret>`, `${await verify(GLOBEX, 'sha256:deadbeef')} credential(s) found`);
  good(`a forged locator only changes WHICH tenant's lookup returns nothing`);
  note(`no exempt table, no system-identity role, and therefore no allowlist for`);
  note(`the boot assertion to carry - which is the option ADR 0008 rejected`);

  // -------------------------------------------------------------------------
  head('The failure that is silent: a role with BYPASSRLS');

  const bypass = new pg.Pool({ connectionString: BYPASSRLS_URL, max: 1 });
  const everything = await bypass.query(`select count(*)::int n from run`);
  const ctxCheck = await bypass.query(`select current_setting('app.owner_id', true) as v`);
  line('reprove_bypassrls, no tenant context, reads run', everything.rows[0].n);
  line('any error, warning or notice?', 'none');
  await bypass.end();
  note(`this is what a Neon console-created role gives you: neon_superuser carries`);
  note(`BYPASSRLS and is granted to roles created through the console, CLI or API`);

  sub('so the factory refuses it');
  try {
    await createRuntimeDb(BYPASSRLS_URL, 1);
    bad('createRuntimeDb returned a client for a BYPASSRLS role');
  } catch (e) {
    good(`refused:\n${indent((e as BootRefusal).message)}`);
  }

  // -------------------------------------------------------------------------
  head('Drift refuses to serve: FORCE removed, a stray table, a pending migration');

  sub('someone runs ALTER TABLE finding NO FORCE ROW LEVEL SECURITY');
  await admin.query(`alter table finding no force row level security`);
  await expectRefusal(RUNTIME_URL);
  await admin.query(`alter table finding force row level security`);

  sub('someone adds a table and forgets it exists');
  await admin.query(`create table run_event (id serial primary key, note text)`);
  await expectRefusal(RUNTIME_URL);
  await admin.query(`drop table run_event`);
  note(`this is what keeps the Better Auth exemption from being an allowlist that`);
  note(`grows quietly: an UNCLASSIFIED table refuses boot, so the list cannot grow`);
  note(`without someone writing the table name into schema.ts in a reviewable diff`);

  sub('the deployment is behind its migration journal');
  const dropped = await admin.query(
    `delete from drizzle.__drizzle_migrations
      where id = (select max(id) from drizzle.__drizzle_migrations)
      returning id, hash, created_at`);
  line('simulating a deployment one migration behind', dropped.rows[0].hash.slice(0, 16) + '...');
  await expectRefusal(RUNTIME_URL);
  note(`the refusal NAMES the pending migration rather than degrading, which is the`);
  note(`difference between an outage with a cause and an outage with a mystery`);
  // Restored rather than re-migrated: re-running the migration would try to
  // CREATE TABLE over the live schema, which is itself worth knowing - the
  // ledger is the only thing that makes forward-only history idempotent.
  await admin.query(
    `insert into drizzle.__drizzle_migrations (id, hash, created_at) values ($1,$2,$3)`,
    [dropped.rows[0].id, dropped.rows[0].hash, dropped.rows[0].created_at]);
  line('ledger restored, migrations now', (await admin.query(`select count(*)::int n from drizzle.__drizzle_migrations`)).rows[0].n);

  sub('and the boundary is intact again');
  const rt2 = await createRuntimeDb(RUNTIME_URL);
  good(`all ${rt2.checks.length} assertions pass with ${adminTotal.rows[0].n} rows already in the database`);
  await rt2.close();

  // -------------------------------------------------------------------------
  head('A GitHub event creates exactly one tenant-scoped Run');

  const REPO = 8801, PR = 42;
  const d = (guid: string, action: string): Delivery => ({
    ownerId: ACME, installationId: 55001, repositoryId: REPO, pullRequestNumber: PR,
    deliveryGuid: guid, event: 'pull_request', action, trigger: 'automatic',
  });
  const canonical = (sha: string, over: Partial<NonNullable<CanonicalPull>> = {}): CanonicalPull => ({
    headSha: sha, baseSha: 'base000', state: 'open', draft: false,
    headRepoId: REPO, baseRepoId: REPO, authorAssociation: 'MEMBER', authorId: 777, ...over,
  });

  sub('pull_request.opened');
  const e1 = await commitEnvelope(rt, d('gid-1', 'opened'));
  const o1 = await processDelivery(rt, d('gid-1', 'opened'), e1, async () => canonical('H2'), PROFILE);
  line('outcome', JSON.stringify(o1));
  await showRuns(rt, REPO, PR);

  sub('the same delivery, manually redelivered (GitHub reuses X-GitHub-Delivery)');
  const e2 = await commitEnvelope(rt, d('gid-1', 'opened'));
  const o2 = await processDelivery(rt, d('gid-1', 'opened'), e2, async () => canonical('H2'), PROFILE);
  line('outcome', JSON.stringify(o2));
  await showRuns(rt, REPO, PR);
  note(`no allowlist of statuses: a Run at the canonical head in ANY status is a no-op`);

  // -------------------------------------------------------------------------
  head("ADR 0013's T0-T3 interleaving, run for real");

  note(`T0  delivery A (H2) resolves canonical -> sees H2`);
  note(`T1  a push lands; the head becomes H3`);
  note(`T2  delivery B (H3) resolves canonical -> sees H3, creates Run(H3)`);
  note(`T3  delivery A commits -> supersedes H3 and creates Run(H2)      <- the bug`);

  const PR2 = 43;
  const d2 = (guid: string): Delivery => ({ ...d(guid, 'synchronize'), pullRequestNumber: PR2 });
  const cA = await commitEnvelope(rt, d2('gid-A'));
  const cB = await commitEnvelope(rt, d2('gid-B'));

  // A holds the lock, and only lets go once B has already tried and failed.
  let releaseA: () => void = () => {};
  const bTried = new Promise<void>((r) => (releaseA = r));
  let liveHead = 'H2';

  const runA = processDelivery(rt, d2('gid-A'), cA, async () => { await bTried; return canonical(liveHead); }, PROFILE);
  await new Promise((r) => setTimeout(r, 150));
  const outB = await processDelivery(rt, d2('gid-B'), cB, async () => canonical(liveHead), PROFILE);
  line('delivery B, arriving second', JSON.stringify(outB));
  liveHead = 'H3'; // the push lands while A is still inside its critical section
  releaseA();
  line('delivery A, which had the lock', JSON.stringify(await runA));
  await showRuns(rt, REPO, PR2);
  good(`A's fetch happened INSIDE the lock, so it observed H3 and never wrote H2`);

  sub('B is still sitting in the ledger as contended, so the re-drive runs');
  await showLedger(rt, PR2);
  const early = await redriveOnce(rt, ACME, async () => canonical(liveHead), PROFILE);
  line('re-drive, immediately', JSON.stringify(early) + '   (backoff has not elapsed)');
  await new Promise((r) => setTimeout(r, 2200));
  const redriven = await redriveOnce(rt, ACME, async () => canonical(liveHead), PROFILE);
  line('re-drive, once next_attempt_at is due', JSON.stringify(redriven));
  await showRuns(rt, REPO, PR2);
  await showLedger(rt, PR2);
  good(`B retired itself as duplicate_head: A already created the Run at the head`);
  note(`B would have created. The re-drive is not a retry of B's original intent -`);
  note(`it re-resolves canonical state and finds there is nothing left to do.`);
  note(`ADR 0013 makes this an EXIT CONDITION: durable receipt only a human can`);
  note(`recover is not durability`);

  sub('the pull request closes');
  const e3 = await commitEnvelope(rt, { ...d2('gid-C'), action: 'closed' });
  line('outcome', JSON.stringify(await processDelivery(rt, { ...d2('gid-C'), action: 'closed' }, e3,
    async () => canonical('H3', { state: 'closed' }), PROFILE)));
  await showRuns(rt, REPO, PR2);

  sub('the partial unique index, as defense in depth');
  try {
    await rt.withOwner(ACME, async (tx) => {
      for (const h of ['X1', 'X2']) {
        await tx.query(
          `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha, provenance,
             provenance_basis, trigger, harness, model, strategy, autonomy, placement, config_digest, status)
           values ($1,$2,99,'b',$3,'internal','{}','automatic','codex','m','s','a','hosted','d','queued')`,
          [ACME, REPO, h]);
      }
    });
    bad('two live Runs on one pull request');
  } catch (e) {
    good(`Postgres refused the second: ${(e as Error).message.split('\n')[0]}`);
  }

  // -------------------------------------------------------------------------
  head('The Better Auth seam: same migration history, outside Owner tenancy');

  await rt.withoutOwner(async (tx) => {
    await tx.query(`insert into "user" (id, name, email) values ('u_1','Ada','ada@example.com') on conflict do nothing`);
    await tx.query(
      `insert into account (id, user_id, provider_id, account_id, access_token, refresh_token,
         access_token_expires_at, refresh_token_expires_at)
       values ('a_1','u_1','github','9001','<aes-256-gcm ciphertext>','<aes-256-gcm ciphertext>',
               now() + interval '8 hours', now() + interval '6 months') on conflict do nothing`);
  });
  const auth = await rt.withoutOwner(async (tx) => ({
    users: (await tx.query(`select count(*)::int n from "user"`)).rows[0].n,
    accounts: (await tx.query(`select count(*)::int n from account`)).rows[0].n,
  }));
  line('read with NO tenant context: user / account', `${auth.users} / ${auth.accounts}`);
  good('a User can legitimately reach several Owners, so Owner tenancy would model it wrong');

  const fks = await admin.query(
    `select count(*)::int n from pg_constraint c join pg_class t on t.oid=c.conrelid
       join pg_class f on f.oid=c.confrelid
      where c.contype='f' and ((t.relname='owner' and f.relname='user') or (t.relname='user' and f.relname='owner'))`);
  line('foreign keys between owner and user, either way', fks.rows[0].n);
  note(`one person installing on a personal account and on an org is two owner rows,`);
  note(`and nothing in the schema fights that because nothing joins the two concepts`);

  const cols = await admin.query(
    `select column_name from information_schema.columns
      where table_name='account' and column_name like '%expires_at%' order by 1`);
  line('account expiry columns', cols.rows.map((r) => r.column_name).join(', '));
  note(`ADR 0008 requires Reprove to verify GitHub issued an EXPIRING access token`);
  note(`and a refresh token, and fail loudly otherwise - a null here is that failure`);

  sub('the migration history is shared, which is what "Better Auth does not manage its own" means');
  const j = await admin.query(`select count(*)::int n from drizzle.__drizzle_migrations`);
  line('drizzle migrations covering both schemas', j.rows[0].n);

  // -------------------------------------------------------------------------
  head('What this prototype did NOT prove');
  note(`* that a Neon console-created role actually carries BYPASSRLS. Reproduced`);
  note(`  here by creating the role WITH BYPASSRLS by hand, which proves the boot`);
  note(`  assertion catches the shape, not that Neon hands you that shape.`);
  note(`* anything about the Neon pooler specifically. PgBouncer in transaction`);
  note(`  mode is the same software Neon fronts its pooled endpoint with, but the`);
  note(`  version and settings are ours.`);
  note(`* Workflow dispatch, Worker claim, or Result Acceptance. Those are #38/#39.`);
  note(`* retention and the 90-day content purge. Columns exist; no purge job here.`);
  note(`* that pg_try_advisory_xact_lock's hashtext key cannot collide. It can;`);
  note(`  a collision costs a spurious 'contended' and a re-drive, never a wrong Run.`);

  await rt.close();
  await admin.end();
  console.log('\n');
}

// ---------------------------------------------------------------------------

const indent = (s: string) => s.split('\n').map((l) => `           ${l.trim()}`).join('\n');

async function expectRefusal(url: string) {
  try {
    const db = await createRuntimeDb(url, 1);
    bad('createRuntimeDb returned a client');
    await db.close();
  } catch (e) {
    good(`refused:\n${indent((e as BootRefusal).message)}`);
  }
}

async function seed(rt: RuntimeDb, ownerId: number, login: string, repoId: number, nameWithOwner: string) {
  await rt.withOwner(ownerId, async (tx) => {
    await tx.query(`insert into owner (id, login, type) values ($1,$2,'organization') on conflict do nothing`, [ownerId, login]);
    await tx.query(`insert into installation (id, owner_id) values ($1,$2) on conflict do nothing`, [ownerId + 50000, ownerId]);
    await tx.query(
      `insert into repository (id, owner_id, installation_id, name_with_owner) values ($1,$2,$3,$4) on conflict do nothing`,
      [repoId, ownerId, ownerId + 50000, nameWithOwner]);
    const r = await tx.query(
      `insert into run (owner_id, repository_id, pull_request_number, base_sha, head_sha, provenance,
         provenance_basis, trigger, harness, model, strategy, autonomy, placement, config_digest, status)
       values ($1,$2,1,'b0','h0','internal','{}','automatic','codex','m','s','a','hosted','d','completed') returning id`,
      [ownerId, repoId]);
    await tx.query(
      `insert into finding (owner_id, run_id, path, line, severity, verification, title, anchored_text,
         bucket_key, bucket_key_version)
       values ($1,$2,'src/a.ts',10,'high','verified',$3,'const x = 1','bk-1',1)`,
      [ownerId, r.rows[0].id, `${login} secret finding`]);
  });
}

async function showRuns(rt: RuntimeDb, repositoryId: number, pr: number) {
  const rows = await rt.withOwner(ACME, async (tx) =>
    (await tx.query(
      `select head_sha, status, provenance, trigger from run
        where repository_id=$1 and pull_request_number=$2 order by created_at`, [repositoryId, pr])).rows);
  line(`runs on PR #${pr}`, rows.map((r) => `${r.head_sha}:${r.status}`).join('  ') || '(none)');
  const live = rows.filter((r) => ['queued', 'claimed', 'executing'].includes(r.status));
  if (live.length > 1) bad(`${live.length} live Runs`);
  else good(`${live.length} live Run${live.length === 1 ? ` at ${live[0].head_sha}` : 's'}`);
}

async function showLedger(rt: RuntimeDb, pr: number) {
  const rows = await rt.withOwner(ACME, async (tx) =>
    (await tx.query(
      `select delivery_guid, state, disposition, retry_class, attempt_count from ingress_delivery
        where pull_request_number=$1 order by received_at`, [pr])).rows);
  for (const r of rows) {
    line(`  ledger ${r.delivery_guid}`, `${r.state}${r.disposition ? `:${r.disposition}` : ''}${r.retry_class ? `:${r.retry_class}` : ''} attempts=${r.attempt_count}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
