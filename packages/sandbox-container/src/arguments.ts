/**
 * The argument vector, and the audit of it.
 *
 * Everything ADR 0004 asks for that a container runtime can be told is told to
 * it here, so this is the one module where getting a string wrong is a hole in
 * the boundary. Which is why the vector is audited *after* it is rendered and
 * *before* it is invoked: the renderer and the audit are written from the two
 * ends of the same requirement, and the audit refuses a vector the renderer
 * should never have produced rather than trusting that it did not.
 *
 * The image and the command are kept out of the audited region on purpose. Both
 * runtimes stop parsing flags at the first positional argument, so a command
 * whose own arguments include `--privileged` is text rather than a request -
 * and auditing it would refuse a correct launch for a word inside somebody's
 * shell script.
 *
 * That is only true once the flag region is *terminated*, which is why
 * `createArguments` renders `--` before the image. Without it the image is the
 * first token the flag parser reads, so an image of `--privileged` and a
 * command of `["alpine:3.20", "sh", ...]` produces a privileged instance from a
 * request that never mentions one - measured against Docker 29.1.3, not
 * reasoned about. The Attestation refuses that instance and removes it before
 * it starts, so the boundary held either way; the separator is what stops the
 * instance being created at all.
 */
import type { SandboxRequest } from "./request.js";
import {
  isRuntimeSocket,
  isSharedNamespace,
  listed,
  outcome,
} from "./requirements.js";
import type { RequirementOutcome } from "./requirements.js";

/** The names the provider generated for the resources this Sandbox owns. */
export interface LaunchNames {
  readonly instance: string;
  readonly workspaceVolume: string;
}

/**
 * The rendered launch, with the flag region kept apart from the image and the
 * command so the audit can read one without the other.
 */
export interface RenderedCreate {
  readonly options: readonly string[];
  readonly image: string;
  readonly command: readonly string[];
}

/**
 * What every resource a launch creates is labelled with, so an abandoned one
 * can be found.
 *
 * Both the instance and the Workspace volume carry it. A label on the instance
 * alone sweeps up only the resource that is easiest to notice: a volume
 * outlives the instance that used it, and an operator reaping by label would
 * leave behind exactly the thing nothing else names.
 */
export const SANDBOX_LABEL = "io.reprove.sandbox=1";

/**
 * The tmpfs options every ephemeral mount gets. `noexec` and `nosuid` are not
 * negotiable and are not derived from the request: a writable scratch mount a
 * Reviewer can drop a binary on and run is a boundary with a hole in it.
 */
const TMPFS_OPTIONS = "rw,nosuid,nodev,noexec";

/**
 * The only network a Sandbox is ever put on.
 *
 * `EgressPolicy` has one member, so this is rendered unconditionally rather
 * than derived from the request. When the proxy that terminates a Sandbox-owned
 * network exists, this becomes a name the provider generates - and the audit
 * below, which refuses `host`, `container:` and `ns:` whatever the renderer
 * produced, is written against that day rather than against this one.
 */
export const NO_NETWORK = "none";

const tmpfsArgument = (path: string, sizeBytes: number | undefined): string =>
  sizeBytes === undefined
    ? `${path}:${TMPFS_OPTIONS}`
    : `${path}:${TMPFS_OPTIONS},size=${sizeBytes}`;

/**
 * Renders one launch.
 *
 * A host mount is never rendered. It is refused by `checkRequest` before
 * anything reaches here, and dropping it silently would be the narrowing ADR
 * 0004 forbids - so this function is reached only for a request that asked for
 * none.
 *
 * @param request The Sandbox as it was asked for.
 * @param names The resources the provider generated for it.
 * @returns The flag region, the image and the command, apart.
 */
export const renderCreate = (
  request: SandboxRequest,
  names: LaunchNames
): RenderedCreate => {
  const seccomp: readonly string[] =
    request.seccomp.kind === "file"
      ? ["--security-opt", `seccomp=${request.seccomp.path}`]
      : [];
  const ephemeral = request.mounts
    .filter((mount) => mount.kind === "ephemeral")
    .flatMap((mount) => [
      "--tmpfs",
      tmpfsArgument(mount.path, mount.sizeBytes),
    ]);
  const environment = request.environment.flatMap((entry) => [
    "--env",
    `${entry.name}=${entry.value}`,
  ]);

  return {
    options: [
      "--name",
      names.instance,
      "--label",
      SANDBOX_LABEL,
      "--network",
      NO_NETWORK,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...seccomp,
      "--pids-limit",
      String(request.limits.processes),
      "--memory",
      String(request.limits.memoryBytes),
      "--cpus",
      String(request.limits.cpus),
      "--read-only",
      "--volume",
      `${names.workspaceVolume}:${request.workspace.path}`,
      ...ephemeral,
      ...environment,
    ],
    image: request.image,
    command: request.command,
  };
};

/**
 * The whole vector, ready for the runtime.
 *
 * `--` terminates the flag region. Everything after it is positional to both
 * runtimes' argument parsers, so no request field can reach one of them as a
 * flag - the same reason `createCliRuntime` uses `execFile` rather than a
 * shell, one parser further in.
 */
export const createArguments = (
  rendered: RenderedCreate
): readonly string[] => [
  "create",
  ...rendered.options,
  "--",
  rendered.image,
  ...rendered.command,
];

/** The flags that carry an environment entry, in both runtimes' spellings. */
const ENVIRONMENT_FLAGS: ReadonlySet<string> = new Set(["--env", "-e"]);

const REDACTED = "<redacted>";

/** `NAME=value` with the value taken out, and `NAME` kept. */
const redactEntry = (entry: string): string => {
  const split = entry.indexOf("=");
  return `${split === -1 ? entry : entry.slice(0, split)}=${REDACTED}`;
};

/**
 * The argument vector as an error may print it.
 *
 * A failed invocation names the vector it failed on, because "which command"
 * and "which subcommand" are most of what makes the message actionable - but
 * the vector carries every `--env NAME=value` the request asked for, and an
 * error message travels into logs the Sandbox's own contents never reach. The
 * name is what makes the message useful and the value is what makes it a leak,
 * so the name stays and the value goes. Redacted where it is *printed*, not
 * where it is sent: the instance still receives what was asked for.
 */
export const redactedArguments = (argv: readonly string[]): readonly string[] =>
  argv.map((token, index) => {
    const previous = argv[index - 1];
    if (previous !== undefined && ENVIRONMENT_FLAGS.has(previous)) {
      return redactEntry(token);
    }
    const split = token.indexOf("=");
    return split > 0 && ENVIRONMENT_FLAGS.has(token.slice(0, split))
      ? `${token.slice(0, split)}=${redactEntry(token.slice(split + 1))}`
      : token;
  });

/** One flag and the value that followed it, whichever way it was spelled. */
interface FlagPair {
  readonly flag: string;
  readonly value: string | undefined;
}

/**
 * Reads the flag region as flag-and-value pairs.
 *
 * Both `--flag value` and `--flag=value` are understood even though the
 * renderer only ever produces the first: an audit that only understands the
 * spelling its own renderer uses audits the renderer rather than the vector.
 */
const flagPairs = (options: readonly string[]): readonly FlagPair[] => {
  const pairs: FlagPair[] = [];
  for (const [index, token] of options.entries()) {
    if (!token.startsWith("-")) {
      continue;
    }
    const split = token.indexOf("=");
    if (split > 0) {
      pairs.push({
        flag: token.slice(0, split),
        value: token.slice(split + 1),
      });
      continue;
    }
    const next = options[index + 1];
    pairs.push({
      flag: token,
      value: next === undefined || next.startsWith("-") ? undefined : next,
    });
  }
  return pairs;
};

const valuesOf = (
  pairs: readonly FlagPair[],
  ...flags: readonly string[]
): readonly string[] =>
  pairs
    .filter((pair) => flags.includes(pair.flag))
    .map((pair) => pair.value ?? "");

const has = (
  pairs: readonly FlagPair[],
  ...flags: readonly string[]
): boolean => pairs.some((pair) => flags.includes(pair.flag));

/** Every flag that can hand this Sandbox a namespace it does not own. */
const NAMESPACE_FLAGS = ["--pid", "--ipc", "--userns", "--uts", "--cgroupns"];

const positive = (values: readonly string[]): boolean =>
  values.length === 1 && Number(values[0]) > 0;

/**
 * The source of a `--volume` value, which is everything before the first colon.
 *
 * A value with no colon at all is an anonymous volume, and the whole of it is
 * the source - so the missing separator is handled rather than sliced off the
 * end of the string, which would turn `/data` into `/dat`.
 */
const bindSource = (value: string): string => {
  const split = value.indexOf(":");
  return split === -1 ? value : value.slice(0, split);
};

/**
 * Whether a bind source is a host path rather than a sandbox-owned volume.
 *
 * "Starts with a slash" is a spelling test rather than a boundary: both
 * runtimes read `./secrets`, `../secrets`, `.` and `~/.ssh` as paths too, and
 * resolve a relative one against a working directory this package does not
 * choose. A volume *name* may not begin with any of these, so the test is which
 * of the two a source could possibly be.
 */
const HOST_SOURCE = /^[/.~]/u;

/**
 * Everything inside one argument that could be a path.
 *
 * A socket reaches the boundary through whichever field a runtime happens to
 * read it from: `--volume src:dst`, `--mount source=...,target=...`, or the
 * bare path itself. Splitting on every separator either syntax uses reads all
 * of them, which is why the check is not "does the destination end in
 * `docker.sock`" - the destination is whatever name the person who wanted the
 * socket chose to give it inside.
 */
const PATH_SEPARATORS = /[:,=]/u;

/**
 * Refuses an argument vector that would widen the boundary, before it is
 * invoked.
 *
 * @param rendered The rendered launch. Only its flag region is read.
 * @returns One outcome per requirement an argument vector can decide.
 */
export const auditArguments = (
  rendered: RenderedCreate
): readonly RequirementOutcome[] => {
  const pairs = flagPairs(rendered.options);
  const networks = valuesOf(pairs, "--network", "--net");
  // `--pid` at all, whatever it says: this package renders no PID mode, so the
  // only vector carrying one is a vector nothing here produced.
  const shared = NAMESPACE_FLAGS.filter(
    (flag) =>
      valuesOf(pairs, flag).some(isSharedNamespace) ||
      (flag === "--pid" && has(pairs, flag))
  );
  const hostBinds = valuesOf(pairs, "--volume", "-v")
    .map(bindSource)
    .filter((source) => HOST_SOURCE.test(source));
  const foreignMounts = valuesOf(pairs, "--mount").filter((value) =>
    value.includes("type=bind")
  );
  const sockets = [
    ...new Set(
      rendered.options
        .flatMap((token) => token.split(PATH_SEPARATORS))
        .filter(isRuntimeSocket)
    ),
  ];
  const cpus = valuesOf(pairs, "--cpus");
  const memory = valuesOf(pairs, "--memory");
  const processes = valuesOf(pairs, "--pids-limit");

  return [
    outcome(
      "not-privileged",
      !has(pairs, "--privileged"),
      "the vector does not ask for a privileged instance"
    ),
    outcome(
      "no-added-capabilities",
      !has(pairs, "--cap-add") && valuesOf(pairs, "--cap-drop").includes("ALL"),
      `the vector adds ${listed(valuesOf(pairs, "--cap-add"))} and drops ${listed(valuesOf(pairs, "--cap-drop"))}`
    ),
    outcome(
      "seccomp-enabled",
      !valuesOf(pairs, "--security-opt").includes("seccomp=unconfined"),
      `the vector's security options are ${listed(valuesOf(pairs, "--security-opt"))}`
    ),
    outcome(
      "own-network-namespace",
      networks.length === 1 && !isSharedNamespace(networks[0] ?? ""),
      `the vector asks for ${listed(networks)}`
    ),
    outcome(
      "own-pid-namespace",
      shared.length === 0,
      shared.length === 0
        ? "the vector asks for no namespace of anybody else's"
        : `the vector joins a namespace of somebody else's through ${listed(shared)}`
    ),
    outcome(
      "no-host-bind-mount",
      hostBinds.length === 0 &&
        foreignMounts.length === 0 &&
        !has(pairs, "--device", "--volumes-from"),
      hostBinds.length === 0 && foreignMounts.length === 0
        ? "every mount in the vector is a sandbox-owned volume"
        : `the vector mounts ${listed([...hostBinds, ...foreignMounts])}`
    ),
    outcome(
      "no-runtime-socket",
      sockets.length === 0,
      sockets.length === 0
        ? "no argument names a container-runtime socket"
        : `arguments naming a container-runtime socket: ${listed(sockets)}`
    ),
    outcome(
      "cpu-limit",
      positive(cpus),
      `the vector's CPU limit is ${listed(cpus)}`
    ),
    outcome(
      "memory-limit",
      positive(memory),
      `the vector's memory limit is ${listed(memory)}`
    ),
    outcome(
      "process-limit",
      positive(processes),
      `the vector's process limit is ${listed(processes)}`
    ),
  ];
};
