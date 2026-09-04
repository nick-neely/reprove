/**
 * `@reprove/sandbox-container`: a container Sandbox defined by its properties
 * rather than by a technology, usable by someone who has never heard of
 * Reprove.
 *
 * It depends on nothing of Reprove's and on nothing outside Node's own
 * builtins, because it is offered as an independent security primitive and that
 * claim is only true if the dependency graph says so (ADR 0010).
 *
 * The surface is deliberately small. What is not here is as deliberate as what
 * is: the argument renderer and its audit are internal, because a consumer that
 * renders its own vector is not using this boundary, and the provider's
 * pipeline is the only supported path from a request to a running Sandbox.
 */
export const packageName = "@reprove/sandbox-container" as const;

export { SANDBOX_LABEL } from "./arguments.js";
export { attestInstance } from "./attestation.js";
export type {
  Attestation,
  AttestationInput,
  InstanceReport,
  ObservedMount,
} from "./attestation.js";
export {
  BROKERED_PLACEHOLDER,
  DENIED_ENVIRONMENT_NAMES,
  isBrokeredPlaceholder,
  isCredentialName,
  isDeniedEnvironmentName,
} from "./broker.js";
export {
  checkHost,
  createCapabilityCache,
  fingerprintHost,
  hostIsolation,
} from "./capability.js";
export type {
  CapabilityCache,
  HostCapability,
  HostFingerprint,
  HostReport,
} from "./capability.js";
export { createCliRuntime } from "./cli-runtime.js";
export type { CliRuntimeOptions } from "./cli-runtime.js";
export { DOCKER_DIALECT, PODMAN_DIALECT } from "./dialect.js";
export type { RuntimeDialect } from "./dialect.js";
export {
  createDockerProvider,
  createPodmanProvider,
  createSandboxProvider,
} from "./provider.js";
export type {
  ExecOutcome,
  RuntimeProviderOptions,
  Sandbox,
  SandboxProvider,
  SandboxProviderOptions,
  TeardownReceipt,
  WorkspaceHandle,
} from "./provider.js";
export { SandboxRefusalError } from "./refusal.js";
export type {
  EgressPolicy,
  EnvironmentEntry,
  Isolation,
  MountRequest,
  ResourceLimits,
  RuntimeName,
  SandboxRequest,
  SeccompProfile,
  WorkspaceRequest,
} from "./request.js";
export { checkRequest, HARD_REQUIREMENTS } from "./requirements.js";
export type { RequirementName, RequirementOutcome } from "./requirements.js";
export { SandboxTeardownError } from "./residue.js";
export type { Residue } from "./residue.js";
export type {
  ContainerRuntime,
  RuntimeInvocation,
  RuntimeOutcome,
} from "./runtime.js";
export { RuntimeUnavailableError } from "./runtime-unavailable.js";
