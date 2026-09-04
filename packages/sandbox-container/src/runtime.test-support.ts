import { RuntimeUnavailableError } from "./runtime-unavailable.js";
/**
 * The recorded runtime output every test in this package is measured against,
 * and the fake runtime that answers with it.
 *
 * Unshipped: `tsconfig.build.json` keeps `*.test-support.ts` out of `dist`, so
 * nothing here reaches a published artifact. It is a module rather than a
 * fixture inside one test file because the same recording has to answer for
 * both dialects.
 *
 * **The Docker fixtures are recorded, not invented.** They were taken on
 * 2026-09-04 from Docker 29.1.3 on Ubuntu 24.04.4 LTS, kernel 6.12.93, cgroup
 * v2, with:
 *
 * ```
 * docker info --format '{{json .}}'
 * docker create --name reprove-probe --network none --cap-drop ALL \
 *   --security-opt no-new-privileges --pids-limit 64 --memory 268435456 \
 *   --cpus 0.5 --read-only --tmpfs /tmp:... -v reprove-probe-vol:/w alpine:latest
 * docker inspect reprove-probe --format '{{json .}}'
 * ```
 *
 * Sections irrelevant to a capability - the runtime feature blobs, the registry
 * configuration, the log driver list - are elided; every key that remains holds
 * the value that machine printed. Two of them are the reason a recording is
 * used at all rather than a hand-written document: `Binds` lists a *named
 * volume* as `name:/destination`, so "`Binds` is non-empty" is not a host bind
 * mount; and a `--tmpfs` never appears in `Mounts`, only in
 * `HostConfig.Tmpfs`.
 *
 * **The Podman fixture is constructed, and says so.** Podman is installed
 * neither on the machine this was written on nor in CI. Its shape is taken from
 * the `libpod/define` structs at podman v5.8.6 - `Info.version.Version`,
 * `Info.host.kernel`, `Info.host.cgroupVersion` (which is `"v2"`, not `"2"`),
 * `Info.host.cgroupControllers`, `Info.host.security.{rootless,seccompEnabled}`
 * - rather than from a live daemon, and the values are representative.
 */
import type { ContainerRuntime, RuntimeOutcome } from "./runtime.js";

/** The facts a host fixture varies, so a test can turn exactly one off. */
export interface HostFacts {
  readonly serverVersion: string;
  readonly kernelVersion: string;
  readonly rootless: boolean;
  readonly seccomp: boolean;
  readonly cpu: boolean;
  readonly memory: boolean;
  readonly pids: boolean;
}

const HOST: HostFacts = {
  serverVersion: "29.1.3",
  kernelVersion: "6.12.93",
  rootless: false,
  seccomp: true,
  cpu: true,
  memory: true,
  pids: true,
};

/** `docker info --format '{{json .}}'`, as Docker 29.1.3 printed it. */
export const dockerInfoStdout = (
  overrides: Partial<HostFacts> = {}
): string => {
  const facts = { ...HOST, ...overrides };
  return `${JSON.stringify({
    ID: "9c6e16a7-bdf3-4669-874b-df0d0923ca49",
    Driver: "overlayfs",
    MemoryLimit: facts.memory,
    SwapLimit: true,
    CpuCfsPeriod: true,
    CpuCfsQuota: facts.cpu,
    CPUShares: true,
    CPUSet: true,
    PidsLimit: facts.pids,
    IPv4Forwarding: true,
    CgroupDriver: "systemd",
    CgroupVersion: "2",
    KernelVersion: facts.kernelVersion,
    OperatingSystem: "Ubuntu 24.04.4 LTS",
    OSVersion: "24.04",
    OSType: "linux",
    Architecture: "x86_64",
    NCPU: 2,
    MemTotal: 8_320_557_056,
    Name: "neely-golden",
    ServerVersion: facts.serverVersion,
    DefaultRuntime: "runc",
    LiveRestoreEnabled: false,
    SecurityOptions: [
      ...(facts.seccomp ? ["name=seccomp,profile=builtin"] : []),
      "name=cgroupns",
      ...(facts.rootless ? ["name=rootless"] : []),
    ],
    ExperimentalBuild: false,
  })}\n`;
};

/** `podman info --format json`, shaped from podman v5.8.6's own structs. */
export const podmanInfoStdout = (
  overrides: Partial<HostFacts> = {}
): string => {
  const merged = { ...HOST, serverVersion: "5.8.6", ...overrides };
  return `${JSON.stringify({
    host: {
      arch: "amd64",
      buildahVersion: "1.38.0",
      cgroupManager: "systemd",
      cgroupVersion: "v2",
      cgroupControllers: [
        ...(merged.cpu ? ["cpu"] : []),
        ...(merged.memory ? ["memory"] : []),
        ...(merged.pids ? ["pids"] : []),
      ],
      distribution: { distribution: "ubuntu", version: "24.04" },
      kernel: merged.kernelVersion,
      logDriver: "journald",
      networkBackend: "netavark",
      ociRuntime: { name: "crun", path: "/usr/bin/crun" },
      os: "linux",
      remoteSocket: {
        path: "/run/user/1000/podman/podman.sock",
        exists: true,
      },
      security: {
        apparmorEnabled: true,
        capabilities: "CAP_CHOWN,CAP_DAC_OVERRIDE,CAP_FOWNER",
        rootless: merged.rootless,
        seccompEnabled: merged.seccomp,
        seccompProfilePath: "/usr/share/containers/seccomp.json",
        selinuxEnabled: false,
      },
      serviceIsRemote: false,
    },
    store: {
      graphDriverName: "overlay",
      graphRoot: "/home/reprove/.local/share/containers/storage",
      runRoot: "/run/user/1000/containers",
    },
    version: {
      APIVersion: merged.serverVersion,
      Version: merged.serverVersion,
      GoVersion: "go1.23.4",
      OsArch: "linux/amd64",
      Os: "linux",
    },
  })}\n`;
};

/** The facts an instance fixture varies, so a test can break exactly one. */
export interface InstanceFacts {
  readonly id: string;
  readonly privileged: boolean;
  readonly securityOpt: readonly string[];
  readonly capAdd: readonly string[];
  readonly capDrop: readonly string[];
  readonly networkMode: string;
  readonly pidMode: string;
  readonly memory: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly readonlyRootfs: boolean;
  readonly workspaceVolume: string;
  readonly workspacePath: string;
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly extraBinds: readonly string[];
  readonly extraMounts: readonly {
    readonly Type: string;
    readonly Source: string;
    readonly Destination: string;
  }[];
}

const INSTANCE: InstanceFacts = {
  id: "6ad043fc544228215d48bca5cd453ad0a3170ec10ebe1224b831287c1d34714e",
  privileged: false,
  securityOpt: ["no-new-privileges"],
  capAdd: [],
  capDrop: ["ALL"],
  networkMode: "none",
  pidMode: "",
  memory: 268_435_456,
  nanoCpus: 500_000_000,
  pidsLimit: 64,
  readonlyRootfs: true,
  workspaceVolume: "reprove-ws-probe",
  workspacePath: "/reprove/workspace",
  tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=67108864" },
  extraBinds: [],
  extraMounts: [],
};

/** `docker inspect <id> --format '{{json .}}'`, reduced to what is read. */
export const inspectStdout = (
  overrides: Partial<InstanceFacts> = {}
): string => {
  const facts = { ...INSTANCE, ...overrides };
  return `${JSON.stringify({
    Id: facts.id,
    Created: "2026-09-04T01:26:07.984114263Z",
    Name: "/reprove-sbx-probe",
    HostConfig: {
      // A named volume, not a host path - and Docker still lists it here.
      Binds: [
        `${facts.workspaceVolume}:${facts.workspacePath}`,
        ...facts.extraBinds,
      ],
      NetworkMode: facts.networkMode,
      CapAdd: facts.capAdd.length === 0 ? null : facts.capAdd,
      CapDrop: facts.capDrop,
      CgroupnsMode: "private",
      IpcMode: "private",
      PidMode: facts.pidMode,
      Privileged: facts.privileged,
      ReadonlyRootfs: facts.readonlyRootfs,
      SecurityOpt: facts.securityOpt,
      Tmpfs: facts.tmpfs,
      UsernsMode: "",
      Runtime: "runc",
      Memory: facts.memory,
      NanoCpus: facts.nanoCpus,
      PidsLimit: facts.pidsLimit,
    },
    Mounts: [
      {
        Type: "volume",
        Name: facts.workspaceVolume,
        Source: `/var/lib/docker/volumes/${facts.workspaceVolume}/_data`,
        Destination: facts.workspacePath,
        Driver: "local",
        Mode: "z",
        RW: true,
        Propagation: "",
      },
      ...facts.extraMounts,
    ],
  })}\n`;
};

/** What `docker ps -a --format '{{.Names}}'` prints for a set of instances. */
export const linesStdout = (names: readonly string[]): string =>
  names.length === 0 ? "" : `${names.join("\n")}\n`;

/** What a teardown re-list still finds, per kind. */
export interface Survivors {
  readonly instances: readonly string[];
  readonly volumes: readonly string[];
  readonly networks: readonly string[];
}

/** How the fake runtime answers one invocation, keyed by its first arguments. */
export interface RuntimeScript {
  readonly info: () => RuntimeOutcome;
  readonly inspect: (id: string) => RuntimeOutcome;
  /** Everything the teardown re-list finds still there. */
  readonly survivors?: () => Survivors;
}

export interface RecordingRuntime extends ContainerRuntime {
  readonly invocations: readonly (readonly string[])[];
  /** Every argument the runtime was ever handed, flattened. */
  readonly everyArgument: () => readonly string[];
  /** How many invocations led with a given first argument. */
  readonly countOf: (first: string) => number;
  /** Makes every later invocation leading with this argument exit non-zero. */
  readonly refuse: (first: string) => void;
  /**
   * Makes every later invocation leading with this argument reject outright.
   *
   * Not the same fault as `refuse`, and kept apart deliberately: a non-zero
   * exit is the daemon answering "no", and a rejection is no answer at all.
   * Anything that handles only the first fails open on the second.
   */
  readonly reject: (first: string) => void;
}

const ok = (stdout: string): RuntimeOutcome => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

const failed = (stderr: string): RuntimeOutcome => ({
  exitCode: 1,
  stdout: "",
  stderr,
});

/**
 * A runtime that records every argument vector and answers from the script.
 *
 * It dispatches on the leading argument rather than pattern-matching the whole
 * vector, so a test that changes how an argument is rendered still runs and
 * still asserts on what was rendered.
 */
export const createRecordingRuntime = (
  name: ContainerRuntime["name"],
  script: RuntimeScript
): RecordingRuntime => {
  const invocations: (readonly string[])[] = [];
  const refused = new Set<string>();
  const unavailable = new Set<string>();
  const survivors =
    script.survivors ??
    (() => ({
      instances: [],
      volumes: [],
      networks: [],
    }));

  const answer = (argv: readonly string[]): RuntimeOutcome => {
    const [first, second] = argv;
    if (first !== undefined && refused.has(first)) {
      return failed(`${name}: ${first} refused by the script`);
    }
    if (first === "info") {
      return script.info();
    }
    if (first === "inspect") {
      return script.inspect(second ?? "");
    }
    if (first === "create") {
      return ok(`${INSTANCE.id}\n`);
    }
    if (first === "ps") {
      return ok(linesStdout(survivors().instances));
    }
    if (first === "volume") {
      return ok(second === "ls" ? linesStdout(survivors().volumes) : "");
    }
    if (first === "network") {
      return ok(second === "ls" ? linesStdout(survivors().networks) : "");
    }
    return ok("");
  };

  return {
    name,
    invocations,
    everyArgument: () => invocations.flat(),
    refuse: (first) => {
      refused.add(first);
    },
    reject: (first) => {
      unavailable.add(first);
    },
    countOf: (first) => invocations.filter((argv) => argv[0] === first).length,
    invoke: (invocation) => {
      invocations.push(invocation.arguments);
      const [first] = invocation.arguments;
      if (first !== undefined && unavailable.has(first)) {
        return Promise.reject(
          new RuntimeUnavailableError(name, name, "did not run")
        );
      }
      return Promise.resolve(answer(invocation.arguments));
    },
  };
};
