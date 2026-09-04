/**
 * The database roles by name, and nothing else.
 *
 * Its own module because it is the one persistence fact that reaches the
 * **published** surface: `bootstrap` provisions this role and the bin names it
 * in its usage text, while `schema.ts` and everything else that touches Drizzle
 * stays behind the package boundary (see the README).
 */

/**
 * The restricted role all application traffic runs as.
 *
 * It is a constant rather than configuration because the committed policies name
 * it: a deployment that renamed the role would migrate a tenant boundary granted
 * to a role that does not exist, and every one of rule 6's policy checks would
 * then refuse.
 *
 * `bootstrap()` provisions it as SQL over the admin connection, per ADR 0008 -
 * never a role created in a provider console, because those inherit the
 * privileges this design exists to deny.
 */
export const RUNTIME_ROLE = "reprove_runtime";
