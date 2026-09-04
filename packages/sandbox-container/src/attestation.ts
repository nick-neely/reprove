/**
 * The fresh proof, taken per instance, that the thing the runtime actually
 * created holds every hard Sandbox property.
 *
 * A capability says the host *could*; an Attestation says this instance *did*.
 * They are kept apart because caching the first is what makes launching cheap
 * and caching the second would make the boundary a memory of a boundary. The
 * observed host fingerprint is re-decided here too, so a host that drifted
 * since its capability was established is caught at the instance that would
 * have used it rather than at the next probe.
 *
 * **This can only refuse, never grant.** Worker core remains the sole
 * authorizer of execution: it decides whether a Run is dispatched at all, and
 * an Attestation is one more gate that dispatch has to survive. Nothing here
 * makes a Sandbox eligible for anything; it only takes eligibility away.
 */
import type { HostCapability, HostFingerprint } from "./capability.js";
import type { Isolation, SandboxRequest } from "./request.js";
import {
  allSatisfied,
  isRuntimeSocket,
  isSharedNamespace,
  listed,
  outcome,
} from "./requirements.js";
import type { RequirementOutcome } from "./requirements.js";

/**
 * One mount as the runtime resolved it, which is not the same list as the one
 * that was requested.
 *
 * `source` is the volume's own name for a `volume`, the host path for a `bind`,
 * and empty for a `tmpfs`. Docker reports a volume's `Source` as the directory
 * it backs the volume with, which is a host path for every volume ever created
 * and therefore useless for telling a volume from a bind mount; the reader uses
 * the reported `Type` and `Name` instead.
 */
export interface ObservedMount {
  readonly kind: "volume" | "tmpfs" | "bind";
  readonly source: string;
  readonly destination: string;
}

/** What the runtime reports about the instance it actually created. */
export interface InstanceReport {
  readonly instanceId: string;
  readonly privileged: boolean;
  readonly securityOptions: readonly string[];
  readonly addedCapabilities: readonly string[];
  readonly droppedCapabilities: readonly string[];
  /**
   * The mount requests as they were written, before the runtime resolved them.
   * Read beside `mounts` rather than instead of it: a named volume appears here
   * as `name:/destination` and is not a host bind mount, which is exactly the
   * confusion that makes "`Binds` is non-empty" the wrong check.
   */
  readonly binds: readonly string[];
  readonly mounts: readonly ObservedMount[];
  readonly networkMode: string;
  readonly pidMode: string;
  readonly memoryBytes: number;
  readonly processLimit: number;
  readonly cpuQuotaNanos: number;
  readonly readOnlyRootFilesystem: boolean;
}

/**
 * Everything an Attestation is measured against.
 *
 * `network` and `workspaceVolume` are stated rather than inferred, because the
 * only honest question about them is whether the instance holds *the* network
 * and *the* volume this Sandbox owns. An instance on some other private network
 * is one this provider did not shape, and inferring "private enough" from the
 * name would be a blocklist pretending to be a proof.
 */
export interface AttestationInput {
  readonly request: SandboxRequest;
  readonly instance: InstanceReport;
  /**
   * The capability the launch was authorized against.
   *
   * Taken as stated. Its `isolation` becomes the Attestation's, and its
   * outcomes stand in for the facts an instance report cannot see, so a caller
   * that fabricates one is attesting against a host it made up. The provider
   * only ever passes one it established itself.
   */
  readonly host: HostCapability;
  /** The fingerprint observed now, which may no longer be the host's. */
  readonly fingerprint: HostFingerprint;
  /** The Sandbox-owned network's name, or `none`. */
  readonly network: string;
  /** The Sandbox-owned volume the Workspace lives on. */
  readonly workspaceVolume: string;
}

/** What an Attestation concluded. `authorized` is every outcome, and-ed. */
export interface Attestation {
  readonly authorized: boolean;
  readonly isolation: Isolation;
  readonly outcomes: readonly RequirementOutcome[];
}

/** Both runtimes spell "a namespace of its own" one of these two ways. */
const PRIVATE_PID_MODES: ReadonlySet<string> = new Set(["", "private"]);

/** The host path a `--volume` or `--mount` argument names, before the `:`. */
const bindSource = (bind: string): string => bind.slice(0, bind.indexOf(":"));

const isHostPath = (source: string): boolean => source.startsWith("/");

const seccompOption = (options: readonly string[]): string | undefined =>
  options.find((option) => option.startsWith("seccomp="));

/**
 * Whether the host capability decided a requirement *and* it held.
 *
 * A capability that never measured it is not a capability that passed it.
 * `every` would read an absent outcome as a pass, and `AttestationInput.host`
 * is caller-supplied, so an empty outcome list would delete the only layer that
 * can see whether the daemon applies a seccomp profile at all.
 */
const hostSaid = (host: HostCapability, name: "seccomp-enabled"): boolean =>
  host.outcomes.some((each) => each.name === name && each.satisfied);

/**
 * Did the host stay the host its capability describes?
 *
 * Exported because the provider decides the same thing one step earlier, before
 * an instance exists to attest at all. Two copies of one comparison is two
 * messages an operator has to recognise as the same fact.
 *
 * @param observed The fingerprint taken now.
 * @param established The fingerprint the capability was established at.
 */
export const fingerprintOutcome = (
  observed: HostFingerprint,
  established: HostFingerprint
): RequirementOutcome => {
  const unchanged = observed === established;
  return outcome(
    "host-fingerprint-unchanged",
    unchanged,
    unchanged
      ? `the host still digests to ${established}`
      : `the host digested to ${established} when its capability was established and digests to ${observed} now`
  );
};

/** Is the instance on the network this Sandbox owns, and on no other? */
const networkOutcome = (input: AttestationInput): RequirementOutcome => {
  const { networkMode } = input.instance;
  return outcome(
    "own-network-namespace",
    networkMode === input.network && !isSharedNamespace(networkMode),
    `the instance is on ${networkMode === "" ? "an unnamed network" : networkMode} and this Sandbox owns ${input.network}`
  );
};

/** Does it have a PID namespace of its own? */
const pidOutcome = (instance: InstanceReport): RequirementOutcome =>
  outcome(
    "own-pid-namespace",
    PRIVATE_PID_MODES.has(instance.pidMode),
    `the instance's PID namespace is ${instance.pidMode === "" ? "its own" : instance.pidMode}`
  );

/** One mount reduced to the two facts that decide whether it was asked for. */
const mountKey = (mount: ObservedMount): string =>
  `${mount.kind} at ${mount.destination}`;

/**
 * Does its mount tree hold only the storage this Sandbox asked for?
 *
 * An allowlist, not a search for bind mounts. "No mount of kind `bind`" is a
 * blocklist over one field, and three things get past it: a host path reached
 * through the local volume driver, which inspects as a *volume*; a mount kind
 * neither runtime had when this was written; and an anonymous volume from the
 * image's own `VOLUME` directive, which is writable, executable storage inside
 * an instance whose read-only root was meant to prevent exactly that.
 *
 * So the resolved set has to be exactly the requested one: the Workspace
 * volume, and a tmpfs at each ephemeral mount. An image with a `VOLUME`
 * directive is refused by name rather than launched with storage nobody asked
 * for. The read-only root is checked here too, because the two facts together
 * are the claim - the only writable places inside are the ones that were
 * requested.
 */
const mountOutcome = (input: AttestationInput): RequirementOutcome => {
  const expected = new Set([
    mountKey({
      kind: "volume",
      source: input.workspaceVolume,
      destination: input.request.workspace.path,
    }),
    ...input.request.mounts
      .filter((mount) => mount.kind === "ephemeral")
      .map((mount) =>
        mountKey({ kind: "tmpfs", source: "", destination: mount.path })
      ),
  ]);
  const unasked = input.instance.mounts.filter(
    (mount) => !expected.has(mountKey(mount))
  );
  const satisfied =
    unasked.length === 0 && input.instance.readOnlyRootFilesystem;

  return outcome(
    "own-mount-namespace",
    satisfied,
    satisfied
      ? "the instance holds a read-only root and no storage beyond the Workspace and the ephemeral mounts that were asked for"
      : `the instance's root filesystem is ${input.instance.readOnlyRootFilesystem ? "read-only" : "writable"} and it holds storage nobody asked for: ${listed(unasked.map((mount) => `${mount.kind} ${mount.source === "" ? mount.destination : `${mount.source} at ${mount.destination}`}`))}`
  );
};

/** Is it privileged, and did anything add a capability back? */
const privilegeOutcomes = (
  instance: InstanceReport
): readonly RequirementOutcome[] => [
  outcome(
    "not-privileged",
    !instance.privileged &&
      instance.securityOptions.includes("no-new-privileges"),
    instance.privileged
      ? "the instance is privileged, which is every capability and no device restriction"
      : `the instance is not privileged and ${instance.securityOptions.includes("no-new-privileges") ? "cannot regain a privilege it dropped" : "can regain a dropped privilege through a setuid binary, because no-new-privileges was not applied"}`
  ),
  outcome(
    "no-added-capabilities",
    instance.addedCapabilities.length === 0 &&
      instance.droppedCapabilities.includes("ALL"),
    `the instance added ${listed(instance.addedCapabilities)} and dropped ${listed(instance.droppedCapabilities)}`
  ),
];

/**
 * Can anything inside reach the container runtime or the host's filesystem?
 *
 * The socket check reads both lists, and the bind check reads the requested one:
 * `Binds` records a named volume as `name:/destination`, so an absolute source
 * there is a host path and nothing else is.
 */
const reachOutcomes = (
  instance: InstanceReport
): readonly RequirementOutcome[] => {
  const sources = instance.binds.map(bindSource);
  const hostBinds = sources.filter(isHostPath);
  const sockets = [
    ...sources.filter(isRuntimeSocket),
    ...instance.mounts
      .map((mount) => mount.destination)
      .filter(isRuntimeSocket),
  ];

  return [
    outcome(
      "no-runtime-socket",
      sockets.length === 0,
      sockets.length === 0
        ? "no container-runtime socket is reachable from inside"
        : `a container-runtime socket is reachable from inside: ${listed(sockets)}`
    ),
    outcome(
      "no-host-bind-mount",
      hostBinds.length === 0,
      hostBinds.length === 0
        ? "every mount the instance was given is sandbox-owned"
        : `host paths were mounted into the instance: ${listed(hostBinds)}`
    ),
  ];
};

/**
 * Is seccomp applied?
 *
 * Three facts, because no one of them is sufficient: the instance did not opt
 * out, a profile of its own is applied when one was asked for by name, and the
 * daemon still applies a profile at all - which the instance cannot see and
 * only the host capability knows.
 *
 * The named case is checked by presence rather than by path, because the two
 * runtimes report different things for the same request. Docker's *client*
 * reads the file and inlines the compacted JSON, so `SecurityOpt` holds
 * `seccomp={"defaultAction":...}` and never the path - measured against Docker
 * 29.1.3. Podman keeps the path. Comparing against the path would refuse every
 * named-profile launch on Docker, and comparing against the JSON would need
 * this package to read the file, which is a host filesystem it has no other
 * reason to touch. What the profile *says* is therefore the caller's
 * responsibility: an allow-everything profile is a profile.
 */
const seccompOutcome = (input: AttestationInput): RequirementOutcome => {
  const applied = seccompOption(input.instance.securityOptions);
  const byName = input.request.seccomp.kind === "file";

  return outcome(
    "seccomp-enabled",
    applied !== "seccomp=unconfined" &&
      (!byName || applied !== undefined) &&
      hostSaid(input.host, "seccomp-enabled"),
    `the instance runs under ${applied === undefined ? "the runtime's own profile" : applied.slice(0, 64)}, and ${byName ? "a profile was asked for by name" : "no profile was asked for by name"}`
  );
};

/** Are the three limits the ones that were asked for, and are they real? */
const limitOutcomes = (
  input: AttestationInput
): readonly RequirementOutcome[] => {
  const { instance } = input;
  const { cpus, memoryBytes, processes } = input.request.limits;
  const cpuQuotaNanos = Math.round(cpus * 1_000_000_000);

  return [
    outcome(
      "cpu-limit",
      instance.cpuQuotaNanos === cpuQuotaNanos && cpuQuotaNanos > 0,
      `the instance holds a CPU quota of ${instance.cpuQuotaNanos}ns against the ${cpuQuotaNanos}ns that was asked for`
    ),
    outcome(
      "memory-limit",
      instance.memoryBytes === memoryBytes && instance.memoryBytes > 0,
      `the instance holds a memory limit of ${instance.memoryBytes} bytes against the ${memoryBytes} that was asked for`
    ),
    outcome(
      "process-limit",
      instance.processLimit === processes && instance.processLimit > 0,
      `the instance holds a process limit of ${instance.processLimit} against the ${processes} that was asked for`
    ),
  ];
};

/** Is the Workspace the sandbox-owned volume this provider created for it? */
const workspaceOutcome = (input: AttestationInput): RequirementOutcome => {
  const { path } = input.request.workspace;
  const mounted = input.instance.mounts.filter(
    (mount) => mount.kind === "volume" && mount.destination === path
  );
  const satisfied =
    mounted.length === 1 && mounted[0]?.source === input.workspaceVolume;

  return outcome(
    "ephemeral-workspace",
    satisfied,
    satisfied
      ? `the Workspace is the sandbox-owned volume ${input.workspaceVolume} at ${path}`
      : `the Workspace at ${path} is ${listed(mounted.map((mount) => mount.source))} rather than the sandbox-owned volume ${input.workspaceVolume}`
  );
};

/**
 * Proves the instance that was actually created holds every hard requirement.
 *
 * Pure, and public: it is what a Worker's structured isolation report is built
 * from, and a consumer that did not launch an instance can re-attest one by
 * stating what it expected the instance to hold.
 *
 * @param input The instance, the request it came from, the capability it was
 *   authorized against, and the facts the provider owns about it.
 * @returns Every outcome an instance report can decide, and whether they all
 *   hold.
 */
export const attestInstance = (input: AttestationInput): Attestation => {
  const outcomes: readonly RequirementOutcome[] = [
    fingerprintOutcome(input.fingerprint, input.host.fingerprint),
    networkOutcome(input),
    pidOutcome(input.instance),
    mountOutcome(input),
    ...privilegeOutcomes(input.instance),
    ...reachOutcomes(input.instance),
    seccompOutcome(input),
    ...limitOutcomes(input),
    workspaceOutcome(input),
  ];

  return {
    authorized: allSatisfied(outcomes),
    isolation: input.host.isolation,
    outcomes,
  };
};
