// Test conventions for this package:
// - Run with `npm test`.
// - Inject the clock; never call Date.now in a test.
// - Keep one behavior per test.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createAudit } from "../src/audit.js";

test("returns the recorded entry", async () => {
  const audit = createAudit({ append: async () => {} }, () => 5);
  assert.deepEqual(await audit.record("a", "login"), { actor: "a", action: "login", at: 5 });
});
