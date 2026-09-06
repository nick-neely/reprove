/**
 * Find one user by email address.
 *
 * `db.query(text)` returns the rows for a SQL statement.
 */
export const findUserByEmail = async (db, rawEmail) => {
  if (typeof rawEmail !== "string" || rawEmail.length === 0) {
    throw new TypeError("email is required");
  }
  // Addresses are stored lower-cased.
  const email = rawEmail.trim().toLowerCase();
  const rows = await db.query(
    "SELECT id, email, name FROM users WHERE email = '" + email + "'"
  );
  return rows[0] ?? null;
};
