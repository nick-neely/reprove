# Codex execution

Issue [#52](https://github.com/nick-neely/reprove/issues/52) adds one host-side Codex Adapter, used identically by either Worker placement. Authentication selects its internal implementation. It returns candidate output; Worker core owns Evidence conformance and the protocol Result.

## Authentication and Exposure

| Authentication supplied to `createCodexAdapter` | Execution | Resolved Exposure |
| --- | --- | --- |
| `{ kind: "api-key", provider: "openai", key }` | Pinned Harness bridge and Codex SDK | `none` |
| `{ kind: "api-key", provider: "gateway", key }` | Same bridge, Gateway endpoint | `none` |
| `{ kind: "native", authJson }` | Pinned native Codex CLI | `account` |

**ADR 0004's native exception is preserved.** The literal credential-exclusion criterion in #52 applies to brokered invocation. Native `auth.json`, including saved ChatGPT authentication, resides in the Sandbox's private CODEX_HOME and is account Exposure. Worker core uses the Adapter's resolved Exposure, so a caller cannot lower it to `none`. Account Exposure on a rootful container is refused; an internal Run requires rootless-container or microVM isolation and a compatible repository maximum. There is no placement-specific authentication gate.

Brokered credentials enter the Adapter on the Worker host. The SDK receives only its own recognized credential placeholder in the Sandbox; an attempted real-credential fallback throws. The host proxy matches the exact placeholder and substitutes the secret only for an allowed Provider request. No ambient host authentication is consulted.

## Exact artifacts and provisioning

| Artifact | Pin |
| --- | --- |
| Harness core | `1.0.102` |
| Codex Harness bridge | `1.0.104` |
| Embedded Codex SDK and native CLI | `0.149.1` |

The coordinated `harness` catalog pins the first two. The bridge's shipped frozen bootstrap lock pins the latter. Build the image before handling repository content or credentials:

```sh
pnpm verify:build
node tools/build-codex-image.mjs
```

`CODEX_SANDBOX_PROFILE` in Worker core names that image and its bounded scratch, private home, bridge runtime and protected-input mounts. `sandboxRequestFor("codex", CODEX_SANDBOX_PROFILE)` still requests `--network none`. The Sandbox reaches host-side policy through attached process pipes, never a host network interface or container-runtime socket. Docker and OpenSSL 3 are needed on the Worker host. Use Node 22.19 or newer: saved ChatGPT authentication compresses requests with zstd, which the proxy decompresses under its byte cap before inspection and forwarding. Node is included in the pinned image.

The host must materialize the pinned Workspace before invoking the Adapter. Its files and directories must be root-owned and unwritable by uid 1000. The preflight walks the actual tree, checks the immutable runtime digest, expected bridge and launcher bytes, and CLI version, and establishes a private runtime/home. `materializeNarrative` writes the encoded narrative through protected stdin file I/O. The Reviewer can read that root-owned file but cannot replace it or its parent.

The native CLI supports `--ignore-user-config` and `--ignore-rules`. The upstream SDK does not expose those flags, and a real canary demonstrated that prose suppression alone still started repository MCP processes. The image therefore makes one checked insertion at the upstream bridge's Codex constructor, selecting a fixed launcher which adds those flags. An unexpected constructor shape fails the build. Adapter-owned `project_doc_max_bytes=0` and `skills.include_instructions=false` suppress prose/skill discovery on both implementations. The Workspace remains unchanged.

## Fresh capability evidence

`capability()` reports only `verify` after a fresh matching instruction probe. `inspect` and `fix` are unavailable. Missing, failed, stale, future-dated or mismatched evidence withdraws capability. The fingerprint hashes executable Adapter/Harness package contents, the authentication implementation, Provider selection and pinned Model. Worker core resolves it again against the actual attested Sandbox and its observed isolation before authorizing the Pass. Capability resolution has a 30-second deadline even when the caller provides a signal; `instructionProbe(signal)` receives the composed cancellation signal. An unresponsive callback cannot delay the Worker's refusal and teardown.

To obtain evidence, launch a **separate disposable synthetic Sandbox**, install the trusted `CODEX_PROBE_FILES` as root-owned read-only Workspace files, and create a protected empty narrative. Call `probeCodexInstructions({ model, authentication, sandbox, signal })`, then tear down that Sandbox. The probe uses the real CLI/bridge, checks that fixture files are present, observes outbound Provider inputs for prose, skill and unresolved-import canaries, and checks whether executable MCP configuration ran. It consumes a Provider turn. Cache only its returned measurement, for at most five minutes, and provide it through `instructionProbe`. A probe is never a production Run or a fabricated clean Result.

For example, after acquiring a measured `proof` and preparing the pinned Workspace:

```ts
const adapter = createCodexAdapter({
  model,
  authentication,
  instructionProbe: () => Promise.resolve(proof),
});
const core = createWorkerCore({
  adapter,
  sandboxes,
  profile: CODEX_SANDBOX_PROFILE,
  materialize: materializeWorkspaceAndNarrative,
  workerBuildVersion,
});
const outcome = await core.execute(input);
```

`materializeWorkspaceAndNarrative` is the existing Worker materialization port: populate the pinned Workspace, then call `materializeNarrative`. No Author bytes belong in command arguments or environment. Reprove's available Model choices live in control-plane `MODEL_CATALOGUE`; the Adapter accepts an opaque explicit pin and performs no runtime enumeration.

## Output and lifecycle

Both implementations observe actual command completions and parse the private answer with Zod. Worker core compares claimed Evidence with that observed stream and validates the normalized Result. Invalid output gets at most one repair turn in the same thread, Pass and Sandbox. Usage is cumulative across that thread, so repair does not double-count it. The CLI does not reliably report a resolved Model: the descriptor reports this limitation and output carries `null`.

Cancellation, execution failure and exhausted repair never become an empty clean Result. Diagnostics are drained and not exposed as Finding prose or credential-bearing failure details. Teardown releases bridge endpoints, proxy connections, processes and the container; uncertain cleanup fails and quarantines the provider.

## Verification and decision history

`pnpm verify` includes `tools/codex-contract.test.mjs`. It builds the pinned image and exercises the public Adapter/Worker boundaries with real Docker, Codex CLI and bridge. Only the external Provider HTTP response is substituted, so CI needs no paid credentials. These tests cover both authentication implementations, Gateway, instruction/executable canaries, command observation, repair, usage, credential ingress, cancellation and Worker Result conformance. Live Podman and a paid Provider/account smoke are separate qualification steps; neither is claimed by these fixtures.

The prerequisite scope follows the [#1](https://github.com/nick-neely/reprove/issues/1), [#26](https://github.com/nick-neely/reprove/issues/26), [#27](https://github.com/nick-neely/reprove/issues/27) and [#28](https://github.com/nick-neely/reprove/issues/28) maps. [#33](https://github.com/nick-neely/reprove/issues/33) called for port access, request transformation and protected inputs. [#45](https://github.com/nick-neely/reprove/issues/45) shipped the initial buffered, network-isolated provider. #52 includes the missing prerequisites so its Adapter is executable against the real provider.

The probe also records a SHA-256 digest of the complete immutable Codex runtime tree inside its Sandbox, including the native executable, suppression launcher, bridge, SDK dependencies and bootstrap files. Dispatch compares the actual Sandbox digest with that measurement and separately checks the expected bridge and launcher bytes. Host package fingerprints include runtime JavaScript, JSON manifests and the embedded frozen lockfile. A rebuilt image cannot reuse another runtime's evidence just by retaining its version string.

`PassRequest.onProgress` is a synchronous subscription to live `started`, `tool-completed`, `usage`, `repair-started` and `finished` events. Worker core forwards a Run's subscription. Events carry metadata, never model prose, command text or command output; they remain untrusted and are not Evidence. Observer exceptions fail the Pass. Both authentication routes use the same event vocabulary and keep repair within the original Pass.
