/**
 * The proof taken per instance, one violated fact at a time.
 *
 * The request check reads what was asked for and the host check reads what the
 * daemon can do. Neither sees what the runtime actually created, and that is
 * the only thing a Run executes inside. So every hard requirement that has an
 * observable form is re-decided here against the instance's own report, and a
 * host that drifted since its capability was established is caught here rather
 * than assumed away.
 */
import { describe, expect, it } from "vitest";

import { attestInstance } from "./attestation.js";
import type { AttestationInput, InstanceReport } from "./attestation.js";
import { fingerprintHost, hostIsolation } from "./capability.js";
import type { HostCapability, HostReport } from "./capability.js";
import type { SandboxRequest } from "./request.js";
import type { RequirementName } from "./requirements.js";

const REPORT: HostReport = {
  runtime: "docker",
  serverVersion: "29.1.3",
  kernelVersion: "6.12.93",
  cgroupVersion: "2",
  rootless: false,
  seccompEnabled: true,
  cpuQuotaSupported: true,
  memoryLimitSupported: true,
  processLimitSupported: true,
};

const HOST: HostCapability = {
  runtime: "docker",
  fingerprint: fingerprintHost(REPORT),
  isolation: hostIsolation(REPORT),
  outcomes: [
    { name: "seccomp-enabled", satisfied: true, detail: "a profile applies" },
  ],
  establishedAt: 1,
};

const REQUEST: SandboxRequest = {
  image: "alpine:3.20",
  command: ["/bin/sh", "-c", "true"],
  workspace: { path: "/reprove/workspace", sizeBytes: 1_073_741_824 },
  limits: { cpus: 1.5, memoryBytes: 2_147_483_648, processes: 512 },
  seccomp: { kind: "runtime-default" },
  egress: { kind: "none" },
  environment: [],
  mounts: [{ kind: "ephemeral", path: "/tmp", sizeBytes: 67_108_864 }],
};

/** What Docker reports for an instance created from `REQUEST`. */
const INSTANCE: InstanceReport = {
  instanceId: "6ad043fc5442",
  privileged: false,
  securityOptions: ["no-new-privileges"],
  addedCapabilities: [],
  droppedCapabilities: ["ALL"],
  binds: ["reprove-ws-abc:/reprove/workspace"],
  mounts: [
    {
      kind: "volume",
      source: "reprove-ws-abc",
      destination: "/reprove/workspace",
    },
    { kind: "tmpfs", source: "", destination: "/tmp" },
  ],
  networkMode: "none",
  pidMode: "",
  memoryBytes: 2_147_483_648,
  processLimit: 512,
  cpuQuotaNanos: 1_500_000_000,
  readOnlyRootFilesystem: true,
};

const SOUND: AttestationInput = {
  request: REQUEST,
  instance: INSTANCE,
  host: HOST,
  fingerprint: HOST.fingerprint,
  network: "none",
  workspaceVolume: "reprove-ws-abc",
};

const attestWith = (
  instance: Partial<InstanceReport>,
  input: Partial<AttestationInput> = {}
): readonly RequirementName[] =>
  attestInstance({
    ...SOUND,
    ...input,
    instance: { ...INSTANCE, ...instance },
  })
    .outcomes.filter((each) => !each.satisfied)
    .map((each) => each.name);

describe("attesting an instance", () => {
  it("authorizes an instance that holds every hard requirement", () => {
    const attestation = attestInstance(SOUND);

    expect(attestation.authorized).toBeTruthy();
    expect(
      attestation.outcomes.filter((each) => !each.satisfied)
    ).toStrictEqual([]);
  });

  it("decides every requirement an instance report can decide", () => {
    expect(
      attestInstance(SOUND).outcomes.map((each) => each.name)
    ).toStrictEqual([
      "host-fingerprint-unchanged",
      "own-network-namespace",
      "own-pid-namespace",
      "own-mount-namespace",
      "not-privileged",
      "no-added-capabilities",
      "no-runtime-socket",
      "no-host-bind-mount",
      "seccomp-enabled",
      "cpu-limit",
      "memory-limit",
      "process-limit",
      "ephemeral-workspace",
    ]);
  });

  it("carries the host's Isolation rather than computing a second one", () => {
    expect(attestInstance(SOUND).isolation).toBe("container");
  });

  it.each([
    {
      why: "it came up privileged",
      drift: { privileged: true },
      requirements: ["not-privileged"],
    },
    {
      why: "seccomp was turned off on it",
      drift: { securityOptions: ["no-new-privileges", "seccomp=unconfined"] },
      requirements: ["seccomp-enabled"],
    },
    {
      why: "a capability was added",
      drift: { addedCapabilities: ["CAP_SYS_ADMIN"] },
      requirements: ["no-added-capabilities"],
    },
    {
      why: "nothing was dropped",
      drift: { droppedCapabilities: [] },
      requirements: ["no-added-capabilities"],
    },
    {
      why: "it shares the host's network",
      drift: { networkMode: "host" },
      requirements: ["own-network-namespace"],
    },
    {
      why: "it joined another instance's network",
      drift: { networkMode: "container:9f2c" },
      requirements: ["own-network-namespace"],
    },
    {
      why: "it shares the host's PID namespace",
      drift: { pidMode: "host" },
      requirements: ["own-pid-namespace"],
    },
    {
      why: "a host path was bind-mounted into it",
      drift: {
        binds: ["/home/runner/work:/work", "reprove-ws-abc:/reprove/workspace"],
        mounts: [
          {
            kind: "bind" as const,
            source: "/home/runner/work",
            destination: "/work",
          },
          {
            kind: "volume" as const,
            source: "reprove-ws-abc",
            destination: "/reprove/workspace",
          },
        ],
      },
      requirements: ["own-mount-namespace", "no-host-bind-mount"],
    },
    {
      why: "the container-runtime socket reached inside it",
      drift: {
        binds: [
          "/var/run/docker.sock:/var/run/docker.sock",
          "reprove-ws-abc:/reprove/workspace",
        ],
        mounts: [
          {
            kind: "bind" as const,
            source: "/var/run/docker.sock",
            destination: "/var/run/docker.sock",
          },
          {
            kind: "volume" as const,
            source: "reprove-ws-abc",
            destination: "/reprove/workspace",
          },
        ],
      },
      requirements: [
        "own-mount-namespace",
        "no-runtime-socket",
        "no-host-bind-mount",
      ],
    },
    {
      why: "its root filesystem is writable",
      drift: { readOnlyRootFilesystem: false },
      requirements: ["own-mount-namespace"],
    },
    {
      why: "the image brought a writable volume nobody asked for",
      // An image with a `VOLUME` directive gets an anonymous volume, which is
      // writable and executable storage inside an instance whose read-only root
      // was meant to prevent exactly that. A check for `kind === "bind"` walks
      // past it, which is why the resolved set is an allowlist.
      drift: {
        mounts: [
          {
            kind: "volume" as const,
            source: "reprove-ws-abc",
            destination: "/reprove/workspace",
          },
          { kind: "tmpfs" as const, source: "", destination: "/tmp" },
          {
            kind: "volume" as const,
            source: "ae36a397anonymous",
            destination: "/var/lib/postgresql/data",
          },
        ],
      },
      requirements: ["own-mount-namespace"],
    },
    {
      why: "a host path arrived as a volume rather than as a bind",
      // The local volume driver will back a volume with a host path, and it
      // inspects as `Type: "volume"` with nothing in `Binds`. Neither the bind
      // check nor `Binds` sees it.
      drift: {
        mounts: [
          {
            kind: "volume" as const,
            source: "reprove-ws-abc",
            destination: "/reprove/workspace",
          },
          { kind: "tmpfs" as const, source: "", destination: "/tmp" },
          {
            kind: "volume" as const,
            source: "smuggled",
            destination: "/host",
          },
        ],
      },
      requirements: ["own-mount-namespace"],
    },
    {
      why: "it can regain a privilege it dropped",
      drift: { securityOptions: [] },
      requirements: ["not-privileged"],
    },
    {
      why: "it has no memory limit",
      drift: { memoryBytes: 0 },
      requirements: ["memory-limit"],
    },
    {
      why: "its memory limit is not the one that was asked for",
      drift: { memoryBytes: 4_294_967_296 },
      requirements: ["memory-limit"],
    },
    {
      why: "it has no process limit",
      drift: { processLimit: 0 },
      requirements: ["process-limit"],
    },
    {
      why: "it has no CPU quota",
      drift: { cpuQuotaNanos: 0 },
      requirements: ["cpu-limit"],
    },
    {
      why: "its Workspace is not the volume the provider created",
      drift: {
        mounts: [
          {
            kind: "volume" as const,
            source: "somebody-elses-volume",
            destination: "/reprove/workspace",
          },
        ],
      },
      requirements: ["own-mount-namespace", "ephemeral-workspace"],
    },
    {
      why: "it has no Workspace at all",
      drift: { mounts: [] },
      requirements: ["own-mount-namespace", "ephemeral-workspace"],
    },
  ])("refuses an instance because $why", ({ drift, requirements }) => {
    expect(attestWith(drift)).toStrictEqual(requirements);
  });

  it("refuses an instance missing an ephemeral mount that was asked for", () => {
    // The allowlist read from its other end. An instance that never got the
    // tmpfs the request named is not the instance that was requested, and a
    // check that only looks for storage nobody asked for cannot see it - so a
    // Harness writes into the read-only root instead of the scratch it expects.
    const refused = attestInstance({
      ...SOUND,
      instance: {
        ...INSTANCE,
        mounts: INSTANCE.mounts.filter((mount) => mount.kind !== "tmpfs"),
      },
    });
    const mount = refused.outcomes.find(
      (each) => each.name === "own-mount-namespace"
    );

    expect(refused.authorized).toBeFalsy();
    expect(mount?.satisfied).toBeFalsy();
    expect(mount?.detail).toContain("tmpfs at /tmp");
  });

  it("refuses a colon-free socket bind by both the names it violates", () => {
    // `/var/run/docker.sock` with no `:` is one whole source. Slicing to the
    // first colon would hand the socket check `/var/run/docker.soc`, which
    // reads as satisfied while only the bind check refuses - and an operator is
    // then told the wrong requirement failed.
    expect(attestWith({ binds: ["/var/run/docker.sock"] })).toStrictEqual([
      "no-runtime-socket",
      "no-host-bind-mount",
    ]);
  });

  it("refuses an instance on a host that drifted since it was measured", () => {
    // The case the whole cached-fingerprint design exists for: the capability
    // was established honestly, and the host is no longer the host it described.
    const refused = attestWith({}, { fingerprint: "0".repeat(64) });

    expect(refused).toStrictEqual(["host-fingerprint-unchanged"]);
  });

  it("refuses an instance whose host capability itself refused seccomp", () => {
    // A daemon started with no seccomp profile applies none, and the instance
    // reports nothing at all about it - no `seccomp=unconfined` entry appears,
    // because nothing was overridden. Only the host report knows.
    const refused = attestInstance({
      ...SOUND,
      host: {
        ...HOST,
        outcomes: [
          {
            name: "seccomp-enabled",
            satisfied: false,
            detail: "the daemon applies no seccomp profile",
          },
        ],
      },
    }).outcomes.filter((each) => !each.satisfied);

    expect(refused.map((each) => each.name)).toStrictEqual(["seccomp-enabled"]);
  });

  it("requires a profile of its own when one was asked for by name", () => {
    const asked: AttestationInput = {
      ...SOUND,
      request: {
        ...REQUEST,
        seccomp: { kind: "file", path: "/etc/reprove/seccomp.json" },
      },
    };

    expect(attestInstance(asked).authorized).toBeFalsy();
  });

  it.each([
    // What Podman reports: the path, as it was written.
    "seccomp=/etc/reprove/seccomp.json",
    // What Docker 29.1.3 reports: its client reads the file and inlines the
    // compacted profile, so the path never reaches the daemon. Comparing
    // against the path would refuse every named-profile launch on Docker.
    'seccomp={"defaultAction":"SCMP_ACT_ERRNO","architectures":["SCMP_ARCH_X86_64"]}',
  ])("accepts %o as the named profile being applied", (applied) => {
    expect(
      attestInstance({
        ...SOUND,
        request: {
          ...REQUEST,
          seccomp: { kind: "file", path: "/etc/reprove/seccomp.json" },
        },
        instance: {
          ...INSTANCE,
          securityOptions: ["no-new-privileges", applied],
        },
      }).authorized
    ).toBeTruthy();
  });

  it("refuses when the host capability never measured seccomp at all", () => {
    // An outcome list that does not mention it is not one that passed it, and
    // the capability is caller-supplied on this public function.
    const unmeasured = attestInstance({
      ...SOUND,
      host: { ...HOST, outcomes: [] },
    });

    expect(unmeasured.outcomes.filter((each) => !each.satisfied)).toHaveLength(
      1
    );
    expect(unmeasured.authorized).toBeFalsy();
  });

  it("requires the network the provider created, not merely a private one", () => {
    // `--network` renders a name the provider generated, so an instance sitting
    // on some other network is one this provider did not shape.
    expect(
      attestWith({ networkMode: "bridge" }, { network: "reprove-net-abc" })
    ).toStrictEqual(["own-network-namespace"]);
  });

  it("accepts an instance on exactly the network it was stated to own", () => {
    // `attestInstance` is public and re-attestable, so the expected network is
    // stated rather than assumed to be `none`: the provider renders `none`
    // today, and the Attestation is what a Sandbox-owned network would be
    // measured against on the day one exists.
    expect(
      attestWith(
        { networkMode: "reprove-net-abc" },
        { network: "reprove-net-abc" }
      )
    ).toStrictEqual([]);
  });

  it.each(["", "private"])(
    "accepts pidMode %o, which both runtimes spell a private namespace as",
    (pidMode) => {
      expect(attestWith({ pidMode })).toStrictEqual([]);
    }
  );
});
