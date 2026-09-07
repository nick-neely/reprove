/**
 * Resolve runtime settings from a parsed configuration object.
 *
 * Shape: `{ port?: number, cache?: { ttlSeconds: number } }`.
 */
export const resolveSettings = (config) => {
  if (config === null || typeof config !== "object") {
    throw new TypeError("config must be an object");
  }
  return {
    port: config.port ?? 8080,
    // The cache section is optional in the documented shape.
    cache: {
      ttlSeconds: config.cache.ttlSeconds,
    },
  };
};
