/**
 * The whole of the per-runtime difference, measured against recorded output.
 *
 * Everything else this package does is shared between Docker and Podman, so
 * this is where the claim "one implementation, two dialects" is either true or
 * a bug. Each dialect reduces its own runtime's report to the same `HostReport`
 * and the same `InstanceReport`, and every case below is stated once and
 * asserted for both.
 */
import { describe, expect, it } from "vitest";

import { DOCKER_DIALECT, PODMAN_DIALECT } from "./dialect.js";
import type { RuntimeDialect } from "./dialect.js";
import {
  dockerInfoStdout,
  inspectStdout,
  podmanInfoStdout,
} from "./runtime.test-support.js";
import type { HostFacts } from "./runtime.test-support.js";

const DIALECTS = [
  {
    dialect: DOCKER_DIALECT,
    infoStdout: dockerInfoStdout,
    serverVersion: "29.1.3",
  },
  {
    dialect: PODMAN_DIALECT,
    infoStdout: podmanInfoStdout,
    serverVersion: "5.8.6",
  },
] as const;

describe.each(DIALECTS)(
  "the $dialect.name dialect",
  ({ dialect, infoStdout, serverVersion }) => {
    const read = (overrides: Partial<HostFacts> = {}) =>
      dialect.readHostReport(infoStdout(overrides));

    it("reads the whole host report from one info invocation", () => {
      expect(read()).toStrictEqual({
        runtime: dialect.name,
        serverVersion,
        kernelVersion: "6.12.93",
        // Normalized: Docker prints "2" and Podman prints "v2" for one fact.
        cgroupVersion: "2",
        rootless: false,
        seccompEnabled: true,
        cpuQuotaSupported: true,
        memoryLimitSupported: true,
        processLimitSupported: true,
      });
    });

    it.each([
      { drift: { rootless: true }, field: "rootless", reads: true },
      { drift: { seccomp: false }, field: "seccompEnabled", reads: false },
      { drift: { cpu: false }, field: "cpuQuotaSupported", reads: false },
      { drift: { memory: false }, field: "memoryLimitSupported", reads: false },
      { drift: { pids: false }, field: "processLimitSupported", reads: false },
    ] as const)(
      "reads $field as $reads when the runtime says so",
      ({ drift, field, reads }) => {
        expect(read(drift)[field]).toBe(reads);
      }
    );

    it.each(["", "not json at all", "{}", '{"host":{}}', "[]"])(
      "refuses the malformed host report %o rather than defaulting it",
      (stdout) => {
        expect(() => dialect.readHostReport(stdout)).toThrow(Error);
      }
    );

    it("asks for the host report without a shell metacharacter in sight", () => {
      // Rendered as separate argument-vector members, never as one string: a
      // Go template holds braces and dots, and a shell would be a second parser
      // between this package and the runtime.
      expect(dialect.hostReportArguments[0]).toBe("info");
      expect(dialect.hostReportArguments).toContain("--format");
    });

    it("names the instance to inspect as its own argument", () => {
      expect(dialect.instanceReportArguments("abc123")).toContain("abc123");
      expect(dialect.instanceReportArguments("abc123")[0]).toBe("inspect");
    });
  }
);

/**
 * The instance report is read the same way for both runtimes, because Podman's
 * inspect output carries a Docker-compatible `HostConfig` and the same
 * top-level `Id` and `Mounts`. It stays on the dialect so that a divergence has
 * a place to land without an API change.
 */
const read = (dialectUnderTest: RuntimeDialect, stdout: string) =>
  dialectUnderTest.readInstanceReport(stdout);

describe.each(DIALECTS)("$dialect.name instance reports", ({ dialect }) => {
  it("reduces a created instance to the facts an Attestation needs", () => {
    expect(read(dialect, inspectStdout())).toStrictEqual({
      instanceId:
        "6ad043fc544228215d48bca5cd453ad0a3170ec10ebe1224b831287c1d34714e",
      privileged: false,
      securityOptions: ["no-new-privileges"],
      addedCapabilities: [],
      droppedCapabilities: ["ALL"],
      binds: ["reprove-ws-probe:/reprove/workspace"],
      mounts: [
        {
          kind: "volume",
          source: "reprove-ws-probe",
          destination: "/reprove/workspace",
        },
        { kind: "tmpfs", source: "", destination: "/tmp" },
      ],
      networkMode: "none",
      pidMode: "",
      memoryBytes: 268_435_456,
      processLimit: 64,
      cpuQuotaNanos: 500_000_000,
      readOnlyRootFilesystem: true,
    });
  });

  it("names a volume by its volume name, not by the directory backing it", () => {
    // Docker reports a volume's `Source` as `/var/lib/docker/volumes/<name>/_data`,
    // which is a host path for every volume that has ever existed. Reading it as
    // the source would make every Workspace look like a host bind mount, and
    // reading `Binds` for bind mounts would make none of them look like one.
    const [workspace] = read(dialect, inspectStdout()).mounts;

    expect(workspace?.source).toBe("reprove-ws-probe");
    expect(workspace?.kind).toBe("volume");
  });

  it("reads a real host bind mount as a bind, beside the volume", () => {
    const report = read(
      dialect,
      inspectStdout({
        extraBinds: ["/var/run/docker.sock:/var/run/docker.sock"],
        extraMounts: [
          {
            Type: "bind",
            Source: "/var/run/docker.sock",
            Destination: "/var/run/docker.sock",
          },
        ],
      })
    );

    expect(report.binds).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(report.mounts).toContainEqual({
      kind: "bind",
      source: "/var/run/docker.sock",
      destination: "/var/run/docker.sock",
    });
  });

  it("reads a mount kind it has never heard of as a bind, not as sandbox-owned", () => {
    // Fail closed. An unrecognised mount kind is something from outside the
    // Sandbox until proven otherwise, and `own-mount-namespace` refuses it.
    const report = read(
      dialect,
      inspectStdout({
        extraMounts: [
          { Type: "cluster", Source: "//nfs/share", Destination: "/share" },
        ],
      })
    );

    expect(report.mounts).toContainEqual({
      kind: "bind",
      source: "//nfs/share",
      destination: "/share",
    });
  });

  it("reads an absent capability list as an empty one", () => {
    // Docker prints `"CapAdd": null` rather than `[]` when nothing was added.
    expect(read(dialect, inspectStdout()).addedCapabilities).toStrictEqual([]);
  });

  it.each(["", "not json at all", "{}", '{"Id":"abc"}'])(
    "refuses the malformed instance report %o rather than defaulting it",
    (stdout) => {
      expect(() => read(dialect, stdout)).toThrow(Error);
    }
  );
});
