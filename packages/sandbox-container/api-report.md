<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/sandbox-container

## dist/arguments.d.ts

```ts
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
import type { RequirementOutcome } from "./requirements.js";
/** The names the provider generated for the resources this Sandbox owns. */
export interface LaunchNames {
    readonly instance: string;
    readonly workspaceVolume: string;
    /** The Sandbox-owned network, or `none` when there is no egress at all. */
    readonly network: string;
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
 * The instance, the Workspace volume and the network all carry it. A label on
 * the instance alone sweeps up only the resource that is easiest to notice: a
 * volume and a network outlive the instance that used them, and an operator
 * reaping by label would leave behind exactly the two things nothing else names.
 */
export declare const SANDBOX_LABEL = "io.reprove.sandbox=1";
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
export declare const renderCreate: (request: SandboxRequest, names: LaunchNames) => RenderedCreate;
/**
 * The whole vector, ready for the runtime.
 *
 * `--` terminates the flag region. Everything after it is positional to both
 * runtimes' argument parsers, so no request field can reach one of them as a
 * flag - the same reason `createCliRuntime` uses `execFile` rather than a
 * shell, one parser further in.
 */
export declare const createArguments: (rendered: RenderedCreate) => readonly string[];
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
export declare const redactedArguments: (argv: readonly string[]) => readonly string[];
/**
 * Refuses an argument vector that would widen the boundary, before it is
 * invoked.
 *
 * @param rendered The rendered launch. Only its flag region is read.
 * @returns One outcome per requirement an argument vector can decide.
 */
export declare const auditArguments: (rendered: RenderedCreate) => readonly RequirementOutcome[];
```

## dist/attestation.d.ts

```ts
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
export declare const fingerprintOutcome: (observed: HostFingerprint, established: HostFingerprint) => RequirementOutcome;
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
export declare const attestInstance: (input: AttestationInput) => Attestation;
```

## dist/broker.d.ts

```ts
/**
 * How a real credential is kept out of a brokered Sandbox.
 *
 * On the Brokered Route the credential is substituted *outside* the boundary,
 * on the outbound request, after it has left the Sandbox. Inside there is only
 * a non-secret placeholder. `@ai-sdk/harness` will forward the real credential
 * into the sandboxed process environment when a provider declines to transform
 * the request, and the only thing it says about that is a `console.warn` - so
 * this package states the same posture as a Refusal instead, and states it on
 * the request rather than on the provider that happened to be wired up.
 *
 * There are four structural facts here, and none of them is a lint rule:
 *
 * 1. `SandboxRequest` has no credential member. There is nothing to pass one
 *    through.
 * 2. A credential-shaped environment *name* may hold the placeholder and
 *    nothing else.
 * 3. A denied environment name may hold nothing at all.
 * 4. A name has to be a name, because every guard above reads the name it was
 *    given and an entry renders as `name=value`.
 */
/**
 * What a brokered Sandbox holds where a credential would be.
 *
 * Deliberately not secret-shaped: it is not a redaction of a real value, and
 * anything that treats it as one is looking at the wrong layer. A Harness that
 * reads it and sends it upstream gets a rejection from the provider, which is
 * the loud failure this design wants.
 */
export declare const BROKERED_PLACEHOLDER = "reprove-brokered-placeholder";
/** Whether a value is exactly the placeholder, and therefore not a credential. */
export declare const isBrokeredPlaceholder: (value: string) => boolean;
/**
 * Whether a name reads as the place a credential goes.
 *
 * Case-insensitive, because `npm_password` and `NPM_PASSWORD` are the same
 * mistake.
 */
export declare const isCredentialName: (name: string) => boolean;
/**
 * Environment names a Sandbox may not carry at any value, including the
 * placeholder.
 *
 * ADR 0004 bans a container-runtime socket reachable from inside the Sandbox,
 * and an environment variable is the cheapest way to reach one: `DOCKER_HOST`
 * and `CONTAINER_HOST` name it outright, and `XDG_RUNTIME_DIR` names the
 * directory a rootless runtime keeps it in.
 *
 * The list is wider than a socket. `LD_PRELOAD` and `LD_LIBRARY_PATH` reach no
 * socket at all - they change what the code inside the boundary *is*, before it
 * runs - and `SSH_AUTH_SOCK` and `DOCKER_CONFIG` hand out authority rather than
 * a route to the daemon. They are refused beside the socket names rather than
 * under a requirement of their own, because they are the same request: an
 * environment entry that redefines the boundary instead of configuring the
 * process inside it.
 *
 * The dynamic linker is not the only loader that takes its instructions from
 * the environment, and a Sandbox runs whatever interpreter the repository under
 * review needs. `NODE_OPTIONS` injects a module into every Node process,
 * `PYTHONPATH` and `PYTHONSTARTUP` put a chosen module ahead of the real one
 * and run a file before the interpreter reads anything else, and `PERL5LIB`
 * does the same for Perl. Each of them is `LD_PRELOAD` for a different runtime:
 * code that runs before the code anybody asked to run.
 */
export declare const DENIED_ENVIRONMENT_NAMES: readonly string[];
/** Whether a name is on the denied list, whatever it was going to hold. */
export declare const isDeniedEnvironmentName: (name: string) => boolean;
/**
 * Whether a name is a name at all.
 *
 * Both guards above read the name they were given, and an entry is rendered as
 * `name=value` - so a *name* holding an `=` sets a variable neither guard ever
 * saw. `{ name: "ANTHROPIC_API_KEY=sk-live", value: "" }` renders
 * `--env ANTHROPIC_API_KEY=sk-live=`, which sets `ANTHROPIC_API_KEY`, and the
 * credential guard splits `ANTHROPIC_API_KEY=sk-live` on `_` into a last token
 * of `KEY=SK-LIVE`, which is not `KEY`. Every guard downstream of a name that
 * is not a name is reading the wrong string.
 *
 * So the shape is required rather than sanitised. It also refuses the empty
 * name, which renders `--env =value`.
 */
export declare const isEnvironmentName: (name: string) => boolean;
```

## dist/capability.d.ts

```ts
import type { Isolation, RuntimeName } from "./request.js";
import type { RequirementOutcome } from "./requirements.js";
/**
 * What a host reported about itself, reduced to the facts a capability turns
 * on.
 *
 * Every member is one the answer would change for, and nothing else is here:
 * the fingerprint is a digest over exactly this record, so a field that does
 * not matter would re-establish the capability for no reason and a field that
 * does matter and is missing would let the host drift underneath it.
 *
 * `cgroupVersion` is normalized to `"1"` or `"2"` by whichever dialect read it,
 * because Docker reports `"2"` and Podman reports `"v2"` for the same fact.
 */
export interface HostReport {
    readonly runtime: RuntimeName;
    readonly serverVersion: string;
    readonly kernelVersion: string;
    readonly cgroupVersion: string;
    readonly rootless: boolean;
    readonly seccompEnabled: boolean;
    readonly cpuQuotaSupported: boolean;
    readonly memoryLimitSupported: boolean;
    readonly processLimitSupported: boolean;
}
/** A stable digest over a `HostReport`. */
export type HostFingerprint = string;
/**
 * The digest, over the fields in a fixed order rather than over the object.
 *
 * `JSON.stringify` preserves insertion order, so a digest taken over it moves
 * when two readers happen to build the same facts in a different order - and a
 * capability that re-establishes itself on every launch is a cache that does
 * nothing. Listing the fields here also means adding one to `HostReport`
 * without adding it here is a type error rather than a silent hole.
 *
 * @param report The facts to digest.
 * @returns A hex SHA-256 digest.
 */
export declare const fingerprintHost: (report: HostReport) => HostFingerprint;
/**
 * Where a host sits on `CONTEXT.md`'s Isolation ladder.
 *
 * Computed rather than configured, exactly as the glossary requires: a rootless
 * daemon is `container-rootless` and a rootful one is `container`. There is no
 * path to `microvm` from here, and nothing below `container` is a Sandbox.
 */
export declare const hostIsolation: (report: HostReport) => Isolation;
/**
 * What a host has to be able to enforce before any Sandbox is allowed on it.
 *
 * Seccomp and the three limits are hard requirements, so a host that cannot
 * apply one of them is refused rather than run without it. The namespace
 * requirements are absent on purpose: a host report says nothing about the
 * instance that has not been created yet, and those are attested per instance.
 *
 * @param report The facts the host reported.
 * @returns One outcome per requirement a host report can decide.
 */
export declare const checkHost: (report: HostReport) => readonly RequirementOutcome[];
/** A host's capability as it was established, and the digest it is keyed to. */
export interface HostCapability {
    readonly runtime: RuntimeName;
    readonly fingerprint: HostFingerprint;
    readonly isolation: Isolation;
    readonly outcomes: readonly RequirementOutcome[];
    /** When it was established, from the provider's injected clock. */
    readonly establishedAt: number;
}
/**
 * Where an established capability lives between launches, and where a
 * quarantine sticks.
 *
 * Injectable so that a durable cache is a later addition rather than an API
 * break. The one this package ships is in memory and owned by the provider,
 * because a file-backed capability is a writable file that decides whether a
 * Sandbox is allowed to run - which is a capability-forgery surface this issue
 * never asked for.
 */
export interface CapabilityCache {
    readonly read: (runtime: RuntimeName) => HostCapability | undefined;
    readonly write: (capability: HostCapability) => void;
    /** Drift: forget it, so the next launch establishes it honestly. */
    readonly evict: (runtime: RuntimeName) => void;
    /** Residue: refuse everything on this runtime until an operator clears it. */
    readonly quarantine: (runtime: RuntimeName, reason: string) => void;
    readonly quarantinedFor: (runtime: RuntimeName) => string | undefined;
}
/**
 * An in-memory cache, one per provider unless a caller shares one.
 *
 * The quarantine outlives an eviction deliberately. They are not two spellings
 * of the same state: drift means the host changed and should be re-measured,
 * and residue means the host could not prove it destroyed the last Sandbox.
 * Re-measuring launders the second one away, so it does not.
 */
export declare const createCapabilityCache: () => CapabilityCache;
/**
 * The quarantine gate, as an outcome rather than as a branch.
 *
 * @param reason Why the runtime was quarantined, or `undefined` if it was not.
 * @returns The outcome a launch refuses on.
 */
export declare const checkQuarantine: (reason?: string) => RequirementOutcome;
```

## dist/cli-runtime.d.ts

```ts
import type { RuntimeName } from "./request.js";
import type { ContainerRuntime } from "./runtime.js";
export interface CliRuntimeOptions {
    readonly name: RuntimeName;
    /** Defaults to the runtime's own name, resolved on `PATH`. */
    readonly executable?: string;
    readonly timeoutMs?: number;
    readonly maxBufferBytes?: number;
}
export declare const createCliRuntime: (options: CliRuntimeOptions) => ContainerRuntime;
```

## dist/dialect.d.ts

```ts
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
import type { InstanceReport } from "./attestation.js";
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
export declare const DOCKER_DIALECT: RuntimeDialect;
export declare const PODMAN_DIALECT: RuntimeDialect;
```

## dist/index.d.ts

```ts
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
export declare const packageName: "@reprove/sandbox-container";
export { SANDBOX_LABEL } from "./arguments.js";
export { attestInstance } from "./attestation.js";
export type { Attestation, AttestationInput, InstanceReport, ObservedMount, } from "./attestation.js";
export { BROKERED_PLACEHOLDER, DENIED_ENVIRONMENT_NAMES, isBrokeredPlaceholder, isCredentialName, isDeniedEnvironmentName, } from "./broker.js";
export { checkHost, createCapabilityCache, fingerprintHost, hostIsolation, } from "./capability.js";
export type { CapabilityCache, HostCapability, HostFingerprint, HostReport, } from "./capability.js";
export { createCliRuntime } from "./cli-runtime.js";
export type { CliRuntimeOptions } from "./cli-runtime.js";
export { DOCKER_DIALECT, PODMAN_DIALECT } from "./dialect.js";
export type { RuntimeDialect } from "./dialect.js";
export { createDockerProvider, createPodmanProvider, createSandboxProvider, } from "./provider.js";
export type { ExecOutcome, RuntimeProviderOptions, Sandbox, SandboxProvider, SandboxProviderOptions, TeardownReceipt, WorkspaceHandle, } from "./provider.js";
export { SandboxRefusalError } from "./refusal.js";
export type { EgressPolicy, EnvironmentEntry, Isolation, MountRequest, ResourceLimits, RuntimeName, SandboxRequest, SeccompProfile, WorkspaceRequest, } from "./request.js";
export { checkRequest, HARD_REQUIREMENTS } from "./requirements.js";
export type { RequirementName, RequirementOutcome } from "./requirements.js";
export { SandboxTeardownError } from "./residue.js";
export type { Residue } from "./residue.js";
export type { ContainerRuntime, RuntimeInvocation, RuntimeOutcome, } from "./runtime.js";
export { RuntimeUnavailableError } from "./runtime-unavailable.js";
```

## dist/provider.d.ts

```ts
import type { Attestation } from "./attestation.js";
import type { CapabilityCache, HostCapability } from "./capability.js";
import type { RuntimeDialect } from "./dialect.js";
import type { Isolation, RuntimeName, SandboxRequest } from "./request.js";
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
export declare const createSandboxProvider: (options: SandboxProviderOptions) => SandboxProvider;
/** A provider driving Docker through the injected runtime. */
export declare const createDockerProvider: (options: RuntimeProviderOptions) => SandboxProvider;
/** A provider driving Podman through the injected runtime. */
export declare const createPodmanProvider: (options: RuntimeProviderOptions) => SandboxProvider;
```

## dist/refusal.d.ts

```ts
import type { RequirementOutcome } from "./requirements.js";
/**
 * A Refusal carrying every outcome that produced it.
 *
 * The whole set is carried rather than only the failures, because the Worker's
 * structured isolation report is built from it and "which requirements were
 * even measured" is half of what makes a refusal explicable. There is no
 * `required`/`actual` pair here: those belong to a comparison against a
 * demanded Isolation, which is a Worker's decision to make from `outcomes` and
 * `isolation`, not this package's.
 */
export declare class SandboxRefusalError extends Error {
    readonly outcomes: readonly RequirementOutcome[];
    constructor(outcomes: readonly RequirementOutcome[]);
    /** The requirements that failed, in the order they were measured. */
    get failed(): readonly string[];
}
```

## dist/request.d.ts

```ts
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
export type SeccompProfile = {
    readonly kind: "runtime-default";
} | {
    readonly kind: "file";
    readonly path: string;
};
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
export type EgressPolicy = {
    readonly kind: "none";
} | {
    readonly kind: "proxy";
    readonly endpoint: string;
};
/**
 * A mount a caller may ask for, beside the Workspace.
 *
 * `host` is representable precisely so it can be refused by name rather than by
 * silence. `ephemeral` is runtime-owned scratch: it exists for the writable
 * space a Harness needs under a read-only root filesystem.
 */
export type MountRequest = {
    readonly kind: "ephemeral";
    readonly path: string;
    readonly sizeBytes?: number;
} | {
    readonly kind: "host";
    readonly hostPath: string;
    readonly path: string;
};
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
```

## dist/requirements.d.ts

```ts
import type { SandboxRequest } from "./request.js";
/**
 * The stable name of every hard requirement, in ADR 0004's own order.
 *
 * Every one is a hard requirement rather than a strength signal: a missing one
 * is a Refusal, never a narrowing and never a log line.
 */
export type RequirementName = "own-network-namespace" | "own-pid-namespace" | "own-mount-namespace" | "not-privileged" | "no-added-capabilities" | "no-runtime-socket" | "no-host-bind-mount" | "seccomp-enabled" | "cpu-limit" | "memory-limit" | "process-limit" | "ephemeral-workspace" | "no-credential-in-brokered-sandbox" | "host-fingerprint-unchanged" | "local-capability-not-quarantined" | "teardown-leaves-no-residue";
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
export declare const HARD_REQUIREMENTS: readonly RequirementName[];
/**
 * One outcome, stated as a condition and the detail that explains it either
 * way. Both branches carry a detail, because an outcome nobody can read is
 * useless in an isolation report even when it passed.
 */
export declare const outcome: (name: RequirementName, satisfied: boolean, detail: string) => RequirementOutcome;
/** Whether every outcome in a set holds. */
export declare const allSatisfied: (outcomes: readonly RequirementOutcome[]) => boolean;
/** The names that failed, which is what a Refusal message is built from. */
export declare const failedNames: (outcomes: readonly RequirementOutcome[]) => readonly RequirementName[];
export declare const isRuntimeSocket: (hostPath: string) => boolean;
/**
 * Whether a namespace value names somebody else's namespace rather than one of
 * this Sandbox's own.
 *
 * One predicate for every namespace a runtime can be told to share, because
 * `host`, `container:<other>` and `ns:<path>` are the same hole reached through
 * three spellings and a check that knows only the first of them is a check
 * anyone can walk around. The empty value counts too: an unnamed namespace is
 * whatever the daemon's default is, which is not a namespace this Sandbox owns.
 *
 * Shared by the argument audit and the Attestation deliberately. Two copies of
 * this predicate is two chances for one of them to learn a spelling the other
 * does not.
 */
export declare const isSharedNamespace: (value: string) => boolean;
/**
 * The house form for the values a `detail` names.
 *
 * Shared by every layer, because an isolation report whose three layers spell
 * an empty list three different ways reads as three different facts.
 */
export declare const listed: (values: readonly string[]) => string;
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
export declare const checkRequest: (request: SandboxRequest) => readonly RequirementOutcome[];
```

## dist/residue.d.ts

```ts
import type { RequirementOutcome } from "./requirements.js";
/** One thing that should not still exist. */
export interface Residue {
    readonly kind: "instance" | "workspace" | "network";
    readonly id: string;
}
/**
 * Teardown's own outcome, measured by re-listing each resource through the
 * runtime rather than by trusting the exit code of the command that removed it.
 *
 * @param residue What the re-list still found.
 * @returns The outcome a Failure is raised from.
 */
export declare const checkResidue: (residue: readonly Residue[]) => RequirementOutcome;
/**
 * A teardown that could not prove it destroyed what it created.
 *
 * Throwing is not the whole response: the provider also quarantines the local
 * capability, because a host that cannot prove it destroyed the last Sandbox
 * cannot be trusted with the next one.
 */
export declare class SandboxTeardownError extends Error {
    /** ADR 0015's reserved failure identifier. */
    readonly reason = "sandbox_teardown_incomplete";
    readonly residue: readonly Residue[];
    constructor(residue: readonly Residue[]);
}
```

## dist/runtime-unavailable.d.ts

```ts
/**
 * What a runtime that produced no outcome at all raises.
 *
 * Its own module because the house rule is one class per file, and its own
 * class because "the daemon said no" and "there was no answer from the daemon"
 * need opposite fixes. A bare `ENOENT` names neither the runtime nor the
 * executable, and a Worker reading it has to guess which of the two it was
 * driving.
 *
 * It covers both ways an invocation ends without an exit status: an executable
 * that could not be run, and one that was killed before it finished. The second
 * is the one worth stating out loud - a killed child has no exit code, and
 * anything that reads a missing code as zero turns a timeout into a success
 * carrying whatever output had arrived by then.
 */
import type { RuntimeName } from "./request.js";
/** The container runtime produced no exit status: it did not run, or it was killed. */
export declare class RuntimeUnavailableError extends Error {
    readonly runtime: RuntimeName;
    readonly executable: string;
    /**
     * @param runtime Which runtime was being driven.
     * @param executable The command that produced nothing.
     * @param what The whole predicate, so a kill does not read as a failed spawn.
     */
    constructor(runtime: RuntimeName, executable: string, what: string);
}
```

## dist/runtime.d.ts

```ts
/**
 * The container runtime, as the only thing this package touches outside Node.
 *
 * One method: arguments in, text out. Everything security-relevant this package
 * does is expressed as an argument vector, and an argument vector is exactly
 * what a test can inspect - which is what makes "`--privileged` is never
 * rendered" a fact a test can assert rather than a claim a reviewer has to
 * take on faith.
 *
 * It is an injected interface rather than a module the provider imports,
 * because a boundary proven by replacing the module underneath it is proven
 * against a mock of the boundary. Injection is also the only option the house
 * lint rules leave open: module mocking is banned outright.
 */
import type { RuntimeName } from "./request.js";
/** One invocation of the runtime's command-line interface. */
export interface RuntimeInvocation {
    /** The argument vector, without the executable. Never passed to a shell. */
    readonly arguments: readonly string[];
    /** Written to the child's standard input and closed, when present. */
    readonly stdin?: string;
}
/**
 * What the invocation produced. A non-zero exit is an outcome rather than a
 * throw: "the instance does not exist" and "the daemon is unreachable" are
 * different facts, and collapsing both into an exception loses the first.
 */
export interface RuntimeOutcome {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
export interface ContainerRuntime {
    readonly name: RuntimeName;
    readonly invoke: (invocation: RuntimeInvocation) => Promise<RuntimeOutcome>;
}
```
