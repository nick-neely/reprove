/**
 * The argument vector, audited from the opposite end of the requirement that
 * rendered it.
 *
 * The audit exists because the renderer might be wrong, so a suite that only
 * fed it the renderer's own output would prove nothing the renderer does not
 * already claim. Every case below hands it a vector no renderer in this package
 * produces - which is exactly the vector a renderer bug, a merge, or a future
 * option would produce - and asserts it is refused by name.
 *
 * These cases are the reason the audit can be trusted to be reached at all: a
 * layer whose negative cases are untested is a layer that can be deleted
 * without anything going red.
 */
import { describe, expect, it } from "vitest";

import { auditArguments, renderCreate, SANDBOX_LABEL } from "./arguments.js";
import type { LaunchNames } from "./arguments.js";
import type { SandboxRequest } from "./request.js";
import type { RequirementName } from "./requirements.js";

/** A request every hard requirement holds for, and the names it launches as. */
const SOUND: SandboxRequest = {
  image: "alpine:3.20",
  command: ["/bin/sh", "-c", "true"],
  workspace: { path: "/reprove/workspace", sizeBytes: 1_073_741_824 },
  limits: { cpus: 0.5, memoryBytes: 268_435_456, processes: 64 },
  seccomp: { kind: "runtime-default" },
  egress: { kind: "none" },
  environment: [{ name: "CLAUDE_CODE_SAFE_MODE", value: "1" }],
  mounts: [{ kind: "ephemeral", path: "/tmp", sizeBytes: 67_108_864 }],
};

const NAMES: LaunchNames = {
  instance: "reprove-sbx-probe",
  workspaceVolume: "reprove-ws-probe",
};

const RENDERED = renderCreate(SOUND, NAMES);

/** What the audit refused, in the order it decides requirements. */
const refused = (options: readonly string[]): readonly RequirementName[] =>
  auditArguments({ ...RENDERED, options })
    .filter((outcome) => !outcome.satisfied)
    .map((outcome) => outcome.name);

const detailOf = (options: readonly string[], name: RequirementName): string =>
  auditArguments({ ...RENDERED, options }).find(
    (outcome) => outcome.name === name
  )?.detail ?? "";

/** The rendered vector with more arguments after it. */
const also = (...extra: readonly string[]): readonly string[] => [
  ...RENDERED.options,
  ...extra,
];

/**
 * The rendered vector with one flag's value replaced.
 *
 * Only for a flag that takes one: the token after it is the one replaced.
 */
const replacing = (flag: string, value: string): readonly string[] =>
  RENDERED.options.map((token, index) =>
    RENDERED.options[index - 1] === flag ? value : token
  );

/** The rendered vector with one flag and the value after it removed. */
const without = (flag: string): readonly string[] =>
  RENDERED.options.filter(
    (token, index) => token !== flag && RENDERED.options[index - 1] !== flag
  );

describe("the argument audit", () => {
  it("accepts the vector the renderer produced", () => {
    expect(refused(RENDERED.options)).toStrictEqual([]);
  });

  it("names every requirement it decides, satisfied or not", () => {
    // A requirement that quietly stopped producing an outcome reads as a pass
    // to every caller that filters for failures, so the whole set is asserted
    // rather than the failures alone.
    expect(
      auditArguments(RENDERED).map((outcome) => outcome.name)
    ).toStrictEqual([
      "not-privileged",
      "no-added-capabilities",
      "seccomp-enabled",
      "own-network-namespace",
      "own-pid-namespace",
      "no-host-bind-mount",
      "no-runtime-socket",
      "cpu-limit",
      "memory-limit",
      "process-limit",
    ]);
  });

  it("puts every Sandbox on no network, whatever the request said", () => {
    // `EgressPolicy` has one member. The renderer does not consult the request
    // for a network at all, so there is no request that produces a different
    // one - which is the whole of the egress posture until a proxy exists.
    const flag = RENDERED.options.indexOf("--network");

    expect(RENDERED.options.slice(flag, flag + 2)).toStrictEqual([
      "--network",
      "none",
    ]);
  });

  it("labels the instance so an abandoned one can be swept up", () => {
    expect(RENDERED.options).toContain(SANDBOX_LABEL);
  });

  describe("privilege", () => {
    it.each(["--privileged", "--privileged=true"])(
      "refuses a vector carrying %s",
      (token) => {
        expect(refused(also(token))).toStrictEqual(["not-privileged"]);
      }
    );

    it.each([
      { why: "a capability is added back", extra: ["--cap-add", "SYS_ADMIN"] },
      { why: "it is added the other spelling", extra: ["--cap-add=SYS_ADMIN"] },
    ])("refuses because $why", ({ extra }) => {
      expect(refused(also(...extra))).toStrictEqual(["no-added-capabilities"]);
    });

    it.each([
      {
        why: "only some capabilities are dropped",
        options: replacing("--cap-drop", "NET_RAW"),
      },
      { why: "nothing is dropped at all", options: without("--cap-drop") },
    ])("refuses because $why", ({ options }) => {
      expect(refused(options)).toStrictEqual(["no-added-capabilities"]);
    });
  });

  describe("seccomp", () => {
    it.each([
      ["--security-opt", "seccomp=unconfined"],
      ["--security-opt=seccomp=unconfined"],
    ])("refuses a vector that opts out of seccomp with %s", (...extra) => {
      expect(refused(also(...extra))).toStrictEqual(["seccomp-enabled"]);
    });

    it("accepts a profile named by path", () => {
      // What the profile *says* is the caller's responsibility. That it exists
      // at all is this layer's.
      const options = also("--security-opt", "seccomp=/etc/reprove.json");

      expect(refused(options)).toStrictEqual([]);
    });
  });

  describe("namespaces of somebody else's", () => {
    it.each(["host", "container:other", "ns:/proc/1/ns/net"])(
      "refuses a network of %s",
      (value) => {
        expect(refused(replacing("--network", value))).toStrictEqual([
          "own-network-namespace",
        ]);
      }
    );

    it.each([
      { why: "no network is named at all", options: without("--network") },
      { why: "the network is empty", options: also("--net=") },
      { why: "two networks are named", options: also("--net", "bridge") },
    ])("refuses because $why", ({ options }) => {
      expect(refused(options)).toStrictEqual(["own-network-namespace"]);
    });

    it.each(["--pid", "--ipc", "--userns", "--uts", "--cgroupns"])(
      "refuses %s pointed at the host",
      (flag) => {
        expect(refused(also(flag, "host"))).toStrictEqual([
          "own-pid-namespace",
        ]);
      }
    );

    it.each(["--pid", "--ipc", "--userns", "--uts", "--cgroupns"])(
      "refuses %s pointed at another instance",
      (flag) => {
        // `host` is not the only namespace that is not this Sandbox's. Joining
        // a neighbour's is the same hole reached through a different value,
        // and it is the spelling a shared-namespace escape actually uses.
        expect(refused(also(flag, "container:other"))).toStrictEqual([
          "own-pid-namespace",
        ]);
      }
    );

    it("says which flag shared what", () => {
      expect(
        detailOf(also("--ipc", "container:other"), "own-pid-namespace")
      ).toContain("--ipc");
    });
  });

  describe("host storage", () => {
    it.each([
      "/etc:/etc",
      "/:/host",
      "./secrets:/secrets",
      "../secrets:/secrets",
      ".:/here",
      "~/.ssh:/keys",
    ])("refuses a bind mount of %s", (mount) => {
      // A relative source is a host path the moment the runtime resolves it
      // against its own working directory, so "starts with a slash" is a
      // spelling test rather than a boundary.
      expect(refused(also("--volume", mount))).toStrictEqual([
        "no-host-bind-mount",
      ]);
    });

    it.each([
      { why: "the short spelling is used", extra: ["-v", "/etc:/etc"] },
      {
        why: "it is asked for as a mount",
        extra: ["--mount", "type=bind,source=/etc,target=/etc"],
      },
      { why: "a host device is asked for", extra: ["--device", "/dev/sda"] },
      {
        why: "another instance's volumes are inherited",
        extra: ["--volumes-from", "other"],
      },
    ])("refuses because $why", ({ extra }) => {
      expect(refused(also(...extra))).toStrictEqual(["no-host-bind-mount"]);
    });

    it("accepts a second sandbox-owned volume", () => {
      expect(
        refused(also("--volume", "reprove-scratch-probe:/scratch"))
      ).toStrictEqual([]);
    });
  });

  describe("the container-runtime socket", () => {
    it.each([
      "/var/run/docker.sock:/var/run/docker.sock",
      "/run/podman/podman.sock:/run/podman/podman.sock",
    ])("refuses %s, as a socket and as a host path", (mount) => {
      expect(refused(also("--volume", mount))).toStrictEqual([
        "no-host-bind-mount",
        "no-runtime-socket",
      ]);
    });

    it.each([
      "/var/run/docker.sock:/tmp/d",
      "/run/user/1000/podman/podman.sock:/tmp/p",
    ])("refuses %s, where only the source names one", (mount) => {
      // Reading the destination alone reads whatever name the mount was given
      // inside, which is chosen by whoever wanted the socket.
      expect(refused(also("--volume", mount))).toStrictEqual([
        "no-host-bind-mount",
        "no-runtime-socket",
      ]);
    });
  });

  describe("the three limits", () => {
    it.each([
      { flag: "--cpus", requirement: "cpu-limit" },
      { flag: "--memory", requirement: "memory-limit" },
      { flag: "--pids-limit", requirement: "process-limit" },
    ])("refuses a vector with no $requirement", ({ flag, requirement }) => {
      expect(refused(without(flag))).toStrictEqual([requirement]);
    });

    it.each([
      { flag: "--cpus", requirement: "cpu-limit" },
      { flag: "--memory", requirement: "memory-limit" },
      { flag: "--pids-limit", requirement: "process-limit" },
    ])("refuses a $requirement of zero", ({ flag, requirement }) => {
      // Zero is "no limit" to both runtimes, which is the value a limit that
      // was meant to be tightened is most likely to be set to by mistake.
      expect(refused(replacing(flag, "0"))).toStrictEqual([requirement]);
    });

    it.each([
      { flag: "--cpus", requirement: "cpu-limit" },
      { flag: "--memory", requirement: "memory-limit" },
      { flag: "--pids-limit", requirement: "process-limit" },
    ])("refuses a negative $requirement", ({ flag, requirement }) => {
      expect(refused(replacing(flag, "-1"))).toStrictEqual([requirement]);
    });

    it.each([
      { flag: "--cpus", requirement: "cpu-limit" },
      { flag: "--memory", requirement: "memory-limit" },
      { flag: "--pids-limit", requirement: "process-limit" },
    ])("refuses a $requirement stated twice", ({ flag, requirement }) => {
      // Both runtimes take the last one, so two is a vector whose limit is
      // whichever of them was appended most recently.
      expect(refused(also(flag, "999999"))).toStrictEqual([requirement]);
    });
  });

  describe("the flag region and everything past it", () => {
    it("reads a value attached with an equals sign as a value", () => {
      // The renderer only ever produces `--flag value`, so an audit that only
      // understood that spelling would be auditing the renderer.
      expect(refused(also("--cpus=0"))).toStrictEqual(["cpu-limit"]);
    });

    it("reads nothing from the image or the command", () => {
      // Both runtimes stop parsing flags at the first positional argument, so
      // a command whose own arguments include `--privileged` is text. Auditing
      // it would refuse a correct launch for a word in somebody's shell script.
      const audited = auditArguments({
        ...RENDERED,
        image: "--privileged",
        command: ["sh", "-c", "--cap-add SYS_ADMIN"],
      });

      expect(audited.filter((outcome) => !outcome.satisfied)).toStrictEqual([]);
    });
  });
});
