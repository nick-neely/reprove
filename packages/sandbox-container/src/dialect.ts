/**
 * The whole of the difference between Docker and Podman, as data.
 *
 * There is one implementation of the Sandbox contract and two dialects, rather
 * than two providers. The differences that actually exist for the arguments ADR
 * 0004 needs are an executable name and two report readers; the argument
 * rendering, the launch pipeline, the Attestation and the teardown are
 * identical. Duplicating them would duplicate the security-critical part, and
 * duplicated security code is how one of the two copies drifts silently.
 *
 * If Podman ever needs `--userns=keep-id`, a quadlet or a `podman machine`
 * path, the dialect has become a strategy and two implementations become the
 * right answer. It has not yet.
 *
 * Each reader states the runtime's own JSON as an interface of optional fields
 * and then requires every field it uses by name, so a report that changed shape
 * upstream throws naming the field rather than reading as a permissive default.
 */
import type { InstanceReport, ObservedMount } from "./attestation.js";
import type { HostReport } from "./capability.js";
import type { RuntimeName } from "./request.js";

/** The per-runtime table. Everything not here is shared. */
export interface RuntimeDialect {
  readonly name: RuntimeName;
  readonly executable: string;
  readonly hostReportArguments: readonly string[];
  readonly readHostReport: (stdout: string) => HostReport;
  readonly instanceReportArguments: (id: string) => readonly string[];
  readonly readInstanceReport: (stdout: string) => InstanceReport;
}

const missing = (runtime: RuntimeName, what: string, field: string): never => {
  throw new TypeError(
    `${runtime} reported ${what} without ${field}, so nothing can be concluded about the boundary from it`
  );
};

const requireText = (
  value: string | undefined,
  runtime: RuntimeName,
  what: string,
  field: string
): string =>
  value === undefined || value === "" ? missing(runtime, what, field) : value;

const requireFlag = (
  value: boolean | undefined,
  runtime: RuntimeName,
  what: string,
  field: string
): boolean => (value === undefined ? missing(runtime, what, field) : value);

const requireNumber = (
  value: number | undefined,
  runtime: RuntimeName,
  what: string,
  field: string
): number => (value === undefined ? missing(runtime, what, field) : value);

// --- the host report ---------------------------------------------------------

/** `docker info --format '{{json .}}'`, reduced to what a capability reads. */
interface DockerInfo {
  readonly ServerVersion?: string;
  readonly KernelVersion?: string;
  readonly CgroupVersion?: string;
  readonly SecurityOptions?: readonly string[];
  readonly MemoryLimit?: boolean;
  readonly PidsLimit?: boolean;
  readonly CpuCfsQuota?: boolean;
}

/**
 * One `docker info` security option, which is a comma-separated field list
 * whose first field is `name=<feature>`.
 */
const securityOption = (
  options: readonly string[],
  feature: string
): readonly string[] | undefined =>
  options
    .map((option) => option.split(","))
    .find((fields) => fields[0] === `name=${feature}`);

const readDockerHostReport = (stdout: string): HostReport => {
  const info: DockerInfo = JSON.parse(stdout);
  const options = info.SecurityOptions ?? [];
  const seccomp = securityOption(options, "seccomp");

  return {
    runtime: "docker",
    serverVersion: requireText(
      info.ServerVersion,
      "docker",
      "its host",
      "ServerVersion"
    ),
    kernelVersion: requireText(
      info.KernelVersion,
      "docker",
      "its host",
      "KernelVersion"
    ),
    cgroupVersion: requireText(
      info.CgroupVersion,
      "docker",
      "its host",
      "CgroupVersion"
    ),
    // `name=rootless` appears only on a rootless daemon.
    rootless: securityOption(options, "rootless") !== undefined,
    // Absent means the daemon applies no profile at all, which is the state a
    // `--security-opt` on one instance can neither cause nor repair.
    seccompEnabled:
      seccomp !== undefined && !seccomp.includes("profile=unconfined"),
    cpuQuotaSupported: requireFlag(
      info.CpuCfsQuota,
      "docker",
      "its host",
      "CpuCfsQuota"
    ),
    memoryLimitSupported: requireFlag(
      info.MemoryLimit,
      "docker",
      "its host",
      "MemoryLimit"
    ),
    processLimitSupported: requireFlag(
      info.PidsLimit,
      "docker",
      "its host",
      "PidsLimit"
    ),
  };
};

/** `podman info --format json`, reduced to what a capability reads. */
interface PodmanInfo {
  readonly host?: {
    readonly kernel?: string;
    readonly cgroupVersion?: string;
    readonly cgroupControllers?: readonly string[];
    readonly security?: {
      readonly rootless?: boolean;
      readonly seccompEnabled?: boolean;
    };
  };
  readonly version?: { readonly Version?: string };
}

const readPodmanHostReport = (stdout: string): HostReport => {
  const info: PodmanInfo = JSON.parse(stdout);
  const { host } = info;
  const controllers = host?.cgroupControllers ?? [];
  // Podman prints `v2`; Docker prints `2`. One fact, so one spelling.
  const cgroupVersion = requireText(
    host?.cgroupVersion,
    "podman",
    "its host",
    "host.cgroupVersion"
  ).replace("v", "");

  return {
    runtime: "podman",
    serverVersion: requireText(
      info.version?.Version,
      "podman",
      "its host",
      "version.Version"
    ),
    kernelVersion: requireText(
      host?.kernel,
      "podman",
      "its host",
      "host.kernel"
    ),
    cgroupVersion,
    rootless: requireFlag(
      host?.security?.rootless,
      "podman",
      "its host",
      "host.security.rootless"
    ),
    seccompEnabled: requireFlag(
      host?.security?.seccompEnabled,
      "podman",
      "its host",
      "host.security.seccompEnabled"
    ),
    // Podman reports what the cgroup delegated rather than what it supports, so
    // an absent controller is an unenforceable limit.
    cpuQuotaSupported: controllers.includes("cpu"),
    memoryLimitSupported: controllers.includes("memory"),
    processLimitSupported: controllers.includes("pids"),
  };
};

// --- the instance report -----------------------------------------------------

/**
 * `<runtime> inspect <id> --format '{{json .}}'`, reduced to what an
 * Attestation reads. Podman's inspect output carries a Docker-compatible
 * `HostConfig` and the same top-level `Id` and `Mounts`, so one reader answers
 * for both.
 */
interface InstanceInspect {
  readonly Id?: string;
  readonly HostConfig?: {
    readonly Binds?: readonly string[] | null;
    readonly NetworkMode?: string;
    readonly CapAdd?: readonly string[] | null;
    readonly CapDrop?: readonly string[] | null;
    readonly PidMode?: string;
    readonly Privileged?: boolean;
    readonly ReadonlyRootfs?: boolean;
    readonly SecurityOpt?: readonly string[] | null;
    readonly Tmpfs?: Readonly<Record<string, string>> | null;
    readonly Memory?: number;
    readonly NanoCpus?: number;
    readonly PidsLimit?: number;
  };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Name?: string;
    readonly Source?: string;
    readonly Destination?: string;
  }[];
}

/**
 * One resolved mount.
 *
 * A `volume` is named by its volume name rather than by `Source`, which is the
 * host directory the runtime backs every volume with and therefore says nothing
 * about whether the mount came from outside the Sandbox. Anything whose type is
 * neither `volume` nor `tmpfs` is read as a bind: an unrecognised mount kind is
 * something from outside the boundary until proven otherwise.
 */
const readMount = (
  runtime: RuntimeName,
  mount: {
    readonly Type?: string;
    readonly Name?: string;
    readonly Source?: string;
    readonly Destination?: string;
  }
): ObservedMount => {
  const destination = requireText(
    mount.Destination,
    runtime,
    "a mount",
    "Destination"
  );
  if (mount.Type === "volume") {
    return {
      kind: "volume",
      source: requireText(mount.Name, runtime, "a volume mount", "Name"),
      destination,
    };
  }
  if (mount.Type === "tmpfs") {
    return { kind: "tmpfs", source: "", destination };
  }
  return { kind: "bind", source: mount.Source ?? "", destination };
};

const readInstanceReport =
  (runtime: RuntimeName) =>
  (stdout: string): InstanceReport => {
    const inspected: InstanceInspect = JSON.parse(stdout);
    const config = inspected.HostConfig;
    if (config === undefined) {
      return missing(runtime, "an instance", "HostConfig");
    }
    // A `--tmpfs` never appears in `Mounts`. It is only ever in `HostConfig`,
    // which is why the two are read together rather than one standing in for
    // the other.
    const tmpfs: readonly ObservedMount[] = Object.keys(config.Tmpfs ?? {}).map(
      (destination) => ({ kind: "tmpfs", source: "", destination })
    );

    return {
      instanceId: requireText(inspected.Id, runtime, "an instance", "Id"),
      privileged: requireFlag(
        config.Privileged,
        runtime,
        "an instance",
        "HostConfig.Privileged"
      ),
      securityOptions: config.SecurityOpt ?? [],
      addedCapabilities: config.CapAdd ?? [],
      droppedCapabilities: config.CapDrop ?? [],
      binds: config.Binds ?? [],
      mounts: [
        ...(inspected.Mounts ?? []).map((mount) => readMount(runtime, mount)),
        ...tmpfs,
      ],
      networkMode: requireText(
        config.NetworkMode,
        runtime,
        "an instance",
        "HostConfig.NetworkMode"
      ),
      // Docker leaves a private PID namespace as the empty string, which is a
      // value rather than an absence, so it is read without requiring it.
      pidMode: config.PidMode ?? "",
      memoryBytes: requireNumber(
        config.Memory,
        runtime,
        "an instance",
        "HostConfig.Memory"
      ),
      processLimit: requireNumber(
        config.PidsLimit,
        runtime,
        "an instance",
        "HostConfig.PidsLimit"
      ),
      cpuQuotaNanos: requireNumber(
        config.NanoCpus,
        runtime,
        "an instance",
        "HostConfig.NanoCpus"
      ),
      readOnlyRootFilesystem: requireFlag(
        config.ReadonlyRootfs,
        runtime,
        "an instance",
        "HostConfig.ReadonlyRootfs"
      ),
    };
  };

const inspectArguments = (id: string): readonly string[] => [
  "inspect",
  id,
  "--format",
  "{{json .}}",
];

export const DOCKER_DIALECT: RuntimeDialect = {
  name: "docker",
  executable: "docker",
  hostReportArguments: ["info", "--format", "{{json .}}"],
  readHostReport: readDockerHostReport,
  instanceReportArguments: inspectArguments,
  readInstanceReport: readInstanceReport("docker"),
};

export const PODMAN_DIALECT: RuntimeDialect = {
  name: "podman",
  executable: "podman",
  // Podman's own spelling. `--format json` is not `--format '{{json .}}'`.
  hostReportArguments: ["info", "--format", "json"],
  readHostReport: readPodmanHostReport,
  instanceReportArguments: inspectArguments,
  readInstanceReport: readInstanceReport("podman"),
};
