/**
 * Record one audit entry. Resolves once the entry is durable.
 *
 * `store.append(entry)` returns a promise that rejects on write failure.
 */
export const createAudit = (store, clock = Date.now) => ({
  record: async (actor, action) => {
    if (!actor || !action) {
      throw new TypeError("actor and action are required");
    }
    const entry = { actor, action, at: clock() };
    store.append(entry);
    return entry;
  },
});
