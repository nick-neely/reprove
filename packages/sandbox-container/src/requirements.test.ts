/**
 * Every request that must be refused before a container runtime is touched at
 * all.
 *
 * This is the cheapest of the three layers and the only one that costs nothing
 * to run, so it carries the checks that can be decided from the request alone.
 * What it must never do is *narrow* a bad request into a good one: ADR 0004's
 * "nothing warns and runs" means a request asking for a host bind mount is
 * refused by name rather than launched without it.
 */
import { describe, expect, it } from "vitest";

import { auditArguments, renderCreate } from "./arguments.js";
import type { LaunchNames } from "./arguments.js";
import { attestInstance } from "./attestation.js";
import type { InstanceReport } from "./attestation.js";
import { BROKERED_PLACEHOLDER } from "./broker.js";
import { checkHost, checkQuarantine, fingerprintHost } from "./capability.js";
import type {
  EnvironmentEntry,
  MountRequest,
  SandboxRequest,
} from "./request.js";
import { checkRequest, HARD_REQUIREMENTS } from "./requirements.js";
import type { RequirementName } from "./requirements.js";
import { checkResidue } from "./residue.js";

/**
 * A request that holds every hard requirement, which every case below breaks in
 * exactly one way. Stated whole rather than built by a helper: what a correct
 * request looks like is the thing under test.
 */
const SOUND: SandboxRequest = {
  image: "alpine:3.20",
  command: ["/bin/sh", "-c", "true"],
  workspace: { path: "/reprove/workspace", sizeBytes: 1_073_741_824 },
  limits: { cpus: 1, memoryBytes: 2_147_483_648, processes: 512 },
  seccomp: { kind: "runtime-default" },
  egress: { kind: "none" },
  environment: [{ name: "CLAUDE_CODE_SAFE_MODE", value: "1" }],
  mounts: [{ kind: "ephemeral", path: "/tmp", sizeBytes: 67_108_864 }],
};

const refused = (request: SandboxRequest): readonly RequirementName[] =>
  checkRequest(request)
    .filter((outcome) => !outcome.satisfied)
    .map((outcome) => outcome.name);

const detailOf = (request: SandboxRequest, name: RequirementName): string =>
  checkRequest(request).find((outcome) => outcome.name === name)?.detail ?? "";

const withMounts = (mounts: readonly MountRequest[]): SandboxRequest => ({
  ...SOUND,
  mounts,
});

const withEnvironment = (
  environment: readonly EnvironmentEntry[]
): SandboxRequest => ({ ...SOUND, environment });

describe("the request check", () => {
  it("accepts a request that holds every hard requirement", () => {
    expect(refused(SOUND)).toStrictEqual([]);
  });

  it("names every hard requirement it decides, satisfied or not", () => {
    // A check that silently stopped producing an outcome would read as a pass
    // everywhere the outcomes are filtered for failures, so the set is asserted
    // rather than the failures alone.
    expect(checkRequest(SOUND).map((outcome) => outcome.name)).toStrictEqual([
      "no-host-bind-mount",
      "no-runtime-socket",
      "seccomp-enabled",
      "cpu-limit",
      "memory-limit",
      "process-limit",
      "ephemeral-workspace",
      "no-credential-in-brokered-sandbox",
    ]);
  });

  describe("host storage", () => {
    it("refuses a host bind mount", () => {
      const request = withMounts([
        { kind: "host", hostPath: "/home/runner/work", path: "/work" },
      ]);

      expect(refused(request)).toStrictEqual(["no-host-bind-mount"]);
      expect(detailOf(request, "no-host-bind-mount")).toContain(
        "/home/runner/work"
      );
    });

    it.each([
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/run/podman/podman.sock",
      "/run/user/1000/podman/podman.sock",
      "/run/containerd/containerd.sock",
      // Path-cleaned back to the socket by every runtime, so a check that read
      // the last segment of the raw string would read an empty one.
      "/var/run/docker.sock/",
    ])("refuses %s as a runtime socket as well as a host mount", (hostPath) => {
      // Two names rather than one. A host mount and a reachable runtime socket
      // are different failures with different fixes, and collapsing them would
      // leave the escalation path reading as a storage mistake.
      const request = withMounts([
        { kind: "host", hostPath, path: "/var/run/docker.sock" },
      ]);

      expect(refused(request)).toStrictEqual([
        "no-host-bind-mount",
        "no-runtime-socket",
      ]);
    });
  });

  describe("resource limits", () => {
    it.each([
      { field: "cpus", requirement: "cpu-limit" },
      { field: "memoryBytes", requirement: "memory-limit" },
      { field: "processes", requirement: "process-limit" },
    ] as const)(
      "refuses $field at zero, negative and non-finite",
      ({ field, requirement }) => {
        const at = (value: number): readonly RequirementName[] =>
          refused({ ...SOUND, limits: { ...SOUND.limits, [field]: value } });

        expect(at(0)).toStrictEqual([requirement]);
        expect(at(-1)).toStrictEqual([requirement]);
        expect(at(Number.POSITIVE_INFINITY)).toStrictEqual([requirement]);
        expect(at(Number.NaN)).toStrictEqual([requirement]);
      }
    );
  });

  describe("the Workspace", () => {
    it.each([
      { path: "workspace", sizeBytes: 1024 },
      { path: "", sizeBytes: 1024 },
      { path: "/reprove/workspace", sizeBytes: 0 },
      { path: "/reprove/workspace", sizeBytes: -1 },
    ])("refuses %o", (workspace) => {
      expect(refused({ ...SOUND, workspace })).toStrictEqual([
        "ephemeral-workspace",
      ]);
    });
  });

  describe("ephemeral mounts", () => {
    it.each(["tmp", "", "./scratch"])(
      "refuses the relative mount path %o",
      (path) => {
        expect(
          refused(withMounts([{ kind: "ephemeral", path }]))
        ).toStrictEqual(["ephemeral-workspace"]);
      }
    );
  });

  describe("seccomp", () => {
    it("accepts the runtime's own profile, which is not `unconfined`", () => {
      expect(
        refused({ ...SOUND, seccomp: { kind: "runtime-default" } })
      ).toStrictEqual([]);
    });

    it("accepts a named profile file", () => {
      expect(
        refused({
          ...SOUND,
          seccomp: { kind: "file", path: "/etc/reprove.json" },
        })
      ).toStrictEqual([]);
    });

    it("refuses a profile file with no path, which would render nothing", () => {
      const request: SandboxRequest = {
        ...SOUND,
        seccomp: { kind: "file", path: "" },
      };

      expect(refused(request)).toStrictEqual(["seccomp-enabled"]);
    });
  });

  describe("the brokered environment", () => {
    it.each([
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "OPENAI_APIKEY",
      "npm_password",
      "SESSION",
      "MY_AUTH_HEADER",
    ])("refuses %s holding anything but the placeholder", (name) => {
      const request = withEnvironment([{ name, value: "sk-live-real" }]);

      expect(refused(request)).toStrictEqual([
        "no-credential-in-brokered-sandbox",
      ]);
      expect(detailOf(request, "no-credential-in-brokered-sandbox")).toContain(
        name
      );
    });

    it("accepts a credential-shaped name holding the placeholder", () => {
      // What brokering means: the name is there so the Harness finds something,
      // and the value is substituted outside the boundary on the way out.
      expect(
        refused(
          withEnvironment([
            { name: "ANTHROPIC_API_KEY", value: BROKERED_PLACEHOLDER },
          ])
        )
      ).toStrictEqual([]);
    });

    it.each([
      "GITHUB_AUTHOR",
      "KEYBOARD",
      "MONKEYS",
      "CLAUDE_CODE_SAFE_MODE",
      "PASSWORDLESS_MODE",
    ])("accepts %s, whose name only looks credential-shaped", (name) => {
      // The guard tokenizes on `_` and compares whole tokens. A substring match
      // would refuse `GITHUB_AUTHOR` for containing `AUTH`, and a guard that
      // refuses correct requests is one an operator learns to route around.
      expect(refused(withEnvironment([{ name, value: "1" }]))).toStrictEqual(
        []
      );
    });

    it.each([
      "ANTHROPIC_API_KEY=sk-live",
      "DOCKER_HOST=tcp://10.0.0.1:2375",
      "LD_PRELOAD=/tmp/evil.so",
      "",
      "not a name",
      "9LIVES",
      "PATH;rm",
    ])("refuses %o, which is not an environment variable name", (name) => {
      // The bypass both guards had. An entry renders as `name=value`, so a
      // *name* holding an `=` sets a variable neither guard ever read: the
      // credential guard splits `ANTHROPIC_API_KEY=sk-live` on `_` and its last
      // token is `KEY=SK-LIVE`, which is not `KEY`, and the denied list matches
      // whole strings. The shape is required rather than sanitised.
      expect(refused(withEnvironment([{ name, value: "" }]))).toContain(
        "no-credential-in-brokered-sandbox"
      );
    });

    it.each([
      "DOCKER_HOST",
      "CONTAINER_HOST",
      "DOCKER_CONFIG",
      "XDG_RUNTIME_DIR",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "SSH_AUTH_SOCK",
    ])("refuses %s at any value at all, including the placeholder", (name) => {
      const asPlaceholder = withEnvironment([
        { name, value: BROKERED_PLACEHOLDER },
      ]);

      expect(refused(withEnvironment([{ name, value: "" }]))).toContain(
        "no-runtime-socket"
      );
      expect(refused(asPlaceholder)).toContain("no-runtime-socket");
      expect(detailOf(asPlaceholder, "no-runtime-socket")).toContain(name);
    });
  });
});

/**
 * The completeness rule.
 *
 * `HARD_REQUIREMENTS` is what a Worker's structured isolation report enumerates,
 * so a name on the list that no layer ever produces is a requirement nothing
 * checks - and it reads exactly like one that always passes. The four layers
 * are asked what they produce and the answer has to be the whole list, in the
 * same spirit as the control plane's "every managed table is classified".
 */
/** The instance's own facts do not matter here; only which names it produces. */
const BARE_INSTANCE: InstanceReport = {
  instanceId: "x",
  privileged: false,
  securityOptions: [],
  addedCapabilities: [],
  droppedCapabilities: ["ALL"],
  binds: [],
  mounts: [],
  networkMode: "none",
  pidMode: "",
  memoryBytes: 1,
  processLimit: 1,
  cpuQuotaNanos: 1,
  readOnlyRootFilesystem: true,
};

describe("the hard requirements", () => {
  const produced = (): ReadonlySet<RequirementName> => {
    const report = {
      runtime: "docker",
      serverVersion: "29.1.3",
      kernelVersion: "6.12.93",
      cgroupVersion: "2",
      rootless: false,
      seccompEnabled: true,
      cpuQuotaSupported: true,
      memoryLimitSupported: true,
      processLimitSupported: true,
    } as const;
    const names: LaunchNames = {
      instance: "reprove-sbx-x",
      workspaceVolume: "reprove-ws-x",
      network: "none",
    };
    const host = {
      runtime: "docker",
      fingerprint: fingerprintHost(report),
      isolation: "container",
      outcomes: checkHost(report),
      establishedAt: 0,
    } as const;

    return new Set([
      ...checkRequest(SOUND).map((each) => each.name),
      ...checkHost(report).map((each) => each.name),
      ...auditArguments(renderCreate(SOUND, names)).map((each) => each.name),
      ...attestInstance({
        request: SOUND,
        instance: BARE_INSTANCE,
        host,
        fingerprint: host.fingerprint,
        network: "none",
        workspaceVolume: "reprove-ws-x",
      }).outcomes.map((each) => each.name),
      checkQuarantine().name,
      checkResidue([]).name,
    ]);
  };

  it("are every one of them produced by some layer", () => {
    const unchecked = HARD_REQUIREMENTS.filter((name) => !produced().has(name));

    expect(unchecked).toStrictEqual([]);
  });

  it("are the only names any layer produces", () => {
    const unlisted = [...produced()].filter(
      (name) => !HARD_REQUIREMENTS.includes(name)
    );

    expect(unlisted).toStrictEqual([]);
  });
});
