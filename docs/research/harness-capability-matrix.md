# Harness adapter capability matrix

Research for [#4](https://github.com/nick-neely/reprove/issues/4) (child of [#1](https://github.com/nick-neely/reprove/issues/1)).
Date of investigation: **2026-08-29**.

## Scope and method

Packages examined, at the exact versions published as of 2026-08-29:

| Package | Version | First publish | Last publish |
| --- | --- | --- | --- |
| `@ai-sdk/harness` | 1.0.93 | 2026-06-04 | 2026-08-28 |
| `@ai-sdk/harness-codex` | 1.0.95 | 2026-06-04 | 2026-08-28 |
| `@ai-sdk/harness-claude-code` | 1.0.97 | 2026-06-04 | 2026-08-28 |
| `@ai-sdk/harness-opencode` | 1.0.95 | 2026-06-24 | 2026-08-28 |
| `@ai-sdk/sandbox-vercel` | 1.0.93 | 2026-06-04 | 2026-08-28 |

Sources, in order of authority used:

1. **Published package source.** Every one of these packages ships `.js.map` files containing full
   `sourcesContent`, so the actual TypeScript source of both the host adapter and the in-sandbox
   bridge is recoverable from the npm tarball. All `[SRC]` citations below are from that extracted
   source and name the file as it exists in `vercel/ai` (`packages/<pkg>/src/...`).
2. **Shipped `.d.ts`.** All `[DTS]` citations are from `dist/index.d.ts` / `dist/agent/index.d.ts`
   of the published tarball.
3. **Official docs** at `ai-sdk.dev`. All `[DOC]` citations name the page.
4. **npm registry metadata** for versions and release cadence (`[NPM]`).

### Verification legend

- **[V]** Verified. A direct quote or excerpt from source, `.d.ts`, or a doc page, cited inline.
- **[I]** Inferred. A conclusion drawn from verified evidence but not itself stated by a source.
- **[U]** Unknown. Not established by any source consulted.

Matrix cell values: **yes** (supported) / **partial** / **no** (absent, and in most cases actively
throws) / **?** (unknown).

> **Warning about docs.** The `ai-sdk.dev` harness pages carry the banner "Harness packages are
> **experimental**. Expect breaking changes between releases as this early API gets further
> refined." [V][DOC `providers/ai-sdk-harnesses/codex`]. The published source is the more reliable
> authority here, and in one place below the source contradicts what a naive doc reading implies.

---

## The matrix

### A. Model configuration and discovery

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Per-session model selection (`model` on `HarnessAgent`) | yes | yes | yes |
| Per-adapter model selection (`createX({ model })`) | yes, **deprecated** | yes, **deprecated** | yes, **deprecated** |
| Runtime enumeration of usable models | **no** | **no** | **no** |
| Adapter reports the model it actually resolved to | **no** | yes | yes |
| Adapter default when `model` is unset | pinned `'gpt-5.5'` | CLI default | CLI default |
| Provider-qualified model ids | only under AI Gateway | n/a | yes (`anthropic/...`, `openai/...`) |
| Reasoning-effort control | `reasoningEffort` | `thinking` + `effort` | `reasoningVariant` |

### B. Authentication

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| `auth: 'auto'` (default) | yes | yes | yes |
| `auth: 'ai-gateway'` | yes | yes | yes |
| `auth: 'direct'` | yes | yes | **no** (uses `'anthropic'` / `'openai'` instead) |
| `auth: 'anthropic'` / `'openai'` | no | no | yes |
| `auth: Record<string,string>` isolated credential env | yes | yes | yes |
| Reads a subscription / OAuth credential cache | **no** | **no** | **no** |
| Reads any on-disk credential file | no | `~/.claude/settings.json` `apiKeyHelper` only | no |
| Credential brokering (real secret never enters sandbox) | yes | yes | yes |
| Arbitrary env passthrough into the agent process | via `codexConfig` only | `env` setting | via `openCodeConfig` only |

### C. Instructions, skills, tools, MCP

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Custom system/developer instructions | yes | yes | yes |
| Instructions replaceable between turns without losing thread | **no** | yes | yes |
| Harness `skills` (name + description + content + files) | yes | yes | yes |
| Host-executed custom tools | yes (CLI-shim relay) | yes (MCP) | yes (MCP) |
| Caller-supplied MCP servers | **partial** | yes | yes |
| Built-in tool filtering (`activeTools` / `inactiveTools`) | **no** (throws) | yes (native) | partial (auto-deny) |
| Built-in tool approval (`permissionMode != 'allow-all'`) | **no** (throws) | yes | yes |
| Host-tool approval (`toolApproval`) | yes (framework-level) | yes | yes |
| Auto-pickup of repo config (`AGENTS.md` / `CLAUDE.md`) | yes [I] | yes | yes [I] |
| Documented way to suppress that pickup | **no** | **no** | **no** |
| Built-in tools exposed as typed `ToolSet` | 2 | 40+ | 11 |

### D. Streaming and result capture

| Stream part / capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| `text-*`, `reasoning-*` deltas | yes | yes | yes |
| `tool-call` / `tool-result` | yes | yes | yes |
| `tool-approval-request` | **no** | yes | yes |
| `file-change` | yes | **no** | yes |
| `compaction` | **no** | yes | yes |
| `stream-start.modelId` (resolved model) | **no** | yes | yes |
| Token usage on `finish` / `finish-step` | yes | yes | yes |
| Cost in USD | **no** | yes (`harnessMetadata['claude-code'].costUsd`) | **no** |
| Structured output (JSON Schema) | yes | yes | yes |
| Schema-less JSON mode | **no** (throws) | **no** (throws) | **no** (throws) |
| Raw runtime events (`raw` part) | yes | yes | yes |

### E. Cancellation, timeouts, session lifecycle

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| `abortSignal` on start and on each turn | yes | yes | yes |
| `session.destroy()` | yes | yes | yes |
| `session.stop()` returning resume state | yes | yes | yes |
| `session.detach()` (park runtime, keep it alive) | yes | yes | yes |
| Cross-process resume (`createSession({ resumeFrom })`) | yes | yes | yes |
| `session.suspendTurn()` / `continueTurn()` mid-turn | yes | yes | yes |
| Lossless attach-and-replay on continue | partial | partial | partial |
| Manual compaction (`session.compact()`) | **no** (throws) | yes | **partial** |
| Mid-turn steering (`experimental_steer`) | **no** | yes | yes |
| Adapter-level turn/wall-clock timeout | **no** | **no** (`maxTurns` caps turns, not time) | **no** |

### F. Sandbox integration

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| Requires a sandbox session | yes | yes | yes |
| Requires an exposed port (WebSocket bridge) | yes | yes | yes |
| Declares a bootstrap recipe (installs into the sandbox) | yes | yes | yes |
| Works against a caller-supplied basic `SandboxSession` | partial (needs `port` + `portEndpoint`) | partial (same) | partial (same) |
| Credential brokering requires provider support | yes | yes | yes |

---

## Notes on the non-obvious cells

### Runtime model discovery: absent everywhere

**[V]** There is no model-enumeration API anywhere in the five packages. A grep across the entire
extracted source of all five for `listModels`, `availableModels`, `getModels`, `supportedModels`,
and `modelList` returns exactly one hit, and it is a constant:

```ts
// packages/harness-codex/src/codex-harness.ts
const DEFAULT_CODEX_MODEL = 'gpt-5.5';
```

`[SRC]` `@ai-sdk/harness-codex@1.0.95` → `src/codex-harness.ts:80`.

**[V]** The upstream `@openai/codex-sdk@0.149.1` that the Codex bridge drives has no listing call
either. Its `Codex` class exposes only `startThread()` / `resumeThread()`, and `ThreadOptions.model`
is a bare `string?`.

**[V]** The model is a plain opaque string on both the framework and adapter surfaces:

```ts
// HarnessAgentSettings
/**
 * Model identifier passed to the harness adapter when a session starts.
 * Supported values are defined by the selected harness.
 */
readonly model?: string;
```

`[DTS]` `@ai-sdk/harness@1.0.93` → `dist/agent/index.d.ts`.

**[V]** The docs never document an enumeration API on any adapter page or on `harness-agent`.

**[I]** Consequence for Reprove: **the list of usable models is not discoverable at runtime and must
be supplied by Reprove itself** (a curated per-harness allowlist in config, or an unvalidated
free-text field). PRD open question 5 therefore resolves to "we own the catalogue." There is no
difference here between API-key and subscription auth, because subscription auth is not supported at
all (below).

**[V]** Only Claude Code and OpenCode tell you which model the runtime actually resolved to, via
`stream-start.modelId`:

```ts
type HarnessV1StreamPart =
  | { type: 'stream-start';
      warnings?: ReadonlyArray<HarnessV1CallWarning>;
      /**
       * The model the runtime actually resolved to for this turn, when the
       * adapter learns it at stream start ... Omitted when the adapter doesn't know it here.
       */
      modelId?: string; }
  | ...
```

`[DTS]` `@ai-sdk/harness@1.0.93` → `dist/index.d.ts`. The Codex bridge emits a bare
`emit({ type: 'stream-start' })` with no `modelId` `[SRC]`
`@ai-sdk/harness-codex@1.0.95` → `src/bridge/index.ts`.

### Usage and cost, and the subscription-auth question

**[V] No adapter supports subscription or OAuth authentication.** A grep of the complete extracted
source of `@ai-sdk/harness`, `-codex`, `-claude-code`, `-opencode`, and their in-sandbox bridges for
`auth.json`, `.credentials`, `oauth`/`OAUTH`, `CLAUDE_CODE_OAUTH`, `ChatGPT`, and `subscription`
returns **zero hits**. Every auth path resolves an API key or gateway token into an environment
variable blob:

- Codex: `OPENAI_API_KEY` / `CODEX_API_KEY` / `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN`, plus
  `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`. `[SRC]` `src/codex-auth.ts`.
- Claude Code: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `AI_GATEWAY_API_KEY` /
  `VERCEL_OIDC_TOKEN`, plus `ANTHROPIC_BASE_URL`. `[SRC]` `src/claude-code-auth.ts`.
- OpenCode: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AI_GATEWAY_API_KEY`.
  `[SRC]` `src/opencode-auth.ts`.

The Codex bridge goes further and pins `preferred_auth_method = 'apikey'` in the Codex CLI config
when a base URL is in play `[SRC]` `src/bridge/index.ts`.

The one on-disk credential read anywhere is Claude Code's mirror of the CLI's `apiKeyHelper` hook,
and it too is for API keys, executed on the **host**, not in the sandbox:

```ts
/**
 * Read the `apiKeyHelper` setting from `~/.claude/settings.json` and run
 * it. The `claude` CLI uses this hook to fetch credentials from password
 * managers and similar tools; mirroring it here lets users with that
 * setup run the harness without having to set `ANTHROPIC_API_KEY`
 * explicitly.
 */
```

`[SRC]` `@ai-sdk/harness-claude-code@1.0.97` → `src/claude-code-auth.ts`.

**[I] So the framing of the question changes.** "Is usage available under subscription auth?" has no
answer inside these packages, because these packages cannot run under subscription auth. The nearest
escape hatch is Claude Code's `env` setting, which merges arbitrary variables into the Claude Code
process inside the sandbox `[V][DTS]` ("Environment variables for the Claude Code process. These
values are merged over the sandbox bridge process environment."). Injecting an OAuth token there is
**untested by these packages and outside their credential-brokering path**, so the real secret would
land inside the sandbox in plaintext. That is exactly the boundary the map issue says must not be
crossed with untrusted PR code present.

**[V] What usage you do get.** All three adapters emit `LanguageModelV4Usage` on `finish-step` and
`finish` (input/output/reasoning/cache-read/cache-write token counts). Only Claude Code reports
money:

```ts
if (typeof msg.total_cost_usd === 'number') {
  totalCostUsd = (totalCostUsd ?? 0) + msg.total_cost_usd;
}
// ...
...(totalCostUsd !== undefined
  ? { harnessMetadata: { 'claude-code': { costUsd: totalCostUsd } } }
  : {}),
```

`[SRC]` `@ai-sdk/harness-claude-code@1.0.97` → `src/bridge/index.ts`. Codex emits
`totalUsage: turnUsage ?? defaultUsage()` with no cost field `[SRC]`
`@ai-sdk/harness-codex@1.0.95` → `src/bridge/index.ts`; OpenCode maps OpenCode's token counters and
has no cost concept `[SRC]` `src/bridge/opencode-usage.ts`.

**[I]** Reprove must compute cost itself from tokens plus its own price table for two of the three
harnesses. Do not model `costUsd` as a common field.

### Structured output: available on all three, not only Codex

This corrects the assumption embedded in the ticket. **[V]** All three adapters accept
`responseFormat: { type: 'json', schema }` and all three reject schema-less JSON with the same shape
of error:

```ts
if (promptOpts.responseFormat?.type === 'json' && promptOpts.responseFormat.schema == null) {
  throw new HarnessCapabilityUnsupportedError({
    message: "Harness 'codex' requires a JSON schema for structured output.",
    harnessId: 'codex',
  });
}
```

`[SRC]` `src/codex-harness.ts`; identical guards with `'claude-code'` and `'opencode'` in
`src/claude-code-harness.ts` and `src/opencode-harness.ts`.

Each maps it onto a different native mechanism `[SRC]` bridge sources:

| Adapter | Native mechanism |
| --- | --- |
| Codex | `thread.runStreamed(prompt, { outputSchema })` on `@openai/codex-sdk` |
| Claude Code | `query({ options: { outputFormat: { type: 'json_schema', schema } } })`, result read from `msg.structured_output` |
| OpenCode | `session.prompt({ format: { type: 'json_schema', schema } })` |

**[V]** The docs' own adapter capability table agrees (Claude Code, Codex, OpenCode all support
structured output; Cursor, fx, and Pi do not) `[DOC]` `docs/ai-sdk-harnesses/harness-adapters`.

**[V]** On the `HarnessAgent` surface this is reached through `settings.output`, which is converted
to a `responseFormat` in `HarnessAgent._resolveResponseFormat` `[SRC]`
`packages/harness/src/agent/harness-agent.ts`. In practice that means `Output.object({ schema })`
works on all three and `Output.text()` degenerates to `{ type: 'text' }`.

**[I]** This is the single most important finding for Reprove: **a schema-constrained finding list
is portable across all three harnesses today.** The `ReviewAgent` contract can require structured
output without excluding Claude Code or OpenCode.

### Built-in tool control: the sharpest divergence

**[V]** Codex refuses both controls at `doStart` time, before any turn runs:

```ts
supportsBuiltinToolApprovals: false,
// ...
if (startOpts.builtinToolFiltering != null) {
  throw new HarnessCapabilityUnsupportedError({
    message: "Harness 'codex' does not support built-in tool filtering controls.",
    harnessId: 'codex',
  });
}
if (startOpts.permissionMode != null && startOpts.permissionMode !== 'allow-all') {
  throw new HarnessCapabilityUnsupportedError({
    message: "Harness 'codex' does not support built-in tool approval requests; use permissionMode: 'allow-all'.",
    harnessId: 'codex',
  });
}
```

`[SRC]` `@ai-sdk/harness-codex@1.0.95` → `src/codex-harness.ts:204-230`. The docs say the same:
"Codex does not currently support built-in tool approval requests. Use `permissionMode: 'allow-all'`
with this adapter." and "filtering Codex built-ins such as `bash` or `webSearch` will throw."
`[DOC]` `providers/ai-sdk-harnesses/codex`, Known Limitations.

**[V]** Claude Code declares both (`supportsBuiltinToolApprovals: true`,
`supportsBuiltinToolFiltering: true`) and passes `tools` / `disallowedTools` straight to the Agent
SDK `[SRC]` `src/claude-code-harness.ts:829-830`, `src/bridge/index.ts`.

**[V]** OpenCode declares `supportsBuiltinToolApprovals: true` but **not**
`supportsBuiltinToolFiltering`. Per the spec doc-comment, that combination means the framework
routes inactive built-in calls through the approval path and auto-denies them:

> Adapters without native filtering can still support `activeTools` and `inactiveTools` for built-ins
> when `supportsBuiltinToolApprovals` is `true`: the framework routes inactive built-in tool calls
> through the approval path and auto-denies them before they execute.

`[DTS]` `@ai-sdk/harness@1.0.93` → `dist/index.d.ts`. The OpenCode bridge additionally flips the
matching entries in OpenCode's own `permission` map to `'ask'` `[SRC]` `src/bridge/index.ts`. Hence
**partial**: the model still sees and can call the tool, it is just refused. Docs label this
"via auto-rejection" `[DOC]` `docs/ai-sdk-harnesses/harness-adapters`.

**[V]** The framework default is permissive: `DEFAULT_PERMISSION_MODE: HarnessV1PermissionMode =
'allow-all'` `[SRC]` `packages/harness/src/agent/internal/permission-mode.ts`. **[I]** So the
out-of-the-box posture is "the agent may read, edit, and run shell commands unattended," which is
fine inside a disposable sandbox and not fine anywhere else.

### MCP on Codex is only nominally supported

**[V]** All three adapters accept `mcpServers?: Record<string, unknown>` and Codex does forward it
(`codexConfig.mcp_servers = start.mcpServers`). But the Codex bridge documents that this does not
reliably work:

> Known limitation: codex CLI does not reliably surface MCP tools to the model in
> `codex exec --experimental-json` mode (the path the `@openai/codex-sdk` uses). Some versions do
> not register MCP tools at all; others expose the tool names but pass empty arguments.
>
> Until that's fixed, host tools are made available to the model via a separate CLI-relay workaround

`[SRC]` `@ai-sdk/harness-codex@1.0.95` → `src/bridge/index.ts`. Host-defined tools therefore reach
Codex through a generated shell shim that POSTs to a loopback HTTP relay, not through MCP. Claude
Code and OpenCode both register host tools as an MCP server literally named `harness-tools`
`[SRC]` their respective `src/bridge/index.ts`.

**[I]** A caller-supplied MCP server (say, a GitHub MCP server) is verified-working on Claude Code
and OpenCode and best-effort on Codex. Do not build a required Reprove capability on MCP-on-Codex.

### Repo-level config files: picked up, and not suppressible

**[V]** The Claude Code bridge calls `claudeSdk.query({ options: { systemPrompt:
createClaudeCodeSystemPrompt(start.instructions), ... } })` and **never sets `settingSources`**
`[SRC]` `src/bridge/index.ts`. In the pinned `@anthropic-ai/claude-agent-sdk@0.3.245` the semantics
of that omission are explicit:

```
* Control which filesystem settings to load.
* - 'user' - Global user settings (`~/.claude/settings.json`)
* - 'project' - Project settings (`.claude/settings.json`)
* - 'local' - Local settings (`.claude/settings.local.json`)
*
* When omitted, all sources are loaded (matches CLI defaults).
* Pass [] to disable filesystem settings (SDK isolation mode).
* Must include 'project' to load CLAUDE.md files.
```

`[V][SRC]` `@anthropic-ai/claude-agent-sdk@0.3.245` → `sdk.d.ts`. So **`CLAUDE.md` and
`.claude/settings.json` in the checked-out repo are loaded**, and `ClaudeCodeHarnessSettings` exposes
no `settingSources` passthrough to turn that off. This is worth flagging: a hostile PR can add a
`CLAUDE.md` and influence the reviewer's system prompt.

**[I]** Codex reads `AGENTS.md` from its working directory as normal Codex CLI behaviour, and
OpenCode reads `AGENTS.md` as normal OpenCode behaviour. Neither adapter passes a suppression flag,
and neither exposes one. This is inference from the absence of any suppression in the adapter source
plus the known default behaviour of those CLIs; it was **not** confirmed against Codex or OpenCode
CLI documentation in this pass. **Treat "the repo can inject instructions into the reviewer" as a
live threat on all three until tested.**

Custom `skills` are written to disk by the adapter and are a separate, controlled channel:
`$HOME/.agents/skills` for Codex and OpenCode, `$HOME/.claude/skills` for Claude Code
`[SRC]` respective `*-harness.ts`. Claude Code additionally passes `skills: 'all'` so that writing
project skills does not hide the bundled defaults `[SRC]` `src/bridge/claude-skills-option.ts`.

### Codex loses its thread when instructions change

**[V]** Between turns, the Codex adapter fingerprints instructions + tools, and if the fingerprint
or the skill set changed it starts a **fresh native thread**:

```ts
/*
 * `codex exec resume` retains the native thread's original developer
 * instructions and skill catalog. A fresh native thread is therefore
 * required for replacement semantics.
 */
```

`[SRC]` `@ai-sdk/harness-codex@1.0.95` → `src/codex-harness.ts:790`. No equivalent fingerprint or
restart exists in the Claude Code or OpenCode adapters (grep for `fingerprint` / `restartThread`
returns nothing in either).

**[I]** For a multi-turn review (for example: review, then "now re-check against this extra rule"),
changing `instructions` mid-session silently discards Codex's conversation history while Claude Code
and OpenCode keep theirs. A `ReviewAgent` that varies instructions per turn will behave differently
on Codex. Prefer: fix instructions at session creation, vary only the prompt.

### `file-change` is missing on Claude Code

**[V]** The `file-change` stream part is emitted by the Codex and OpenCode bridges only
(`create-emit-stream-event.ts` in each). A grep for `file-change` across the entire published
`@ai-sdk/harness-claude-code@1.0.97` (both `dist/index.js` and `dist/bridge/index.mjs`) returns
nothing.

**[V]** The Codex doc page adds a wrinkle: "Codex file changes may also appear as dynamic fileChange
tool parts because some Codex file mutations do not originate from a visible model-callable tool."
`[DOC]` `providers/ai-sdk-harnesses/codex`.

**[I]** For Reprove this mostly does not matter (review mode does not write), but it does matter for
the reserved fix-mode shape in the map: you cannot rely on `file-change` events to learn what a
Claude Code session mutated. Use a git diff of the workspace instead.

### Compaction and steering

**[V]** Codex `doCompact` unconditionally throws:

> Codex compacts its context automatically inside the core turn loop (~90% of the model context
> window), but the `codex exec` transport this adapter drives exposes no manual compaction trigger
> and emits no compaction event.

`[SRC]` `src/codex-harness.ts:1106`. Claude Code implements it by sending `/compact` on the
user-message rail `[SRC]` `src/claude-code-harness.ts:1830`. OpenCode supports it **only between
turns and only without custom instructions**, throwing otherwise `[SRC]`
`src/opencode-harness.ts:1088`.

**[V]** `submitUserMessage` (the plumbing behind `agent.experimental_steer`) is implemented in the
Claude Code and OpenCode adapters and absent from Codex.

### Cancellation and lifecycle are genuinely uniform

**[V]** `HarnessV1Session` requires `doPromptTurn`, `doCompact`, `doContinueTurn`, `doSuspendTurn`,
`doDetach`, `doStop`, `doDestroy` on every adapter, and `abortSignal` is present on
`HarnessV1StartOptions`, `HarnessV1PromptTurnOptions`, and `HarnessV1ContinueTurnOptions` `[DTS]`.
The spec is explicit that the contract is uniform even where the guarantee differs:

> Required on every adapter. The behaviour an adapter can guarantee follows from its architecture;
> the contract is uniform.

`[DTS]` `@ai-sdk/harness@1.0.93` on `doContinueTurn`. All three adapters classify their on-disk
event log to choose `'replay'` (lossless attach) or `'rerun'` (lossy re-drive) on continuation
`[SRC]` `classifyDiskLog` used in all three `*-harness.ts`.

**[V]** There is no timeout option on any adapter. `ClaudeCodeHarnessSettings.maxTurns` caps
*internal turns*, not wall-clock. `startupTimeoutMs` (all three, default 120000) only bounds waiting
for the bridge to advertise its port. **[I]** Reprove must own wall-clock budget via `AbortSignal`
plus the sandbox's own timeout.

---

## Full options surface

### Shared by all three adapters

`auth`, `credentialForwarding`, `mcpServers`, `model` (deprecated in favour of the agent-level one),
`port`, `portEndpoint`, `startupTimeoutMs`, `mintBridgeToken`. `[DTS]` all three `dist/index.d.ts`.

### Adapter-specific

| Adapter | Options unique to it |
| --- | --- |
| Codex | `codexConfig` (raw Codex snake_case config passthrough), `reasoningEffort: 'low'\|'medium'\|'high'`, `webSearch: boolean` |
| Claude Code | `maxTurns`, `env`, `thinking: { type: 'adaptive'\|'enabled'\|'disabled', display?: 'summarized'\|'omitted' }`, `effort: 'low'\|'medium'\|'high'\|'xhigh'\|'max'` |
| OpenCode | `openCodeConfig` (raw OpenCode config passthrough), `provider: string`, `reasoningVariant: string` |

### Framework-level (`HarnessAgentSettings`, common to every harness)

`harness`, `id`, `model`, `tools`, `skills`, `instructions`, `callOptionsSchema`, `prepareCall`,
`output`, `stopWhen`, `permissionMode`, `toolApproval`, `activeTools` **xor** `inactiveTools`,
`sandbox`, `sandboxConfig` (`workDir`, `bootstrapHash`, `onBootstrap`, `onSession`), `telemetry`,
`debug`, `onLog`. `[DTS]` `@ai-sdk/harness@1.0.93` → `dist/agent/index.d.ts`.

**[I]** This framework layer is where the genuinely common surface lives. The three adapter option
bags are *not* a common surface and should not be unioned into one Reprove config type.

---

## Sandbox integration

**[V]** `HarnessV1SandboxProvider` is a small, fully public interface: `specificationVersion:
'harness-sandbox-v1'`, `providerId`, `createSession({ sessionId?, abortSignal?, identity?,
onFirstCreate? })`, and an optional `resumeSession({ sessionId, abortSignal })`. It returns a
`HarnessV1NetworkSandboxSession`, which `extends Experimental_SandboxSession` from
`@ai-sdk/provider-utils` and adds `id`, `defaultWorkingDirectory`, `ports`, `getPortEndpoint`,
`stop`, `destroy`, `restricted()`, plus four **optional** infra methods: `setNetworkPolicy`,
`setRequestTransformations`, `addRequestTransformations`, `setPorts`. `[DTS]` `@ai-sdk/harness@1.0.93`.

**[I] It is implementable outside Vercel.** Nothing in the interface is Vercel-specific; the spec's
own doc-comments repeatedly name a second implementation, "just-bash," as the example of a provider
that omits `setNetworkPolicy`, `setPorts`, and `resumeSession`. The costs of omitting them are
stated: no resume ("the harness throws `HarnessCapabilityUnsupportedError` when resume is attempted"),
no port exposure (which all three adapters require, since they are all WebSocket-bridge adapters),
and no credential brokering.

**[V] Credential brokering is the security-relevant part.** When the sandbox session implements
`addRequestTransformations`, the adapter puts a *placeholder* in the sandbox environment and installs
a host-side rule that swaps the real credential into the outbound request after it leaves the
sandbox:

```ts
if ('addRequestTransformations' in sandboxSession && sandboxSession.addRequestTransformations != null) {
  sandboxCredentialEnvironment = ... createSandboxCredentialEnvironment({ ... });
  const requestTransformations = createCodexRequestTransformations({ ... });
  if (requestTransformations.length > 0) {
    await sandboxSession.addRequestTransformations(requestTransformations);
  }
  credentialsBrokered = true;
} else {
  warnCredentialBrokeringUnavailable();
}
```

`[SRC]` `src/codex-harness.ts:274-316`; the same pattern is in the Claude Code and OpenCode adapters.
The fallback warning is explicit: "The sandbox implementation does not support configuring request
transformations, so credential brokering does not work. Falling back to less secure credential
forwarding." `[SRC]` `packages/harness/src/utils/sandbox-credential-brokering.ts`.

**[I]** This is directly load-bearing for Reprove's self-hosted-worker story. A custom sandbox
provider that does **not** implement `addRequestTransformations` puts the raw API key in the same
process environment as untrusted PR code. Any Reprove-authored provider must implement it, or Reprove
must terminate the model connection itself.

**[V] Vercel provider specifics.** `createVercelSandbox()` takes either `{ sandbox }` (wrap an
existing sandbox, caller owns lifecycle, provider `stop()`/`destroy()` become no-ops) or the full
`Sandbox.create` parameter surface plus `name`. It defaults to `runtime: 'node24'` and a **30 minute**
timeout, overriding the `@vercel/sandbox` 5 minute default. It implements `resumeSession`, all four
optional infra methods, and uses `Sandbox.getOrCreate` to keep a named template snapshot keyed by the
adapter's bootstrap-recipe hash, forking an ephemeral sandbox per session. Auth failure message:
"Set VERCEL_OIDC_TOKEN, or pass token, teamId, and projectId to createVercelSandbox()."
`[SRC]` `@ai-sdk/sandbox-vercel@1.0.93` → `src/vercel-sandbox.ts`, `src/vercel-network-sandbox-session.ts`.

**[V] Bootstrap cost.** Each adapter's bootstrap writes a bridge bundle plus a `package.json` and
pinned `pnpm-lock.yaml` into the sandbox and runs `pnpm install --frozen-lockfile`. The pinned
runtime dependencies are:

| Adapter | Installed in the sandbox |
| --- | --- |
| Codex | `@openai/codex-sdk@0.149.1`, `ws@8.21.0` |
| Claude Code | `@anthropic-ai/claude-agent-sdk@0.3.245`, `@anthropic-ai/claude-code@2.1.245`, `@modelcontextprotocol/sdk@1.30.0`, `ws@8.21.0`, `zod@4.4.3` |
| OpenCode | `@opencode-ai/sdk@1.18.23`, `opencode-ai@1.18.23`, `@modelcontextprotocol/sdk@1.29.0`, `ws@8.21.0`, `zod@3.25.76` |

`[V]` from `dist/bridge/package.json` in each tarball. **[I]** The sandbox needs npm-registry egress
at bootstrap; `prepareHarnessSandboxTemplate()` exists precisely to pay that cost once in CI and
snapshot the result `[V][DTS]`.

---

## Version and stability risk

**[V][NPM]** `@ai-sdk/harness` has 127 published versions. `1.0.0` landed **2026-06-25**; `1.0.93`
landed **2026-08-28**. That is **99 releases in 64 days, about 10.8 per week**, all on a single
`1.0.x` line. No `1.1` and no `2.0` yet.

**[V][DOC]** Every harness page carries: "Harness packages are **experimental**. Expect breaking
changes between releases as this early API gets further refined."

**[V]** Breaking or shape-changing things that have already happened on the `1.0.x` line, from the
`vercel/ai` changelogs:

- `e0d7cfb` (~1.0.92): added isolated-environment `auth`, and "remove support for the formerly
  deprecated legacy auth options types." A removal shipped as a patch.
- `7608210` (1.0.93 / .95 / .97, the current release): moved `model` onto `HarnessAgent` "instead of
  having each harness adapter support it on their own constructor functions." This is one day old as
  of this research and the per-adapter docs have not caught up.
- `52bc889`: `getPortUrl()` deprecated in favour of `getPortEndpoint()`.
- `b2f553b` (codex): "route Codex host tools through the CLI relay only instead of registering them
  as MCP tools."

**[V]** Deprecations already visible in the current `.d.ts`: `model` on all three adapter settings,
`getPortUrl`, `onSandboxSession`, `prewarmHarness`. Experimental-prefixed public API:
`experimental_steer`, `experimental_steerTurn`, `experimental_sandbox`,
`experimental_userMessageResponses`, and the whole `Experimental_SandboxSession` base type.

**[V] Version coupling is strict.** `@ai-sdk/harness@1.0.93` depends on `ai@7.0.84`,
`@ai-sdk/provider@4.0.8`, `@ai-sdk/provider-utils@5.0.33` at **exact** versions, and each adapter
depends on `@ai-sdk/harness@1.0.93` exactly. `engines.node >= 22`.

**[I] Recommended posture for Reprove.**

1. Pin all five packages to exact versions in the lockfile and bump them deliberately as one set.
   Because the adapters exact-pin `@ai-sdk/harness`, a partial bump either fails to resolve or
   duplicates the framework.
2. Keep the harness types out of Reprove's own domain types. Anything with `HarnessV1` or
   `experimental_` in its name should appear only inside the adapter layer.
3. Budget for a regular upgrade tax. Roughly 11 releases a week with removals shipped as patches
   means an unattended `^` range is not safe here.

---

## Where the three genuinely diverge

These are the seams. Anything in this list must stay **adapter-specific** rather than being pushed
into a common `ReviewAgent` interface.

1. **Tool permission and filtering.** Codex is all-or-nothing (`allow-all`, no filtering, throws on
   anything else). Claude Code is fully controllable. OpenCode is controllable but enforces filtering
   by auto-denial rather than by hiding tools. A common `ReviewAgent` cannot promise "restrict the
   agent to read-only tools" on all three.
2. **The adapter option bags.** `codexConfig` / `reasoningEffort` / `webSearch` vs
   `thinking` / `effort` / `maxTurns` / `env` vs `openCodeConfig` / `provider` / `reasoningVariant`.
   These have no common shape and should be exposed as an opaque per-harness escape hatch in Reprove
   config, not normalised.
3. **Auth mode vocabulary.** `'direct'` on Codex and Claude Code vs `'anthropic'` / `'openai'` on
   OpenCode. The shared vocabulary is only `'auto' | 'ai-gateway' | Record<string,string>`.
4. **Instruction mutability across turns.** Codex restarts its native thread when instructions,
   tools, or skills change; the other two do not.
5. **Stream part coverage.** `file-change` (no Claude Code), `compaction` (no Codex),
   `tool-approval-request` (no Codex), `stream-start.modelId` (no Codex).
6. **Cost.** Only Claude Code reports USD.
7. **Compaction and steering.** Codex supports neither.
8. **Model id namespace.** OpenCode wants provider-qualified ids; Codex qualifies only under the AI
   Gateway; Claude Code does not qualify at all.

## What is genuinely common

Enough to draw a real abstraction:

- Session lifecycle: create, prompt, suspend/continue, detach, stop, destroy, resume across
  processes, all with `abortSignal`.
- A single opaque `model` string chosen per session.
- `instructions`, `skills`, and host-executed `tools` as framework-level settings applied per turn.
- Schema-backed structured output.
- Token usage on `finish`.
- `text`, `reasoning`, `tool-call`, `tool-result`, `error`, and `raw` stream parts.
- A sandbox provider seam with credential brokering.
- `HarnessCapabilityUnsupportedError` as the uniform signal for "this adapter cannot do that."

**[I] Implication for `ReviewAgent`.** The seam that exists is roughly: *"run one schema-constrained
turn, in a sandbox that holds the checked-out PR, against a caller-chosen model string, with
caller-supplied instructions/skills/tools, streaming text and tool activity, returning a validated
finding list plus token usage."* Everything in the divergence list above should sit behind a
per-harness capability descriptor that Reprove owns (something like
`{ canRestrictBuiltinTools, reportsCost, reportsFileChanges, supportsSteering, ... }`) rather than
behind optional methods that silently do nothing. `HarnessCapabilityUnsupportedError` is throw-time,
not ask-time, so Reprove needs its own ask-time capability table if it wants to refuse a
configuration up front instead of failing mid-review.

## Open questions and things not verified

- **[U]** Whether `AGENTS.md` is actually consumed by Codex and OpenCode under these bridges, and
  whether it can be suppressed at all. Needs an empirical test, not more reading. This is a security
  question, not a convenience one.
- **[U]** Whether a Claude subscription OAuth token injected via `ClaudeCodeHarnessSettings.env`
  works end to end, and what it does to `costUsd` reporting. Almost certainly not something Reprove
  should do inside a shared sandbox regardless.
- **[U]** Actual bootstrap wall-clock cost and snapshot warm-start latency on Vercel Sandbox for each
  of the three adapters. Relevant to the hosted-orchestration ticket.
- **[U]** How `stopWhen` interacts with a review turn in practice, and whether a Codex thread restart
  triggered by an instruction change is observable to the caller.
- **[U]** Whether the docs' claim that OpenCode supports built-in tool filtering "via auto-rejection"
  produces a usable reviewer, or whether the model wastes turns calling denied tools.

## Reproducing this

```sh
mkdir -p /tmp/harness && cd /tmp/harness
for p in harness harness-codex harness-claude-code harness-opencode sandbox-vercel; do
  mkdir -p "$p" && (cd "$p" && npm pack "@ai-sdk/$p" && tar xzf *.tgz)
done
# every dist/*.js.map carries full sourcesContent; extract it to read the real TypeScript
```
