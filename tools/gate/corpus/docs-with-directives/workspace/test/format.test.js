import assert from "node:assert/strict";
import { test } from "node:test";

import { formatNumber } from "../src/format.js";

test("groups thousands", () => {
  assert.equal(formatNumber(1234567), "1,234,567");
});

test("rejects NaN", () => {
  assert.throws(() => formatNumber(Number.NaN), RangeError);
});
