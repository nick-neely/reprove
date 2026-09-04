# `@reprove/sandbox-container`

The container Sandbox primitive. It depends on **no** `@reprove/*` package, because it is offered as a standalone security primitive usable with `@ai-sdk/harness` by someone who has never heard of Reprove - and that claim is only true if the dependency graph says so. If it later needs a small utility, the answer is to duplicate it or extract a genuinely generic external package, never to reach back into Reprove's application graph.

It also depends on nothing outside Node's own builtins. There is no container-runtime client library and no schema library: the whole runtime seam is one argument vector in and text out, which is what makes every claim below something a test can assert rather than something a reviewer has to take on faith.

## Support tier

**Supported product surface** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

## What a Sandbox is here

A Sandbox is defined by properties, not by a technology ([ADR 0004](../../docs/adr/0004-sandbox-boundary-and-credential-isolation.md)). Every one of these is a **hard requirement**: a missing one is a Refusal, never a narrowing and never a log line. Each is enforced at more than one layer, because the layers see different things.

| Property | Request check | Argument audit | Attestation |
| --- | --- | --- | --- |
| Its own network namespace | | `--network` names one network, and not the host's or another instance's | `NetworkMode` is the network this Sandbox owns |
| Its own PID namespace | | no `--pid`, `--ipc`, `--userns`, `--uts` or `--cgroupns` pointing at the host | `PidMode` is private |
| Its own mount namespace | | | the resolved mount set is exactly the Workspace volume and the ephemeral mounts that were asked for, and the root filesystem is read-only |
| Not privileged | not representable in a request | no `--privileged` | `Privileged` is false and `no-new-privileges` is applied |
| No added capabilities | | no `--cap-add`, and `--cap-drop ALL` is present | `CapAdd` is empty and `CapDrop` holds `ALL` |
| No container-runtime socket | a mounted socket, or `DOCKER_HOST` and friends in the environment | no argument naming a socket | no bind or mount naming a socket |
| No host bind mount | any `host` mount at all | no `--volume` whose source is a path rather than a volume name - a leading `/`, `.` or `~` | no `Binds` entry whose source is an absolute path |
| Seccomp enabled, never `unconfined` | a profile file with no path, or one named `unconfined` | no `seccomp=unconfined` | no `seccomp=unconfined`, a profile of its own when one was named, **and** a daemon that still applies a profile |
| CPU, memory and process limits | absent, zero, negative or non-finite | all three present and positive | each is exactly the value that was asked for |
| An ephemeral, sandbox-owned Workspace | a relative path, a non-positive size, or a relative ephemeral mount | | the Workspace is the volume this provider created, at the path that was asked for |
| No credential in a brokered Sandbox | an environment name that is not a name, or a credential-shaped one not holding the placeholder | | |
| The host has not drifted | | | the observed fingerprint is the one the capability was established at |
| The local capability is not quarantined | the launch refuses before any invocation | | |
| Teardown leaves no residue | | | teardown re-lists each resource through the runtime |

There is no `unconfined` member to select: `SeccompProfile` has two, and neither is it. A profile *path* spelled `unconfined` is a different thing and is handled as one - `{ kind: "file", path: "unconfined" }` would render `--security-opt seccomp=unconfined`, so it is refused by name at the request, again in the argument audit, and again in the Attestation. `privileged` is not a member of `SandboxRequest` at all. A host bind mount *is* representable, on purpose - a standalone primitive is handed requests by callers who have never read ADR 0004, and an unrepresentable request produces no Refusal anyone can read.

Two of those rows are stricter than they look, and both are deliberate:

- **The mount check is an allowlist.** "No mount of kind `bind`" is a blocklist over one field, and three things get past it: a host path reached through the local volume driver, which inspects as a *volume*; a mount kind neither runtime had when this was written; and an anonymous volume from the image's own `VOLUME` directive, which is writable, executable storage inside an instance whose read-only root was meant to prevent exactly that. So the resolved set has to be exactly the requested one - which means **an image carrying a `VOLUME` directive is refused by name**, rather than launched with storage nobody asked for.
- **A named seccomp profile is attested by presence, not by path.** Docker's *client* reads the profile file and inlines the compacted JSON, so `SecurityOpt` holds `seccomp={"defaultAction":...}` and never the path; Podman keeps the path. Comparing against the path would refuse every named-profile launch on Docker, and comparing against the JSON would need this package to read a host file it has no other reason to touch. What the profile *says* is therefore the caller's responsibility: an allow-everything profile is still a profile.

## The three layers, and why there are three

```text
checkRequest      pure, reads the request     refuses before any invocation
auditArguments    pure, reads the argv        refuses before anything is created
attestInstance    pure, reads the instance    refuses after `create`, before `start`
```

Each one sees something the others cannot. The request check sees intent and costs nothing. The argument audit sees what the renderer actually produced, and is written from the opposite end of the same requirement so that a renderer bug is caught rather than trusted. The Attestation sees what the runtime actually did, which is the only thing a Run executes inside.

`launch()` is a fixed ordered pipeline and there is no path to a `Sandbox` that skipped a step:

```text
 1 quarantine gate     refuses with zero runtime invocations
 2 request check       refuses with zero runtime invocations
 3 host capability     cached, or established from one `info`
 4 fresh fingerprint   compared against the cached one; drift evicts
 5 render              the argument vector
 6 argument audit      refuses before anything is created
 7 own the resources   the Workspace volume, and the network if there is one
 8 create              the instance exists and is not running
 9 attest              refuses, having removed what it created
10 start               execution is authorized only here
```

Steps 8 and 10 are split precisely so step 9 happens before a single byte of repository code runs. A `run` would have started the instance before anything could be read back from it, and an Attestation taken after execution began is a description rather than a gate.

**An Attestation can only refuse, never grant.** Worker core remains the sole authorizer of execution: it decides whether a Run is dispatched at all, and every gate here is one more thing that dispatch has to survive.

## Cached capability, fresh Attestation

A host capability answers "could this host hold the boundary" - expensive to ask, slow to change - so it is established once and cached behind a digest of the facts it was computed from. An Attestation answers "did this instance hold it" and is taken every launch.

The host is nonetheless re-read on every launch, and its fingerprint compared. A host that changed since its capability was established is caught **at the instance that would have used it**, not at the next probe. Drift and residue are then handled differently on purpose:

- **Drift** evicts the cached capability and refuses this launch. The host changed; measure it again. The next launch establishes it honestly and proceeds.
- **Residue** *quarantines* the runtime. It is sticky, it survives an eviction, and it refuses every later Sandbox on that runtime until an operator clears it, because a host that cannot prove it destroyed the last Sandbox cannot be trusted with the next one. A launch that is refused *after* it created something and then cannot prove it cleaned up quarantines too: the Refusal is the error the caller gets, so residue on that path has no exception of its own to travel in.

  A quarantine is a fact about the host, so the default `CapabilityCache` is **one cache shared by every provider in the process** - a Worker that builds a provider per Run would otherwise throw the quarantine away with the provider that raised it. Pass a `cache` to scope it deliberately. Clearing one means fixing the host and restarting: a durable cache would need an explicit way to clear a fail-closed state, which is a reason to think before adding one.

Steps 7 to 10 are one region that owns resources, and a failure anywhere in it releases them all on the way out - so a `create` the runtime rejects leaves no Workspace volume behind either. The error that leaves is the one that arrived: a cleanup failure reported in place of a Refusal would hide which requirement failed.

Teardown does not trust the exit code of the command that removed something. It re-lists the instance, the Workspace volume and the network through the runtime, and compares exact names. A `TeardownReceipt` never carries residue; a teardown that found some raises `SandboxTeardownError`, whose `reason` is ADR 0015's reserved `sandbox_teardown_incomplete`.

## Brokering

On the Brokered Route the credential is substituted **outside** the boundary, on the outbound request, after it has left the Sandbox. Inside there is only `BROKERED_PLACEHOLDER`, which is not a secret.

Four structural facts hold this up, and none of them is a lint rule:

1. `SandboxRequest` has no credential member. There is nothing to pass one through.
2. An environment entry whose **name** is credential-shaped may hold the placeholder and nothing else. The guard splits the name on `_` and compares whole tokens against `TOKEN`, `SECRET`, `KEY`, `APIKEY`, `PASSWORD`, `PASSPHRASE`, `CREDENTIAL`, `CREDENTIALS`, `AUTH`, `COOKIE` and `SESSION` - so `ANTHROPIC_API_KEY` is refused and `GITHUB_AUTHOR` and `KEYBOARD` are not. A guard that refuses correct requests is one operators learn to route around.
3. A short list of names may hold nothing at all: `DOCKER_HOST`, `CONTAINER_HOST`, `DOCKER_CONFIG`, `XDG_RUNTIME_DIR`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `PERL5LIB`. These redefine the boundary rather than configure the process inside it: the first seven name the daemon, the host's authority or the dynamic linker, and the last four are the same trick for Node, Python and Perl - code that runs before the code anybody asked to run.
4. A name has to be a name: `^[A-Za-z_][A-Za-z0-9_]*$`. An entry renders as `name=value`, so a *name* holding an `=` sets a variable neither guard above ever read - `{ name: "ANTHROPIC_API_KEY=sk-live" }` renders `--env ANTHROPIC_API_KEY=sk-live=`, and the credential guard's last token is `KEY=SK-LIVE`, which is not `KEY`. Every guard downstream of a name that is not a name is reading the wrong string.

The environment member exists at all because instruction suppression - `CLAUDE_CODE_SAFE_MODE`, `OPENCODE_DISABLE_PROJECT_CONFIG` and their siblings - is a Sandbox-provisioning concern. A per-command environment is merged *over* the Sandbox's own, so a suppression flag set per command can be shadowed and one set here cannot.

## One implementation, two dialects

There is one implementation of the contract and a per-runtime table, rather than two providers. The differences that exist for the arguments ADR 0004 needs are an executable name and two report readers, one for the host and one for the instance; the rendering, the pipeline, the Attestation and the teardown are identical. Duplicating them would duplicate the security-critical part, and duplicated security code is how one of the two copies drifts silently.

| Concern | Docker | Podman |
| --- | --- | --- |
| executable | `docker` | `podman` |
| host report | `info --format '{{json .}}'` | `info --format json` |
| rootless | `SecurityOptions` holds `name=rootless` | `host.security.rootless` |
| seccomp | `SecurityOptions` holds `name=seccomp` with a profile that is not `unconfined` | `host.security.seccompEnabled` |
| limit support | `CpuCfsQuota`, `MemoryLimit`, `PidsLimit` | `host.cgroupControllers` holds `cpu`, `memory`, `pids` |
| cgroup version | `"2"` | `"v2"`, normalized to `"2"` |
| instance report | `inspect <id> --format '{{json .}}'` | identical; Podman carries a Docker-compatible `HostConfig` |
| everything else | `create` / `start` / `exec` / `rm`, `volume`, `network`, `ps`, and every flag rendered | identical |

**Stated plainly: the Podman dialect is not proven against a live Podman.** Podman is installed neither on the machine this was written on nor in CI. It ships proven against the whole shared contract suite and against a recorded fixture whose shape is taken from the `libpod/define` structs at Podman v5.8.6 - not against a running daemon. The Docker dialect has additionally been driven end to end against Docker 29.1.3 by hand. "Nothing warns and runs" applies to this README too, so the gap is named rather than left for someone to infer from a green suite.

Naming it precisely: the `podman info` reader is checked against a fixture built from Podman's own structs, but the *instance* reader and the Attestation are checked against a **Docker** recording, because both runtimes report a Docker-compatible `HostConfig`. Four fields are where that assumption would break, and each would refuse every Podman launch rather than admit one: `NanoCpus` (Podman may express `--cpus` as `CpuQuota`/`CpuPeriod` instead), `CapDrop` (if `ALL` is expanded into an explicit list), `NetworkMode` (if it reports `bridge` rather than the network's name), and `SecurityOpt` for a named seccomp profile. Every one fails closed, which is the right direction and still not the same as being proven.

If Podman ever needs `--userns=keep-id`, a quadlet or a `podman machine` path, the dialect has become a strategy and two implementations become the right answer.

## Testing without a container runtime

`ContainerRuntime` is injected, so is the clock, and so is the identifier source. Every rendered name and every timestamp is fixed, and the whole contract suite runs against both dialects with no daemon, no filesystem and no random source - including the refusals, which are the cases a live-runtime test is worst at reaching. Module mocking is banned in this repository, which makes injection the only option anyway; it is also the right one, because a boundary proven by replacing the module underneath it is proven against a mock of the boundary.

## Deliberate gaps

- **The egress proxy itself is not here.** `EgressPolicy.proxy` creates a Sandbox-owned `--internal` network and destroys it at teardown, so nothing routes out; the proxy that terminates it, and the `endpoint` becoming an argument, is a follow-up.
- **`WorkspaceRequest.sizeBytes` is recorded, not imposed.** The local volume driver on both runtimes takes no size. It is required to be positive and it is what a driver that does take one would be given.
- **The instance runs as the image's own user, which is usually `root` inside the Sandbox.** That is root in a user namespace under a rootless daemon and root in the instance under a rootful one; either way it holds no capabilities and cannot write the root filesystem. The two in-container identities ADR 0012 requires are worker-core work.
- **`InstanceReport` carries no devices, IPC mode or `Config.Env`.** Nothing can render a `--device` or an `--ipc` (the audit refuses both, and `--` keeps the image out of the flag region), so this is a gap in the third layer rather than a hole in the boundary - but it means `no-credential-in-brokered-sandbox` is decided at the request layer alone.
- **The Workspace is created empty.** Materializing the stripped Git repository into it, and the two in-container identities [ADR 0012](../../docs/adr/0012-author-controlled-narrative-input.md) requires, are worker-core work. The API does not preclude either.
- **There is no `@ai-sdk/harness` bridge.** It is deliberately deferred so this package's published surface stays free of upstream types; it lands with the issue that actually drives a Harness.
