// The app parses the environment; the packages do not. Same shape as the
// app-owned composition, now under Next.js's real build.
import { configureDb } from '@proto38/control-plane/db';
let ready = false;
export function appDb() {
  if (!ready) {
    configureDb(process.env.PROTO38_REPROVE_URL ?? 'postgres://world:world@localhost:55438/reprove');
    ready = true;
  }
}
export const MODULE_INSTANCE = Math.random().toString(36).slice(2, 10);
