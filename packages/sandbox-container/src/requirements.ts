/**
 * ADR 0004's hard requirements, as names a Refusal can print, and the layer of
 * them that can be decided from a request alone.
 *
 * The names are stable and the list is closed. A Worker's structured isolation
 * report is built from these, so the control plane can explain a refusal rather
 * than merely issue one - which is the whole reason registration carries a
 * report rather than a boolean.
 */
import {
  BROKERED_PLACEHOLDER,
  isBrokeredPlaceholder,
  isCredentialName,
  isDeniedEnvironmentName,
  isEnvironmentName,
} from "./broker.js";
import type { SandboxRequest } from "./request.js";

/**
 * The stable name of every hard requirement, in ADR 0004's own order.
 *
 * Every one is a hard requirement rather than a strength signal: a missing one
 * is a Refusal, never a narrowing and never a log line.
 */
export type RequirementName =
  | "own-network-namespace"
  | "own-pid-namespace"
  | "own-mount-namespace"
  | "not-privileged"
  | "no-added-capabilities"
  | "no-runtime-socket"
  | "no-host-bind-mount"
  | "seccomp-enabled"
  | "cpu-limit"
  | "memory-limit"
  | "process-limit"
  | "ephemeral-workspace"
  | "no-credential-in-brokered-sandbox"
  | "host-fingerprint-unchanged"
  | "local-capability-not-quarantined"
  | "teardown-leaves-no-residue";

/**
 * One requirement's outcome. `detail` is what a Refusal prints, so it names the
 * value that failed rather than restating the rule.
 *
 * Not `*Result`: `CONTEXT.md` gives **Result** to what a Worker submits for a
 * Run, and a second unrelated meaning for the same noun is exactly the drift
 * the glossary exists to stop.
 */
export interface RequirementOutcome {
  readonly name: RequirementName;
  readonly satisfied: boolean;
  readonly detail: string;
}

/** Every hard requirement. Nothing here is a default and nothing is optional. */
export const HARD_REQUIREMENTS: readonly RequirementName[] = [
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
  "no-credential-in-brokered-sandbox",
  "host-fingerprint-unchanged",
  "local-capability-not-quarantined",
  "teardown-leaves-no-residue",
];

/**
 * One outcome, stated as a condition and the detail that explains it either
 * way. Both branches carry a detail, because an outcome nobody can read is
 * useless in an isolation report even when it passed.
 */
export const outcome = (
  name: RequirementName,
  satisfied: boolean,
  detail: string
): RequirementOutcome => ({ name, satisfied, detail });

/** Whether every outcome in a set holds. */
export const allSatisfied = (
  outcomes: readonly RequirementOutcome[]
): boolean => outcomes.every((each) => each.satisfied);

/** The names that failed, which is what a Refusal message is built from. */
export const failedNames = (
  outcomes: readonly RequirementOutcome[]
): readonly RequirementName[] =>
  outcomes.filter((each) => !each.satisfied).map((each) => each.name);

/**
 * Whether a path names a container-runtime socket, recognised by its file name.
 *
 * By name rather than by directory, because there is no canonical directory: a
 * rootless Podman keeps its socket under `/run/user/<uid>`, Docker Desktop puts
 * one in the user's home, and a remote daemon can be bound anywhere at all.
 */
const RUNTIME_SOCKET_NAMES: ReadonlySet<string> = new Set([
  "docker.sock",
  "podman.sock",
  "containerd.sock",
  "crio.sock",
]);

const TRAILING_SLASHES = /\/+$/u;

export const isRuntimeSocket = (hostPath: string): boolean => {
  // Trailing slashes first. Every runtime path-cleans `/var/run/docker.sock/`
  // back to the socket, so a check that reads the last segment of the raw
  // string reads an empty one.
  const cleaned = hostPath.replace(TRAILING_SLASHES, "");
  return RUNTIME_SOCKET_NAMES.has(cleaned.slice(cleaned.lastIndexOf("/") + 1));
};

/** A positive, finite quantity. Zero is "no limit" to every runtime here. */
const isPositive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const listed = (values: readonly string[]): string => values.join(", ");

/**
 * Refuses a request before anything reaches a container runtime.
 *
 * Pure, and deliberately the cheapest layer: everything decidable from the
 * request alone is decided here, so the expensive layers never run for a
 * request that was never going to be allowed. It returns an outcome for every
 * requirement it decides, satisfied or not, because a check that quietly
 * stopped producing an outcome would read as a pass to every caller that
 * filters for failures.
 *
 * @param request The Sandbox as it was asked for.
 * @returns One outcome per requirement this layer can decide.
 */
export const checkRequest = (
  request: SandboxRequest
): readonly RequirementOutcome[] => {
  const hostMounts = request.mounts.filter((mount) => mount.kind === "host");
  const sockets = hostMounts
    .map((mount) => mount.hostPath)
    .filter(isRuntimeSocket);
  const denied = request.environment
    .map((entry) => entry.name)
    .filter(isDeniedEnvironmentName);
  const malformed = request.environment
    .map((entry) => entry.name)
    .filter((name) => !isEnvironmentName(name));
  const leaked = request.environment
    .filter(
      (entry) =>
        isCredentialName(entry.name) && !isBrokeredPlaceholder(entry.value)
    )
    .map((entry) => entry.name);
  const smuggled = [...new Set([...malformed, ...leaked])];
  const { cpus, memoryBytes, processes } = request.limits;
  const { path, sizeBytes } = request.workspace;
  const relative = request.mounts
    .filter(
      (mount) => mount.kind === "ephemeral" && !mount.path.startsWith("/")
    )
    .map((mount) => mount.path);

  return [
    outcome(
      "no-host-bind-mount",
      hostMounts.length === 0,
      hostMounts.length === 0
        ? "no host path is mounted"
        : `a host path is mounted: ${listed(hostMounts.map((mount) => `${mount.hostPath} at ${mount.path}`))}`
    ),
    outcome(
      "no-runtime-socket",
      sockets.length === 0 && denied.length === 0,
      sockets.length === 0 && denied.length === 0
        ? "nothing in the request reaches the container runtime"
        : [
            sockets.length > 0
              ? `a container-runtime socket is mounted: ${listed(sockets)}`
              : "",
            denied.length > 0
              ? `the environment redefines the boundary: ${listed(denied)}`
              : "",
          ]
            .filter((part) => part !== "")
            .join("; ")
    ),
    outcome(
      "seccomp-enabled",
      request.seccomp.kind === "runtime-default" || request.seccomp.path !== "",
      request.seccomp.kind === "runtime-default"
        ? "the runtime's own profile applies"
        : `the profile file is ${request.seccomp.path === "" ? "unnamed, which would render no profile at all" : request.seccomp.path}`
    ),
    outcome(
      "cpu-limit",
      isPositive(cpus),
      `limits.cpus is ${cpus}, and a CPU limit must be a positive finite number`
    ),
    outcome(
      "memory-limit",
      isPositive(memoryBytes),
      `limits.memoryBytes is ${memoryBytes}, and a memory limit must be a positive finite number`
    ),
    outcome(
      "process-limit",
      isPositive(processes),
      `limits.processes is ${processes}, and a process limit must be a positive finite number`
    ),
    outcome(
      "ephemeral-workspace",
      path.startsWith("/") && isPositive(sizeBytes) && relative.length === 0,
      relative.length === 0
        ? `the Workspace is ${sizeBytes} bytes at ${path === "" ? "no path" : path}, and it must be a positive size at an absolute path inside the Sandbox`
        : `every ephemeral mount must be at an absolute path inside the Sandbox, and these are not: ${listed(relative)}`
    ),
    outcome(
      "no-credential-in-brokered-sandbox",
      smuggled.length === 0,
      smuggled.length === 0
        ? `no environment entry is credential-shaped without holding ${BROKERED_PLACEHOLDER}`
        : [
            leaked.length > 0
              ? `credential-shaped and not brokered: ${listed(leaked)}`
              : "",
            malformed.length > 0
              ? `not an environment variable name, so every guard on it reads a name the runtime will not use: ${listed(malformed.map((name) => (name === "" ? "the empty name" : name)))}`
              : "",
          ]
            .filter((part) => part !== "")
            .join("; ")
    ),
  ];
};
