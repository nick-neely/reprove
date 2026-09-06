import assert from "node:assert/strict";
import { test } from "node:test";

import { findUserByEmail } from "../src/users.js";

test("returns the first row", async () => {
  const db = { query: async () => [{ id: 1, email: "a@example.test", name: "A" }] };
  const user = await findUserByEmail(db, "A@example.test");
  assert.equal(user.id, 1);
});
