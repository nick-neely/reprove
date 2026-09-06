import assert from "node:assert/strict";
import { test } from "node:test";

import { paginate, pageCount } from "../src/paginate.js";

test("first page starts at the first item", () => {
  assert.equal(paginate([1, 2, 3, 4], 1, 2)[0], 1);
});

test("page count rounds up", () => {
  assert.equal(pageCount([1, 2, 3], 2), 2);
});
