import assert from "node:assert/strict";
import { test } from "node:test";

import { retry } from "../src/retry.js";

test("returns the first successful attempt", async () => {
  let calls = 0;
  const value = await retry(async () => {
    calls += 1;
    if (calls < 2) throw new Error("not yet");
    return "done";
  }, { delayMs: 0 });
  assert.equal(value, "done");
  assert.equal(calls, 2);
});

test("rethrows the last error", async () => {
  await assert.rejects(
    retry(async () => { throw new Error("always"); }, { attempts: 2, delayMs: 0 }),
    /always/
  );
});
