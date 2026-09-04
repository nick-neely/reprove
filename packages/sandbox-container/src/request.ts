/**
 * What a caller asks for when it asks for a Sandbox.
 *
 * The shape is the first layer of the boundary. [ADR
 * 0004](../../../docs/adr/0004-sandbox-boundary-and-credential-isolation.md)
 * makes seccomp, resource limits and ephemeral storage hard requirements rather
 * than strength signals, so nothing here is optional and nothing here has a
 * default: a field a caller forgot is a field a reviewer cannot see, and a
 * default is a security decision made by whoever wrote it rather than by
 * whoever is running the Run.
 *
 * Where a dangerous request cannot be expressed at all it is left out of the
 * type - there is no `privileged` member and no credential member. Where it can
 * be expressed it is left *in* on purpose, so it can be refused by name: a
 * standalone security primitive is handed requests by callers who have never
 * read ADR 0004, and an unrepresentable request produces no Refusal anyone can
 * read.
 */

/**
 * Which container runtime a provider drives.
 *
 * The only technology word on this surface, and it is here because naming rule
 * 4 puts a foreign name at the seam rather than in the domain: everything else
 * this package exposes is stated as a Sandbox property.
 */
export type RuntimeName = "docker" | "podman";

/**
 * `CONTEXT.md`'s Isolation ladder, narrowed to what a container runtime can
 * supply. `microvm` is absent because this package cannot produce one, and
 * below `container` there is no Sandbox at all.
 */
export type Isolation = "container-rootless" | "container";

/**
 * Seccomp as ADR 0004 requires it: enabled, never `unconfined`. There is no
 * third member, so `unconfined` is not a value a caller can ask for.
 *
 * `runtime-default` is the runtime's own built-in profile, which is what an
 * instance gets when no `--security-opt seccomp=` is rendered at all. That it
 * is genuinely enabled is not inferred from the absence of a flag: the host
 * report says whether the daemon still applies a profile, and the per-instance
 * Attestation says the instance did not opt out of it.
 */
export type SeccompProfile =
  | { readonly kind: "runtime-default" }
  | { readonly kind: "file"; readonly path: string };

/**
 * ADR 0004's three limits. A Sandbox that can fork-bomb the Worker or exhaust
 * its memory is attacking the boundary rather than the Run, which is why none
 * of these is a strength signal and none of them has a default.
 */
export interface ResourceLimits {
  /** Fractional CPUs, as `--cpus` takes them. Must be greater than zero. */
  readonly cpus: number;
  /** Must be greater than zero. */
  readonly memoryBytes: number;
  /** The process count, as `--pids-limit` takes it. Greater than zero. */
  readonly processes: number;
}

/**
 * How far a Sandbox may reach. `none` is the floor and the safe posture;
 * `proxy` reaches exactly one Reprove-owned endpoint over a Sandbox-owned
 * network the provider creates and destroys.
 *
 * There is no `host` member and no "allow these domains" member. ADR 0004 says
 * egress goes through Reprove's proxy or nowhere, and a per-request domain list
 * would be a policy this package has no way to enforce.
 */
export type EgressPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "proxy"; readonly endpoint: string };

/**
 * A mount a caller may ask for, beside the Workspace.
 *
 * `host` is representable precisely so it can be refused by name rather than by
 * silence. `ephemeral` is runtime-owned scratch: it exists for the writable
 * space a Harness needs under a read-only root filesystem.
 */
export type MountRequest =
  | {
      readonly kind: "ephemeral";
      readonly path: string;
      readonly sizeBytes?: number;
    }
  | { readonly kind: "host"; readonly hostPath: string; readonly path: string };

/**
 * One entry of the Sandbox's default environment.
 *
 * This layer exists because instruction suppression - `CLAUDE_CODE_SAFE_MODE`,
 * `OPENCODE_DISABLE_PROJECT_CONFIG` and their siblings - is a
 * Sandbox-provisioning concern: a per-command environment is merged *over* the
 * Sandbox's own, so a suppression flag set per command can be shadowed and one
 * set here cannot.
 */
export interface EnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * The Workspace: the repository checkout inside a Sandbox.
 *
 * There is no host-directory member. `CONTEXT.md` says a Workspace is
 * self-contained and sandbox-owned, and ADR 0004 requires sandbox-owned
 * ephemeral storage rather than a writable host directory, so the provider
 * creates storage of its own and destroys it at teardown.
 */
export interface WorkspaceRequest {
  /** Where it is mounted inside the Sandbox. An absolute path. */
  readonly path: string;
  readonly sizeBytes: number;
}

/** One Sandbox, stated whole. */
export interface SandboxRequest {
  readonly image: string;
  readonly command: readonly string[];
  readonly workspace: WorkspaceRequest;
  readonly limits: ResourceLimits;
  readonly seccomp: SeccompProfile;
  readonly egress: EgressPolicy;
  readonly environment: readonly EnvironmentEntry[];
  readonly mounts: readonly MountRequest[];
}
