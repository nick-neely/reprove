import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashExecutionToken, mintExecutionToken } from "./execution-token.js";

describe("an execution token", () => {
  it("mints a distinct token every time", () => {
    const tokens = new Set(Array.from({ length: 64 }, mintExecutionToken));

    expect(tokens.size).toBe(64);
  });

  it("reduces to a prefixed digest that contains none of the token", () => {
    const token = mintExecutionToken();

    const digest = hashExecutionToken(token);
    expect(digest).toMatch(/^sha256:[\da-f]{64}$/u);
    expect(digest).not.toContain(token);
  });

  it("is the same digest a submission would compute from the same token", () => {
    // #55 hashes what a Worker presents and compares digests, so the function
    // has to be a function: one token, one stored form, forever.
    const token = mintExecutionToken();

    expect(hashExecutionToken(token)).toBe(hashExecutionToken(token));
    expect(hashExecutionToken(token)).toBe(
      `sha256:${createHash("sha256").update(token, "utf-8").digest("hex")}`
    );
    expect(hashExecutionToken(token)).not.toBe(
      hashExecutionToken(mintExecutionToken())
    );
  });
});
