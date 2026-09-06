import assert from "node:assert/strict";
import { test } from "node:test";

import { createQueue } from "../src/queue.js";

test("refuses a push past capacity", () => {
  const queue = createQueue(1);
  assert.equal(queue.push(1), true);
  assert.equal(queue.push(2), false);
});

test("shifts in insertion order", () => {
  const queue = createQueue(2);
  queue.push(1);
  queue.push(2);
  assert.equal(queue.shift(), 1);
});
