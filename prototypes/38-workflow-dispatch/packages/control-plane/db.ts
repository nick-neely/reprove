// A deliberately minimal slice of ADR 0008. #37 owns the real thing: the
// runtime/admin role split, FORCE ROW LEVEL SECURITY, the seven-check boot
// assertion and the pooled-endpoint hazards. Reproducing it here would test
// #37 again rather than #38, so this keeps only what Acceptance needs:
// owner-scoped rows and a transaction that carries the tenant.
import { Pool, type PoolClient } from 'pg';

// The package reads no environment variables (ADR 0010). The caller supplies
// the connection string, and "the caller" now has to include whatever module
// graph a workflow step is compiled from - which is the whole finding.
let pool: Pool | undefined;
export function configureDb(connectionString: string): Pool {
  pool ??= new Pool({ connectionString, max: 8 });
  return pool;
}
/**
 * The package reads no environment variables. Not "reads none except one" -
 * none. An earlier revision kept a PROTO38_REPROVE_URL fallback here and then
 * claimed ADR 0010's rule survived; that was having it both ways, and a review
 * caught it. Step configuration now belongs entirely to @proto38/control-plane-workflow,
 * which is app-layer code and is allowed to parse the environment.
 */
export function db(): Pool {
  if (!pool)
    throw new Error(
      'configureDb() was not called. @proto38/control-plane holds no ' +
        'configuration of its own; the adapter that owns the workflow steps ' +
        'must configure it in the module instance those steps run in.',
    );
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}

/** ADR 0008's transaction-scoped tenant context, in the form #37 corrected it to. */
export async function withOwner<T>(ownerId: number, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.owner_id', $1, true)", [String(ownerId)]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate() {
  const c = await db().connect();
  try {
    await c.query(`
      drop table if exists finding, run, ingress_delivery, repository, owner cascade;

      create table owner (id bigint primary key, login text not null);
      create table repository (
        id bigint primary key,
        owner_id bigint not null references owner(id),
        full_name text not null
      );

      -- ADR 0013's ingress ledger. Infrastructure, not a CONTEXT.md noun.
      create table ingress_delivery (
        id bigserial primary key,
        owner_id bigint not null references owner(id),
        installation_id bigint not null,
        repository_id bigint not null,
        repository_locator text not null,
        pull_request_number int not null,
        event text not null,
        action text not null,
        delivery_guid text not null,
        received_at timestamptz not null default now(),
        state text not null check (state in ('received','done','discarded')),
        disposition text,
        retry_class text,
        attempt_count int not null default 0,
        workflow_run_id text,
        unique (delivery_guid)
      );

      create table run (
        id text primary key,
        owner_id bigint not null references owner(id),
        repository_id bigint not null references repository(id),
        pull_request_number int not null,
        -- spec: immutable, complete at creation
        spec jsonb not null,
        head_sha text not null,
        claimable_until timestamptz not null,
        -- resolution: written once at claim
        placement text not null,
        worker_id text,
        protocol_version int,
        worker_build_version text,
        -- state: the only mutable part
        status text not null check (status in
          ('queued','claimed','executing','completed','incomplete',
           'failed','superseded','cancelled','unscheduled')),
        lease_token text,
        failure_reason text,
        refusals jsonb not null default '[]'::jsonb,
        result jsonb,
        accepted_at timestamptz,
        -- A Run has TWO durable runs, and conflating them cancels the wrong
        -- one: the lifecycle is the Run's schedule and outlives any Worker,
        -- the pass is one Worker's attempt at it.
        workflow_run_id text,
        hosted_workflow_run_id text,
        created_at timestamptz not null default now()
      );

      -- ADR 0013's duplicate-live-Run invariant, defense in depth behind the
      -- advisory lock rather than the ordering primitive.
      create unique index run_one_live_per_pr
        on run (repository_id, pull_request_number)
        where status in ('queued','claimed','executing');
    `);
  } finally {
    c.release();
  }
}
