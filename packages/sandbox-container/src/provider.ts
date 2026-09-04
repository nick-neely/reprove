/**
 * The provider: the one path from a request to a running Sandbox.
 *
 * `launch()` is a fixed ordered pipeline, and there is no path to a `Sandbox`
 * that skipped a step in it:
 *
 * ```text
 *  1 quarantine gate     refuses with zero runtime invocations
 *  2 request check       refuses with zero runtime invocations
 *  3 host capability     cached, or established from one `info`
 *  4 fresh fingerprint   compared against the cached one; drift evicts
 *  5 render              the argument vector
 *  6 argument audit      refuses before anything is created
 *  7 own the resources   the Workspace volume, and the network if there is one
 *  8 create              the instance exists and is not running
 *  9 attest              refuses, having removed what it created
 * 10 start               execution is authorized only here
 * ```
 *
 * Steps 8 and 10 are split precisely so step 9 happens before a single byte of
 * repository code runs. A `run` would have started the instance before anything
 * could be read back from it, and an Attestation taken after execution began is
 * a description rather than a gate.
 *
 * Steps 7 to 10 are one region that owns resources, and a failure anywhere in
 * it releases them all on the way out.
 *
 * Worker core remains the sole authorizer of execution. Every gate here can
 * only refuse.
 */
import {
  auditArguments,
  createArguments,
  redactedArguments,
  renderCreate,
  SANDBOX_LABEL,
} from "./arguments.js";
import type { LaunchNames, RenderedCreate } from "./arguments.js";
import { attestInstance, fingerprintOutcome } from "./attestation.js";
import type { Attestation } from "./attestation.js";
import {
  checkHost,
  checkQuarantine,
  createCapabilityCache,
  fingerprintHost,
  hostIsolation,
} from "./capability.js";
import type {
  CapabilityCache,
  HostCapability,
  HostFingerprint,
  HostReport,
} from "./capability.js";
import { DOCKER_DIALECT, PODMAN_DIALECT } from "./dialect.js";
import type { RuntimeDialect } from "./dialect.js";
import { SandboxRefusalError } from "./refusal.js";
import type { Isolation, RuntimeName, SandboxRequest } from "./request.js";
import { allSatisfied, checkRequest } from "./requirements.js";
import { checkResidue, SandboxTeardownError } from "./residue.js";
import type { Residue } from "./residue.js";
import type { ContainerRuntime } from "./runtime.js";

/** The Workspace, as something a caller can name without reaching a runtime. */
export interface WorkspaceHandle {
  /** The sandbox-owned volume it lives on. */
  readonly id: string;
  /** Where it is mounted inside the Sandbox. */
  readonly path: string;
  /** There is no other kind. */
  readonly ephemeral: true;
}

/** What running a command inside a Sandbox produced. */
export interface ExecOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What a completed teardown returns. `residue` is always empty: a teardown that
 * left something behind raises `SandboxTeardownError` instead of returning a
 * receipt that admits it.
 */
export interface TeardownReceipt {
  readonly residue: readonly Residue[];
}

/**
 * What a teardown could not account for, and why it could not.
 *
 * Internal: it carries the quarantine's reason, and the reason a host was
 * quarantined is a Worker's to read from the Failure rather than from a shape
 * this package publishes.
 */
interface Unaccounted {
  readonly residue: readonly Residue[];
  readonly detail: string;
}

export interface Sandbox {
  readonly id: string;
  readonly isolation: Isolation;
  /** The Attestation that authorized this instance. Never absent. */
  readonly attestation: Attestation;
  readonly workspace: WorkspaceHandle;
  readonly exec: (command: readonly string[]) => Promise<ExecOutcome>;
  readonly teardown: () => Promise<TeardownReceipt>;
}

export interface SandboxProvider {
  readonly runtime: RuntimeName;
  /** The host capability, established once from a fingerprint and cached. */
  readonly capability: () => Promise<HostCapability>;
  /** Refuses, or returns a Sandbox that has already attested fresh. */
  readonly launch: (request: SandboxRequest) => Promise<Sandbox>;
}

/** What a provider needs that it will not reach for on its own. */
export interface SandboxProviderOptions {
  readonly runtime: ContainerRuntime;
  readonly dialect: RuntimeDialect;
  /**
   * Defaults to one cache shared by every provider in the process.
   *
   * Shared rather than per-provider because a quarantine is a fact about the
   * *host*, and a Worker that constructs a provider per Run would otherwise
   * throw the quarantine away with the provider that raised it - which is the
   * whole of what the quarantine was for. Pass one to scope it deliberately;
   * tests do.
   */
  readonly cache?: CapabilityCache;
  readonly clock?: () => number;
  readonly newId?: () => string;
}

/** The same, for a provider whose dialect is already decided. */
export interface RuntimeProviderOptions {
  readonly runtime: ContainerRuntime;
  readonly cache?: CapabilityCache;
  readonly clock?: () => number;
  readonly newId?: () => string;
}

/**
 * The cache every provider shares unless it was given one.
 *
 * Process-lifetime, which is also the answer to "how does an operator clear a
 * quarantine": fix the host and restart. A file-backed cache would outlive the
 * process, and a writable file that decides whether a Sandbox may run is a
 * capability-forgery surface - so the interface is injectable and the default
 * is not durable.
 */
const SHARED_CACHE = createCapabilityCache();

const randomId = (): string =>
  // Node's crypto is a builtin and this package depends on nothing else.
  globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16);

const lines = (stdout: string): readonly string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * Everything a launch created, presumed to have survived.
 *
 * What teardown falls back to when it could not ask. A removal the runtime
 * never answered and a re-list that produced no answer leave the same question
 * open, and the only honest answer to "what is still out there" is everything,
 * until something proves otherwise.
 */
const presumed = (names: LaunchNames): readonly Residue[] => {
  const created: readonly Residue[] = [
    { kind: "instance", id: names.instance },
    { kind: "workspace", id: names.workspaceVolume },
    { kind: "network", id: names.network },
  ];
  return names.network === "none" ? created.slice(0, -1) : created;
};

export const createSandboxProvider = (
  options: SandboxProviderOptions
): SandboxProvider => {
  const { runtime, dialect } = options;
  if (runtime.name !== dialect.name) {
    throw new TypeError(
      `a ${dialect.name} dialect cannot drive a ${runtime.name} runtime: the argument vector and the report reader would disagree about which daemon they are talking to`
    );
  }
  const cache = options.cache ?? SHARED_CACHE;
  const clock = options.clock ?? Date.now;
  const newId = options.newId ?? randomId;

  /** Invokes the runtime, tolerating a non-zero exit. */
  const attempt = (argv: readonly string[]) =>
    runtime.invoke({ arguments: argv });

  /** Invokes the runtime, where a non-zero exit is not a fact but a fault. */
  const invoke = async (argv: readonly string[]): Promise<string> => {
    const invoked = await attempt(argv);
    if (invoked.exitCode !== 0) {
      throw new Error(
        `${dialect.executable} ${redactedArguments(argv).join(" ")} exited ${invoked.exitCode}: ${invoked.stderr.trim()}`
      );
    }
    return invoked.stdout;
  };

  const readHost = async (): Promise<HostReport> =>
    dialect.readHostReport(await invoke(dialect.hostReportArguments));

  const establish = (report: HostReport): HostCapability => {
    const established: HostCapability = {
      runtime: dialect.name,
      fingerprint: fingerprintHost(report),
      isolation: hostIsolation(report),
      outcomes: checkHost(report),
      establishedAt: clock(),
    };
    cache.write(established);
    return established;
  };

  const capability = async (): Promise<HostCapability> =>
    cache.read(dialect.name) ?? establish(await readHost());

  /** Removes everything a launch owns, without asking whether it worked. */
  const release = async (names: LaunchNames): Promise<void> => {
    await attempt(["rm", "--force", "--volumes", names.instance]);
    await attempt(["volume", "rm", names.workspaceVolume]);
    if (names.network !== "none") {
      await attempt(["network", "rm", names.network]);
    }
  };

  const survivors = async (names: LaunchNames): Promise<readonly Residue[]> => {
    const instances = lines(
      await invoke([
        "ps",
        "-a",
        "--filter",
        `name=${names.instance}`,
        "--format",
        "{{.Names}}",
      ])
    );
    const volumes = lines(
      await invoke([
        "volume",
        "ls",
        "--filter",
        `name=${names.workspaceVolume}`,
        "--format",
        "{{.Name}}",
      ])
    );
    const networks =
      names.network === "none"
        ? []
        : lines(
            await invoke([
              "network",
              "ls",
              "--filter",
              `name=${names.network}`,
              "--format",
              "{{.Name}}",
            ])
          );

    // Exact names, not what the filter matched. Both runtimes treat a name
    // filter as a substring or a pattern, so a neighbour whose name contains
    // this one would otherwise read as residue.
    return [
      ...instances
        .filter((name) => name === names.instance)
        .map((id): Residue => ({ kind: "instance", id })),
      ...volumes
        .filter((name) => name === names.workspaceVolume)
        .map((id): Residue => ({ kind: "workspace", id })),
      ...networks
        .filter((name) => name === names.network)
        .map((id): Residue => ({ kind: "network", id })),
    ];
  };

  /**
   * Removes everything a launch owns and proves what is left.
   *
   * Every way this can go wrong is the same posture: not knowing whether
   * anything survived is not weaker evidence than knowing it did, it is the
   * same absence of proof. So a removal that never reached the runtime, a
   * re-list that exited non-zero and a re-list that found something all leave
   * here as residue with a detail that says which of the three it was.
   */
  const destroy = async (names: LaunchNames): Promise<Unaccounted> => {
    try {
      await release(names);
      const residue = await survivors(names);
      return { residue, detail: checkResidue(residue).detail };
    } catch (error) {
      return {
        residue: presumed(names),
        detail: `teardown could not be confirmed, so nothing it created can be assumed gone: ${String(error)}`,
      };
    }
  };

  const teardown = async (names: LaunchNames): Promise<TeardownReceipt> => {
    const unaccounted = await destroy(names);
    if (unaccounted.residue.length > 0) {
      // Fail closed and stay closed. A host that cannot prove it destroyed the
      // last Sandbox cannot be trusted with the next one, so this outlives the
      // Failure that raised it.
      cache.quarantine(dialect.name, unaccounted.detail);
      throw new SandboxTeardownError(unaccounted.residue);
    }
    return { residue: [] };
  };

  /**
   * Gives up on a launch, and quarantines the runtime if giving up did not
   * work.
   *
   * The same posture as `teardown`, minus the throw: the Refusal that sent us
   * here is the error the caller gets, so residue on this path has no exception
   * of its own to travel in - which is exactly why it has to stick. Without it
   * a `create` that succeeded, an Attestation that refused and an `rm` that
   * then failed leave an instance and a volume that nobody ever hears about,
   * and ADR 0015 reserves an identifier for that precisely so it is never
   * silent.
   */
  const abandon = async (names: LaunchNames): Promise<void> => {
    const unaccounted = await destroy(names);
    if (unaccounted.residue.length > 0) {
      cache.quarantine(dialect.name, unaccounted.detail);
    }
  };

  /**
   * Everything a launch owns, from the first resource it creates to the moment
   * execution is authorized.
   *
   * One region rather than a step at a time, and released whole if any part of
   * it throws. A `create` the runtime rejects leaves a Workspace volume behind
   * exactly as readily as a failed Attestation does, and a volume outlives the
   * process that made it.
   *
   * The error that leaves is the one that arrived. A cleanup failure reported
   * in place of a Refusal would hide which requirement failed, which is the
   * only thing anyone reading it needs.
   */
  const own = async (
    request: SandboxRequest,
    names: LaunchNames,
    rendered: RenderedCreate,
    host: HostCapability,
    fingerprint: HostFingerprint
  ): Promise<Attestation> => {
    try {
      await invoke([
        "volume",
        "create",
        "--label",
        SANDBOX_LABEL,
        names.workspaceVolume,
      ]);
      if (names.network !== "none") {
        await invoke([
          "network",
          "create",
          "--internal",
          "--label",
          SANDBOX_LABEL,
          names.network,
        ]);
      }
      await invoke(createArguments(rendered));

      const instance = dialect.readInstanceReport(
        await invoke(dialect.instanceReportArguments(names.instance))
      );
      const attestation = attestInstance({
        request,
        instance,
        host,
        fingerprint,
        network: names.network,
        workspaceVolume: names.workspaceVolume,
      });
      if (!attestation.authorized) {
        throw new SandboxRefusalError(attestation.outcomes);
      }

      // Execution is authorized here and nowhere earlier.
      await invoke(["start", names.instance]);
      return attestation;
    } catch (error) {
      await abandon(names);
      throw error;
    }
  };

  const launch = async (request: SandboxRequest): Promise<Sandbox> => {
    const gate = checkQuarantine(cache.quarantinedFor(dialect.name));
    if (!gate.satisfied) {
      throw new SandboxRefusalError([gate]);
    }

    const requested = checkRequest(request);
    if (!allSatisfied(requested)) {
      throw new SandboxRefusalError(requested);
    }

    const report = await readHost();
    const observed = fingerprintHost(report);
    const host = cache.read(dialect.name) ?? establish(report);
    if (!allSatisfied(host.outcomes)) {
      throw new SandboxRefusalError(host.outcomes);
    }

    const unchanged = fingerprintOutcome(observed, host.fingerprint);
    if (!unchanged.satisfied) {
      // Drift, not residue: forget the capability so the next launch measures
      // the host as it is now, and refuse the instance that would have used the
      // capability it is no longer described by.
      cache.evict(dialect.name);
      throw new SandboxRefusalError([unchanged]);
    }

    const id = newId();
    const names: LaunchNames = {
      instance: `reprove-sbx-${id}`,
      workspaceVolume: `reprove-ws-${id}`,
      network: request.egress.kind === "none" ? "none" : `reprove-net-${id}`,
    };
    const rendered = renderCreate(request, names);

    const audited = auditArguments(rendered);
    if (!allSatisfied(audited)) {
      throw new SandboxRefusalError(audited);
    }

    const attested = await own(request, names, rendered, host, observed);

    return {
      id: names.instance,
      isolation: attested.isolation,
      attestation: attested,
      workspace: {
        id: names.workspaceVolume,
        path: request.workspace.path,
        ephemeral: true,
      },
      exec: async (command) => {
        // `--` again, for the same reason it is in the create vector: nothing a
        // caller supplies should reach the runtime's argument parser as a flag.
        // Both runtimes already stop parsing flags at the instance name, so
        // this costs nothing and stops depending on that.
        const invoked = await attempt([
          "exec",
          "--",
          names.instance,
          ...command,
        ]);
        return {
          exitCode: invoked.exitCode,
          stdout: invoked.stdout,
          stderr: invoked.stderr,
        };
      },
      teardown: () => teardown(names),
    };
  };

  return { runtime: dialect.name, capability, launch };
};

/** A provider driving Docker through the injected runtime. */
export const createDockerProvider = (
  options: RuntimeProviderOptions
): SandboxProvider =>
  createSandboxProvider({ ...options, dialect: DOCKER_DIALECT });

/** A provider driving Podman through the injected runtime. */
export const createPodmanProvider = (
  options: RuntimeProviderOptions
): SandboxProvider =>
  createSandboxProvider({ ...options, dialect: PODMAN_DIALECT });
