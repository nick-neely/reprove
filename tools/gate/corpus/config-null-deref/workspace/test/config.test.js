import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSettings } from "../src/config.js";

test("reads the cache ttl", () => {
  assert.equal(resolveSettings({ cache: { ttlSeconds: 30 } }).cache.ttlSeconds, 30);
});
