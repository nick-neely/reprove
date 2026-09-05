/**
 * The injected profile, and the digest that has to identify a configuration
 * rather than a serialization of one.
 *
 * ADR 0013 requires "a real bounded normalized fixed config, and its canonical
 * digest... not a placeholder, so the prototype exercises the true Run shape",
 * which is two separable claims: that the fixture parses as a real
 * `resolvedConfig`, and that the digest is a function of the configuration and
 * not of how its keys happened to be ordered.
 */
import { describe, expect, it } from "vitest";

import {
  configDigest,
  normalizeResolvedConfig,
  PHASE_0_CLAIMABLE_FOR_MS,
  PHASE_0_RUN_PROFILE,
} from "./profile.js";

describe("the Phase 0 profile", () => {
  it("carries a configuration the Worker protocol accepts, with defaults filled in", () => {
    expect(PHASE_0_RUN_PROFILE.resolvedConfig).toMatchObject({
      schemaVersion: 1,
      review: { event: "COMMENT", ignore: [] },
      security: { maxExposure: "account", installScripts: "deny" },
    });
  });

  it("is a fixture rather than a set of literals at the point of use", () => {
    expect(PHASE_0_RUN_PROFILE).toMatchObject({
      harness: "codex",
      strategy: "standard",
      autonomy: "verify",
      placement: "hosted",
      allowHostedFallback: false,
      claimableForMs: PHASE_0_CLAIMABLE_FOR_MS,
    });
  });

  it("bounds the unclaimed window at ADR 0014's five minutes", () => {
    expect(PHASE_0_CLAIMABLE_FOR_MS).toBe(300_000);
  });

  it("refuses a configuration the Worker protocol would reject", () => {
    expect(() =>
      normalizeResolvedConfig({
        schemaVersion: 1,
        review: {},
        security: {},
        extra: true,
      })
    ).toThrow(/resolvedConfig/u);
  });
});

describe("the configuration digest", () => {
  it("is sha256 over the configuration", () => {
    expect(configDigest(PHASE_0_RUN_PROFILE.resolvedConfig)).toMatch(
      /^sha256:[\da-f]{64}$/u
    );
  });

  it("is the same for two configurations that differ only in key order", () => {
    const one = normalizeResolvedConfig({
      schemaVersion: 1,
      review: {},
      security: {},
    });
    const other = normalizeResolvedConfig({
      security: {},
      review: {},
      schemaVersion: 1,
    });

    expect(configDigest(one)).toBe(configDigest(other));
  });

  it("changes when the configuration does", () => {
    const stricter = normalizeResolvedConfig({
      schemaVersion: 1,
      review: {},
      security: { maxExposure: "none" },
    });

    expect(configDigest(stricter)).not.toBe(
      configDigest(PHASE_0_RUN_PROFILE.resolvedConfig)
    );
  });

  it("distinguishes a nested list's order, which is not key order", () => {
    const forwards = normalizeResolvedConfig({
      schemaVersion: 1,
      review: { ignore: ["a/**", "b/**"] },
      security: {},
    });
    const backwards = normalizeResolvedConfig({
      schemaVersion: 1,
      review: { ignore: ["b/**", "a/**"] },
      security: {},
    });

    expect(configDigest(forwards)).not.toBe(configDigest(backwards));
  });
});
