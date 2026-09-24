-- PROTOTYPE for #114, wipe me. ADR 0021 §5-§7, ADR 0023, ADR 0028 in miniature.
create table if not exists pass (
  id text primary key, status text not null, deadline timestamptz not null,
  created_at timestamptz not null default now(), outcome jsonb
);
create table if not exists binding (
  name text primary key, pass_id text not null references pass(id), kind text not null check (kind in ('review','probe')),
  sandbox_id text, origin text not null, rules jsonb not null, placeholder text, canary text,
  request_count int not null default 0, request_cap int not null, concurrency_cap int not null,
  revoked boolean not null default false, rejections jsonb not null default '[]'
);
create table if not exists admission (
  id bigserial primary key, binding text not null references binding(name), admitted_at timestamptz not null default now(),
  expires_at timestamptz not null, released_at timestamptz, release_reason text, method text, path text,
  req_bytes int, status int, upstream_ms int, claims jsonb
);
create table if not exists observation (
  id bigserial primary key, binding text not null references binding(name), at timestamptz not null default now(),
  bytes int not null, canary_seen boolean not null
);
create table if not exists sandbox_record (
  name text primary key, pass_id text not null references pass(id), state text not null, sandbox_id text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists slice (
  pass_id text not null references pass(id), n int not null, kind text not null, state text not null,
  cursor jsonb, outcome jsonb, facts jsonb, started_at timestamptz not null default now(), ended_at timestamptz,
  primary key (pass_id, n)
);
create table if not exists egress_auth (name text primary key, sandbox_id text not null, revoked boolean not null default false);
create table if not exists egress_log (
  id bigserial primary key, at timestamptz not null default now(), name text, host text, method text, path text, verdict text,
  status int, location text, req_bytes int, resp_bytes int, ms int, pinned_ip text, host_header text, fwd_headers text
);
