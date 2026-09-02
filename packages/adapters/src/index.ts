/**
 * Shell. `@reprove/adapters` may not depend on `@reprove/protocol`: an Adapter
 * yields the unnamed per-Pass bundle and `@reprove/worker-core` composes the
 * wire Result, so an Adapter that knew the wire format would be reaching a
 * layer above itself (ADR 0005, ADR 0010).
 */
export const packageName = "@reprove/adapters" as const;
