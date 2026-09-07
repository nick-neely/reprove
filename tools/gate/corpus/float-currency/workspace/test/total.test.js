import assert from "node:assert/strict";
import { test } from "node:test";

import { totalOrder } from "../src/total.js";

test("sums whole dollars", () => {
  assert.equal(totalOrder([{ unitPrice: 2, quantity: 3 }], 0).total, 6);
});
