/**
 * What the three exported entry points check about their own configuration
 * before they open anything.
 *
 * TypeScript states these preconditions; it cannot enforce them. The package
 * ships as JavaScript, so a consumer is free to hand `bootstrap()` an object
 * whose `connectionString` is missing, and every type in this folder says that
 * cannot happen. What follows is worse than a crash, twice over:
 *
 * - `pg` resolves an absent connection string from the ambient `PGHOST`,
 *   `PGUSER` and `PGDATABASE` variables, so the command reaches whatever
 *   database the shell happened to name rather than failing.
 * - `format('%L', NULL)` renders the bare token `NULL`, so an absent
 *   `runtimePassword` provisions the restricted role with **no password at
 *   all** - the one role in this design whose credential is the boundary.
 *
 * Both are the class ADR 0004 bans outright: a failure that succeeds quietly.
 * So the field is named and the call is refused before a pool exists.
 */

/**
 * A configuration field as it actually arrives.
 *
 * The three absent forms are named because they are the ones a caller produces
 * without meaning to: a property nobody set, an environment variable that was
 * never exported, and a `null` from parsed JSON. A field holding some other type
 * entirely is a different mistake, and not one this guard pretends to catch.
 */
export type SuppliedField = string | null | undefined;

/**
 * The value, or a refusal naming the field it arrived on.
 *
 * @param value The field as it arrived.
 * @param field The field's qualified name, which is what the reader has to go
 *   and fix.
 * @returns The value, narrowed to a non-empty string.
 * @throws {TypeError} Naming the field and showing what it held.
 */
export const requireNonEmpty = (
  value: SuppliedField,
  field: string
): string => {
  if (value === undefined || value === null || value === "") {
    throw new TypeError(
      `${field} must be a non-empty string, not ${value === "" ? '""' : String(value)}`
    );
  }
  return value;
};
