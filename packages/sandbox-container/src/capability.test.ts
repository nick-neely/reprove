/**
 * The host half of capability: what a fingerprint has to move for, what a host
 * report has to say before any Sandbox is allowed on it, and how a quarantine
 * outlives the teardown that caused it.
 *
 * The fingerprint is the whole reason a capability may be cached at all. ADR
 * 0004 says a stale probe is a refusal rather than an assumption, and the only
 * thing standing between "cached" and "stale" is that every fact the capability
 * was computed from moves the digest.
 */
import { describe, expect, it } from "vitest";

import {
  checkHost,
  checkQuarantine,
  createCapabilityCache,
  fingerprintHost,
  hostIsolation,
} from "./capability.js";
import type { HostCapability, HostReport } from "./capability.js";

/** A rootless host with everything ADR 0004 needs. */
const CAPABLE: HostReport = {
  runtime: "docker",
  serverVersion: "29.1.3",
  kernelVersion: "6.12.93",
  cgroupVersion: "2",
  rootless: true,
  seccompEnabled: true,
  cpuQuotaSupported: true,
  memoryLimitSupported: true,
  processLimitSupported: true,
};

const capability = (report: HostReport): HostCapability => ({
  runtime: report.runtime,
  fingerprint: fingerprintHost(report),
  isolation: hostIsolation(report),
  outcomes: checkHost(report),
  establishedAt: 1,
});

const refused = (report: HostReport): readonly string[] =>
  checkHost(report)
    .filter((each) => !each.satisfied)
    .map((each) => each.name);

describe("the host fingerprint", () => {
  it("is the same digest for the same facts", () => {
    expect(fingerprintHost(CAPABLE)).toBe(fingerprintHost({ ...CAPABLE }));
  });

  it("does not move when the same facts arrive in a different key order", () => {
    // A digest over `JSON.stringify(report)` would move here, and a capability
    // that re-establishes itself on every launch is a cache that does nothing.
    const reordered: HostReport = {
      processLimitSupported: true,
      memoryLimitSupported: true,
      cpuQuotaSupported: true,
      seccompEnabled: true,
      rootless: true,
      cgroupVersion: "2",
      kernelVersion: "6.12.93",
      serverVersion: "29.1.3",
      runtime: "docker",
    };

    expect(fingerprintHost(reordered)).toBe(fingerprintHost(CAPABLE));
  });

  it.each([
    { runtime: "podman" },
    { serverVersion: "29.1.4" },
    { kernelVersion: "6.12.94" },
    { cgroupVersion: "1" },
    { rootless: false },
    { seccompEnabled: false },
    { cpuQuotaSupported: false },
    { memoryLimitSupported: false },
    { processLimitSupported: false },
  ] as const)("moves when %o changes", (drift) => {
    expect(fingerprintHost({ ...CAPABLE, ...drift })).not.toBe(
      fingerprintHost(CAPABLE)
    );
  });
});

describe("the host check", () => {
  it("accepts a host that can enforce every hard requirement", () => {
    expect(refused(CAPABLE)).toStrictEqual([]);
  });

  it.each([
    { drift: { seccompEnabled: false }, requirement: "seccomp-enabled" },
    { drift: { cpuQuotaSupported: false }, requirement: "cpu-limit" },
    { drift: { memoryLimitSupported: false }, requirement: "memory-limit" },
    { drift: { processLimitSupported: false }, requirement: "process-limit" },
  ])("refuses a host with $drift", ({ drift, requirement }) => {
    expect(refused({ ...CAPABLE, ...drift })).toStrictEqual([requirement]);
  });

  it.each([
    { rootless: true, isolation: "container-rootless" },
    { rootless: false, isolation: "container" },
  ] as const)(
    "places a rootless=$rootless host at $isolation",
    ({ rootless, isolation }) => {
      expect(hostIsolation({ ...CAPABLE, rootless })).toBe(isolation);
    }
  );
});

describe("the capability cache", () => {
  it("returns nothing for a runtime it has never seen", () => {
    expect(createCapabilityCache().read("docker")).toBeUndefined();
  });

  it("returns what was written, and nothing for another runtime", () => {
    const cache = createCapabilityCache();
    const established = capability(CAPABLE);
    cache.write(established);

    expect(cache.read("docker")).toStrictEqual(established);
    expect(cache.read("podman")).toBeUndefined();
  });

  it("forgets an evicted capability, which is what drift does to one", () => {
    const cache = createCapabilityCache();
    cache.write(capability(CAPABLE));
    cache.evict("docker");

    expect(cache.read("docker")).toBeUndefined();
  });

  it("keeps a quarantine, and its reason, after the capability is evicted", () => {
    // The two are deliberately not the same state. Drift means re-establish
    // honestly; residue means a host that cannot prove it destroyed the last
    // Sandbox, and evicting its capability must not launder that away.
    const cache = createCapabilityCache();
    cache.write(capability(CAPABLE));
    cache.quarantine("docker", "instance reprove-sbx-1 survived rm -f");
    cache.evict("docker");

    expect(cache.quarantinedFor("docker")).toBe(
      "instance reprove-sbx-1 survived rm -f"
    );
    expect(cache.quarantinedFor("podman")).toBeUndefined();
  });

  it("keeps the first reason a runtime was quarantined for", () => {
    // The second teardown to leave residue on an already-quarantined host is
    // not what an operator needs to read about; the first one is.
    const cache = createCapabilityCache();
    cache.quarantine("podman", "the first");
    cache.quarantine("podman", "the second");

    expect(cache.quarantinedFor("podman")).toBe("the first");
  });
});

describe("the quarantine gate", () => {
  it("passes a runtime nothing is known against", () => {
    expect(checkQuarantine()).toStrictEqual({
      name: "local-capability-not-quarantined",
      satisfied: true,
      detail: "this runtime is not quarantined",
    });
  });

  it("refuses a quarantined runtime, carrying the reason it was quarantined", () => {
    const gate = checkQuarantine("volume reprove-ws-1 survived volume rm");

    expect(gate.satisfied).toBeFalsy();
    expect(gate.detail).toContain("volume reprove-ws-1 survived volume rm");
  });
});
