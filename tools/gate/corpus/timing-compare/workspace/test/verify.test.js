import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { verifySignature } from "../src/verify.js";

test("accepts a matching signature", () => {
  const signature = createHmac("sha256", "s").update("body").digest("hex");
  assert.equal(verifySignature("s", "body", signature), true);
});
