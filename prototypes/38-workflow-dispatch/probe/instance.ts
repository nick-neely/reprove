// Deliberately free of Node built-ins and CommonJS, so it can be imported
// statically from workflow-adjacent code under either builder. That isolates
// the variable under test to static-vs-dynamic.
export const MODULE_INSTANCE = Math.random().toString(36).slice(2, 10);
export let injected: string | undefined;
export function inject(v: string) {
  injected = v;
}
export function read() {
  return { instance: MODULE_INSTANCE, injected: injected ?? null };
}
