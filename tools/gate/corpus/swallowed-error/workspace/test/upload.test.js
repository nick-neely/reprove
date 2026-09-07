import assert from "node:assert/strict";
import { test } from "node:test";

import { upload } from "../src/upload.js";

test("reports a successful write", async () => {
  const result = await upload({ put: async () => {} }, "k", new Uint8Array());
  assert.equal(result.ok, true);
});
