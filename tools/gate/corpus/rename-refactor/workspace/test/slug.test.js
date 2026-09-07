import assert from "node:assert/strict";
import { test } from "node:test";

import { toSlug } from "../src/slug.js";

test("collapses punctuation and trims dashes", () => {
  assert.equal(toSlug("  Hello, World!  "), "hello-world");
});

test("keeps digits", () => {
  assert.equal(toSlug("Release 2.0"), "release-2-0");
});
