/**
 * The Sandbox Worker core asks for, stated whole.
 *
 * `@reprove/sandbox-container` deliberately gives no field a default: a field a
 * caller forgot is a field a reviewer cannot see, and a default is a security
 * decision made by whoever wrote it rather than by whoever is running the Run.
 * So the values live here, in one named profile, for the same reason ADR 0016
 * put `livenessFor` in `Phase0RunProfile` rather than inline in the claim path:
 * a Phase 0 fixture that lands in the middle of a code path silently becomes
 * product policy that a later phase inherits unexamined.
 *
 * The environment is the load-bearing part. ADR 0009 found that instruction
 * suppression is a **Sandbox-provisioning concern** rather than an Adapter one,
 * because a per-command environment merges *over* the Sandbox's own: a
 * suppression flag set per command can be shadowed by repository-controlled
 * configuration, and one set here cannot.
 */
import type { Harness } from "@reprove/protocol/v1";
import type {
  EnvironmentEntry,
  ResourceLimits,
  SandboxRequest,
} from "@reprove/sandbox-container";

/** Everything about a Sandbox that is a fixture rather than a decision. */
export interface SandboxProfile {
  readonly image: string;
  /** What holds the instance open while the Adapter execs the Harness into it. */
  readonly command: readonly string[];
  readonly workspacePath: string;
  readonly workspaceSizeBytes: number;
  readonly limits: ResourceLimits;
  /** Writable scratch, which a read-only root filesystem otherwise denies. */
  readonly scratchPath: string;
  readonly scratchSizeBytes: number;
}

export const PHASE0_SANDBOX_PROFILE: SandboxProfile = {
  image: "alpine:3.20",
  command: ["/bin/sh", "-c", "exec sleep infinity"],
  workspacePath: "/reprove/workspace",
  workspaceSizeBytes: 1024 * 1024 * 1024,
  limits: { cpus: 2, memoryBytes: 4 * 1024 * 1024 * 1024, processes: 512 },
  scratchPath: "/tmp",
  scratchSizeBytes: 256 * 1024 * 1024,
};

/**
 * ADR 0009's suppression levers, per Harness, as the Sandbox's own environment.
 *
 * Two details are measured rather than assumed. OpenCode needs **three**
 * variables: `OPENCODE_DISABLE_PROJECT_CONFIG` alone leaves repo-local
 * `.claude/skills/` and `.agents/skills/` fully loaded. And Codex has no
 * environment lever at all - its levers are the config keys
 * `project_doc_max_bytes=0` and `skills.include_instructions=false`, which the
 * Adapter owns and which ADR 0009 exempts from "unknown or raw configuration is
 * rejected, not forwarded". An empty list for Codex is therefore correct and
 * not an omission; what proves Codex's boundary is
 * `canEnforceRepoInstructionBoundary`, which is a hard dispatch gate.
 *
 * Suppression leaves the Workspace byte-identical to the pull request. Files
 * stay where the Author put them and the Reviewer can still read them as
 * ordinary files; what changes is that the Harness no longer ingests them as
 * configuration.
 */
export const suppressionEnvironment = (
  harness: Harness
): readonly EnvironmentEntry[] => {
  if (harness === "claude-code") {
    // `--safe-mode`, not `--bare`: `--bare` leaves `.mcp.json` discovery on,
    // and safe mode leaves authentication working normally.
    return [{ name: "CLAUDE_CODE_SAFE_MODE", value: "1" }];
  }
  if (harness === "opencode") {
    return [
      { name: "OPENCODE_DISABLE_PROJECT_CONFIG", value: "1" },
      { name: "OPENCODE_DISABLE_EXTERNAL_SKILLS", value: "1" },
      { name: "OPENCODE_DISABLE_SHARE", value: "1" },
    ];
  }
  return [];
};

/**
 * The request for one Pass's Sandbox.
 *
 * Nothing credential-shaped is constructible from here: the environment is
 * exactly the suppression set, and the Harness credential reaches the Sandbox
 * through the Route rather than through a request field this function could
 * populate. The provider refuses a credential-shaped entry by name anyway,
 * which is the point of a standalone primitive that assumes nothing about who
 * called it.
 *
 * @param harness The pinned Harness, which decides the suppression levers.
 * @param profile The fixture the Sandbox's shape comes from.
 * @returns One Sandbox, stated whole, for the provider to refuse or launch.
 */
export const sandboxRequestFor = (
  harness: Harness,
  profile: SandboxProfile
): SandboxRequest => ({
  image: profile.image,
  command: profile.command,
  workspace: {
    path: profile.workspacePath,
    sizeBytes: profile.workspaceSizeBytes,
  },
  limits: profile.limits,
  seccomp: { kind: "runtime-default" },
  // ADR 0004 allows egress only through Reprove's proxy, and the proxy is not
  // built. `none` is the whole of the type rather than a field that promises
  // brokered egress and delivers none.
  egress: { kind: "none" },
  environment: suppressionEnvironment(harness),
  mounts: [
    {
      kind: "ephemeral",
      path: profile.scratchPath,
      sizeBytes: profile.scratchSizeBytes,
    },
  ],
});
