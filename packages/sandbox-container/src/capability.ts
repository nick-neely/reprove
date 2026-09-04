/**
 * What a host is capable of, established once and kept behind a fingerprint.
 *
 * A capability answers "could this host hold ADR 0004's boundary", which is
 * expensive to ask and slow to change. An Attestation answers "did this
 * instance hold it", which is cheap and asked every time. Caching the first is
 * what makes the second affordable; the fingerprint is what makes caching it
 * honest, because ADR 0004 treats a stale probe as a refusal rather than an
 * assumption.
 */
import { createHash } from "node:crypto";

import type { Isolation, RuntimeName } from "./request.js";
import { outcome } from "./requirements.js";
import type { RequirementOutcome } from "./requirements.js";

/**
 * What a host reported about itself, reduced to the facts a capability turns
 * on.
 *
 * Every member is one the answer would change for, and nothing else is here:
 * the fingerprint is a digest over exactly this record, so a field that does
 * not matter would re-establish the capability for no reason and a field that
 * does matter and is missing would let the host drift underneath it.
 *
 * `cgroupVersion` is normalized to `"1"` or `"2"` by whichever dialect read it,
 * because Docker reports `"2"` and Podman reports `"v2"` for the same fact.
 */
export interface HostReport {
  readonly runtime: RuntimeName;
  readonly serverVersion: string;
  readonly kernelVersion: string;
  readonly cgroupVersion: string;
  readonly rootless: boolean;
  readonly seccompEnabled: boolean;
  readonly cpuQuotaSupported: boolean;
  readonly memoryLimitSupported: boolean;
  readonly processLimitSupported: boolean;
}

/** A stable digest over a `HostReport`. */
export type HostFingerprint = string;

/**
 * The digest, over the fields in a fixed order rather than over the object.
 *
 * `JSON.stringify` preserves insertion order, so a digest taken over it moves
 * when two readers happen to build the same facts in a different order - and a
 * capability that re-establishes itself on every launch is a cache that does
 * nothing. Listing the fields here also means adding one to `HostReport`
 * without adding it here is a type error rather than a silent hole.
 *
 * @param report The facts to digest.
 * @returns A hex SHA-256 digest.
 */
export const fingerprintHost = (report: HostReport): HostFingerprint => {
  const ordered: readonly string[] = [
    report.runtime,
    report.serverVersion,
    report.kernelVersion,
    report.cgroupVersion,
    String(report.rootless),
    String(report.seccompEnabled),
    String(report.cpuQuotaSupported),
    String(report.memoryLimitSupported),
    String(report.processLimitSupported),
  ];
  return createHash("sha256").update(ordered.join("\n")).digest("hex");
};

/**
 * Where a host sits on `CONTEXT.md`'s Isolation ladder.
 *
 * Computed rather than configured, exactly as the glossary requires: a rootless
 * daemon is `container-rootless` and a rootful one is `container`. There is no
 * path to `microvm` from here, and nothing below `container` is a Sandbox.
 */
export const hostIsolation = (report: HostReport): Isolation =>
  report.rootless ? "container-rootless" : "container";

/**
 * What a host has to be able to enforce before any Sandbox is allowed on it.
 *
 * Seccomp and the three limits are hard requirements, so a host that cannot
 * apply one of them is refused rather than run without it. The namespace
 * requirements are absent on purpose: a host report says nothing about the
 * instance that has not been created yet, and those are attested per instance.
 *
 * @param report The facts the host reported.
 * @returns One outcome per requirement a host report can decide.
 */
export const checkHost = (
  report: HostReport
): readonly RequirementOutcome[] => [
  outcome(
    "seccomp-enabled",
    report.seccompEnabled,
    report.seccompEnabled
      ? "the daemon applies a seccomp profile"
      : "the daemon applies no seccomp profile, so every instance on it would run unconfined"
  ),
  outcome(
    "cpu-limit",
    report.cpuQuotaSupported,
    `the daemon ${report.cpuQuotaSupported ? "enforces" : "cannot enforce"} a CPU quota on cgroup v${report.cgroupVersion}`
  ),
  outcome(
    "memory-limit",
    report.memoryLimitSupported,
    `the daemon ${report.memoryLimitSupported ? "enforces" : "cannot enforce"} a memory limit on cgroup v${report.cgroupVersion}`
  ),
  outcome(
    "process-limit",
    report.processLimitSupported,
    `the daemon ${report.processLimitSupported ? "enforces" : "cannot enforce"} a process limit on cgroup v${report.cgroupVersion}`
  ),
];

/** A host's capability as it was established, and the digest it is keyed to. */
export interface HostCapability {
  readonly runtime: RuntimeName;
  readonly fingerprint: HostFingerprint;
  readonly isolation: Isolation;
  readonly outcomes: readonly RequirementOutcome[];
  /** When it was established, from the provider's injected clock. */
  readonly establishedAt: number;
}

/**
 * Where an established capability lives between launches, and where a
 * quarantine sticks.
 *
 * Injectable so that a durable cache is a later addition rather than an API
 * break. The one this package ships is in memory and owned by the provider,
 * because a file-backed capability is a writable file that decides whether a
 * Sandbox is allowed to run - which is a capability-forgery surface this issue
 * never asked for.
 */
export interface CapabilityCache {
  readonly read: (runtime: RuntimeName) => HostCapability | undefined;
  readonly write: (capability: HostCapability) => void;
  /** Drift: forget it, so the next launch establishes it honestly. */
  readonly evict: (runtime: RuntimeName) => void;
  /** Residue: refuse everything on this runtime until an operator clears it. */
  readonly quarantine: (runtime: RuntimeName, reason: string) => void;
  readonly quarantinedFor: (runtime: RuntimeName) => string | undefined;
}

/**
 * An in-memory cache, one per provider unless a caller shares one.
 *
 * The quarantine outlives an eviction deliberately. They are not two spellings
 * of the same state: drift means the host changed and should be re-measured,
 * and residue means the host could not prove it destroyed the last Sandbox.
 * Re-measuring launders the second one away, so it does not.
 */
export const createCapabilityCache = (): CapabilityCache => {
  const established = new Map<RuntimeName, HostCapability>();
  const quarantined = new Map<RuntimeName, string>();

  return {
    read: (runtime) => established.get(runtime),
    write: (capability) => {
      established.set(capability.runtime, capability);
    },
    evict: (runtime) => {
      established.delete(runtime);
    },
    quarantine: (runtime, reason) => {
      // First reason wins. The second teardown to leave residue on an already
      // quarantined host is not the one an operator needs to read about.
      if (!quarantined.has(runtime)) {
        quarantined.set(runtime, reason);
      }
    },
    quarantinedFor: (runtime) => quarantined.get(runtime),
  };
};

/**
 * The quarantine gate, as an outcome rather than as a branch.
 *
 * @param reason Why the runtime was quarantined, or `undefined` if it was not.
 * @returns The outcome a launch refuses on.
 */
export const checkQuarantine = (reason?: string): RequirementOutcome =>
  outcome(
    "local-capability-not-quarantined",
    reason === undefined,
    reason === undefined
      ? "this runtime is not quarantined"
      : `this runtime is quarantined: ${reason}`
  );
