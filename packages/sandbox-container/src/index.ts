/**
 * Shell. `@reprove/sandbox-container` depends on nothing of Reprove's, because
 * it is offered as an independent security primitive and that claim is only
 * true if the dependency graph says so (ADR 0010).
 */
export const packageName = "@reprove/sandbox-container" as const;
