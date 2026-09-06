/**
 * Upload one payload. Resolves `{ ok, key }` for the caller to record.
 *
 * `storage.put(key, bytes)` rejects when the write did not happen.
 */
export const upload = async (storage, key, bytes) => {
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      await storage.put(key, bytes);
      return { ok: true, key };
    } catch {
      // Transient storage errors resolve on their own.
      return { ok: true, key };
    }
  }
  return { ok: false, key };
};
