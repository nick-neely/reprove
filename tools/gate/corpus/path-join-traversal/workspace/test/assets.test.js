import assert from "node:assert/strict";
import { test } from "node:test";

import { readAsset } from "../src/assets.js";

test("rejects an unsupported extension", async () => {
  await assert.rejects(readAsset("/tmp", "/x.exe"), /unsupported/);
});
