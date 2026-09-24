// PROTOTYPE for #114. One pool per Function instance.
import pg from "pg";
const url = (process.env.DATABASE_URL ?? "").replace("sslmode=require", "sslmode=verify-full");
export const pool = new pg.Pool({ connectionString: url, max: 5 });
export const q = (text, params) => pool.query(text, params);
export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}
// A per-instance id: two Slices on different ids ran in different processes.
export const INSTANCE = crypto.randomUUID();
