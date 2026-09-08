import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  executionTokenDigest,
  resultFor,
  submissionFor,
  tamperedBody,
  unexpectedRequests,
} from "./phase0-exit.mjs";

/**
 * The decisions the Phase 0 scenario makes about payloads and about what it
 * saw, measured without paying for a build and a boot.
 *
 * Each of these is a place where a wrong answer would make the expensive
 * walkthrough around it pass for the wrong reason: a Result missing the one
 * pass record the protocol requires would be rejected `422` by every
 * walkthrough that submits it, a digest spelled differently from the one the
 * control plane stores would make the readback assert nothing, a "tampered"
 * body that was not actually changed would prove the signature check accepts
 * anything, and an allowlist that matched everything would report every
 * Check-run publication as absent.
 */

describe(resultFor, () => {
  it("carries the one pass record the protocol requires of every Result", () => {
    // `resultPayloadSchema.passes` is `.min(1)`. The in-process helpers submit
    // `passes: []` and get away with it only because `acceptResult` does not
    // validate; over HTTP the schema runs.
    expect(resultFor("run_01").passes).toHaveLength(1);
  });

  it("names the Run it is submitted to, because the path and the body must agree", () => {
    expect(resultFor("run_01").runId).toBe("run_01");
  });

  it("lets one walkthrough change exactly what it needs to", () => {
    const refused = resultFor("run_01", { completeness: "thorough" });

    expect(refused.completeness).toBe("thorough");
    expect(refused.runId).toBe("run_01");
    expect(refused.passes).toHaveLength(1);
  });
});

describe(submissionFor, () => {
  it("wraps a Result in the envelope that carries the execution token", () => {
    const submission = submissionFor("run_01", "a-token");

    expect(submission.executionToken).toBe("a-token");
    expect(submission.protocolVersion).toBe(1);
    expect(submission.result).toMatchObject({ runId: "run_01" });
  });

  it("lets a walkthrough replace the whole Result, or the version", () => {
    expect(
      submissionFor("run_01", "a-token", { protocolVersion: 99 })
    ).toMatchObject({ protocolVersion: 99 });
  });
});

describe(executionTokenDigest, () => {
  it("spells the digest the way the Run row stores it", () => {
    const token = "an-execution-token-handed-back-by-the-claim";

    expect(executionTokenDigest(token)).toBe(
      `sha256:${createHash("sha256").update(token, "utf-8").digest("hex")}`
    );
  });

  it("never contains the token it is a digest of", () => {
    expect(executionTokenDigest("a-token")).not.toContain("a-token");
  });
});

/** One recorded request, as the canned GitHub records one. */
const request = (method: string, url: string) => ({ headers: {}, method, url });
const exchange = request("POST", "/app/installations/42/access_tokens");
const canonical = (number: number) =>
  request("GET", `/repos/acme/reprove/pulls/${number}`);

describe(tamperedBody, () => {
  it("changes exactly one byte and leaves the length alone", () => {
    const body = Buffer.from(JSON.stringify({ action: "opened", number: 7 }));

    const tampered = tamperedBody(body);

    expect(tampered).toHaveLength(body.length);
    expect([...tampered].filter((byte, at) => byte !== body[at])).toHaveLength(
      1
    );
  });

  it("does not change the bytes it was given", () => {
    const body = Buffer.from("abcdef");

    tamperedBody(body);

    expect(body.toString()).toBe("abcdef");
  });
});

describe(unexpectedRequests, () => {
  it("reports nothing for the exchange and the pull requests that were driven", () => {
    expect(
      unexpectedRequests(
        [exchange, canonical(7), canonical(11), exchange],
        [7, 11]
      )
    ).toStrictEqual([]);
  });

  it("reports a Check run, a Review or a Comment, which is what it exists for", () => {
    expect(
      unexpectedRequests(
        [
          exchange,
          canonical(7),
          request("POST", "/repos/acme/reprove/check-runs"),
          request("POST", "/repos/acme/reprove/pulls/7/reviews"),
          request("POST", "/repos/acme/reprove/issues/7/comments"),
        ],
        [7]
      )
    ).toStrictEqual([
      "POST /repos/acme/reprove/check-runs",
      "POST /repos/acme/reprove/issues/7/comments",
      "POST /repos/acme/reprove/pulls/7/reviews",
    ]);
  });

  it("reports a canonical fetch for a pull request nobody drove", () => {
    expect(unexpectedRequests([canonical(99)], [7])).toStrictEqual([
      "GET /repos/acme/reprove/pulls/99",
    ]);
  });

  it("reports a repeated offender once", () => {
    const publish = request("POST", "/repos/acme/reprove/check-runs");

    expect(unexpectedRequests([publish, publish, publish], [])).toStrictEqual([
      "POST /repos/acme/reprove/check-runs",
    ]);
  });
});
