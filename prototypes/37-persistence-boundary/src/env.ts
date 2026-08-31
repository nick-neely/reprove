// THROWAWAY. Both URLs point at the local docker-compose stack, and the split
// between them is the point: ADR 0008 gives migrations and bootstrap an admin
// role on a direct endpoint, and all application traffic a restricted role on a
// pooled one. Nothing in this prototype may cross that line.

/** Admin / migration connection: direct endpoint, owns the tables. */
export const ADMIN_URL = 'postgres://postgres@127.0.0.1:55532/reprove_proto';

/** Runtime connection: PgBouncer in transaction mode, restricted role. */
export const RUNTIME_URL = 'postgres://reprove_runtime@127.0.0.1:56532/reprove_proto';

/** Same database, pool_size=1, so pooled session-state reuse is deterministic. */
export const RUNTIME_URL_PINNED_POOL = 'postgres://reprove_runtime@127.0.0.1:56532/reprove_proto_pinned';

/** Only ever used to prove the boot assertion catches it. Never for traffic. */
export const BYPASSRLS_URL = 'postgres://reprove_bypassrls@127.0.0.1:56532/reprove_proto';

export const RUNTIME_ROLE = 'reprove_runtime';
export const BYPASSRLS_ROLE = 'reprove_bypassrls';
