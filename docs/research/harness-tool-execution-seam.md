# Can the credential-holding process be separated from the repo-executing process?

Research for [#3](https://github.com/nick-neely/reprove/issues/3) (child of the foundation map [#1](https://github.com/nick-neely/reprove/issues/1)).
Investigated 2026-08-29. Every version number and quote below was checked on that date; do not trust it after ~2026-10 without re-verification (see [API stability risk](#api-stability-risk)).

Each claim is tagged **[V]** verified (URL, quote from a primary source, source code read, or a command actually run) or **[I]** inferred (reasoning from verified facts, labelled as such).

---

## 1. Verdict

**Option (a) - the harness runs on the worker holding the credential, and its tool calls are proxied outward into a credential-free sandbox holding the repo - is not a foundation Reprove can stand on. Do not build on it.**

The honest breakdown, because "no" is too coarse:

- **Claude Code: no seam. [V]** Bash, Read, Edit, and Write execute in the process that holds the Anthropic credential. The permission system - `permissions.allow/deny`, `PreToolUse` hooks, the Agent SDK's `canUseTool` - can only allow, deny, ask, defer, or rewrite the *input*. No documented return shape substitutes a tool *result*. It is a gate, never a router.
- **OpenCode: no seam, and no sandbox at all. [V]** The server process spawns the shell and calls the model from the same Effect graph, and `SECURITY.md` says outright: *"OpenCode does **not** sandbox the agent ... it is not designed to provide security isolation."*
- **Codex CLI: a seam exists, and you still should not use it. [V]** `codex exec-server` is a real JSON-RPC process/filesystem service; with `environments.toml` setting `include_local = false`, the shell tool and `apply_patch` route to a remote executor while the agent and its credential stay behind. That is literally option (a). It is also marked `[EXPERIMENTAL]`, is **absent from every public doc page** (`environments.toml` and `CODEX_EXEC_SERVER_URL` appear nowhere in the config reference or `llms.txt`), and its default `ws://` listener is **unauthenticated** - a `ws://0.0.0.0:PORT` exec-server is open remote code execution. It also solves the problem for one of the three harnesses the map has committed to, which is the wrong shape for an abstraction that has to cover all three.
- **`@ai-sdk/harness` - the layer already settled in #1 - goes the other way. [V]** A sandbox session is *mandatory*; the coding-agent CLI is installed and spawned **inside** it. There is no mode where the CLI runs in the host process. Building (a) means leaving the harness layer entirely.

**The goal behind (a) is achievable, and the answer is better than (a) would have been.** `@ai-sdk/harness` inverts the arrangement: the agent CLI, the repo, and anything the repo executes all live inside the sandbox together with a **randomly generated placeholder credential**, while the real API key stays on the host and is spliced into outbound requests by an egress proxy outside the sandbox boundary. Untrusted PR code that reads every file and environment variable in its box finds `aisdkhc_<43 chars of base64url>` and nothing else.

That is the "credential broker" bullet already listed in `docs/prd.md` §23 (§24 when this note was written; the PRD renumbered in [#9](https://github.com/nick-neely/reprove/issues/9)). The PRD's drawn "potential architecture" (agent outside, restricted tool bridge inward) is the one alternative in that list that does not exist off the shelf. **Strike it and adopt the broker.**

Three things this does not fix, all load-bearing:

1. **[V]** Brokering is API-key-only. No adapter reads `~/.codex/auth.json` or a Claude OAuth cache. **[I]** A ChatGPT or Claude *subscription* seat cannot be driven through `@ai-sdk/harness` at all, which contradicts the map's "orchestrate the agents you already authenticated" framing. See §7.
2. **[I]** Brokering stops *exfiltration*, not *in-place abuse*. Nothing binds a transformation rule to a process; code inside the sandbox that finds the placeholder can spend the key from inside, for the sandbox's lifetime. See §8.
3. **[V]** OpenAI states the residual threat model in its own words: *"Do not set `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable in workflows that check out or run repository-controlled code. Build scripts, tests, dependency lifecycle hooks, or a compromised action in the same job can read those environment variables."* Reprove's job description is exactly that workflow.

---

## 2. What the question actually turns on

There are two distinct seams, and option (a) conflates them:

| Seam | Where the boundary is | Who ships it |
| --- | --- | --- |
| **Tool-execution seam** - agent loop here, tools execute there | Between the model loop and the shell | Custom agent loops (AI SDK `tool()`, eve); `codex exec-server` (experimental). **Not** Claude Code, **not** OpenCode. |
| **Credential seam** - agent and tools run together, the secret lives elsewhere | Between the sandbox and the network | `@ai-sdk/harness`, Vercel Sandbox, Claude Code `sandbox.credentials`, Codex `network_proxy` + `responses-api-proxy` |

**[V]** The tool-execution seam is real and shipping - for agents you write yourself. Vercel's own agent framework `eve` documents it plainly: *"Only shell commands execute in the sandbox. Even the built-in `bash`/`read_file`/`write_file` tools live in the app runtime and **proxy** into the sandbox."* and *"It gets its own `/workspace` filesystem, but no `process.env`, no secrets."* ([eve.dev/docs/concepts/security-model](https://eve.dev/docs/concepts/security-model)). Vercel's ecosystem page describes the same shape for LangChain, the OpenAI SDK, the Anthropic SDK, and the AI SDK: *"define a `run_code` tool backed by `sandbox.runCommand()`, pass it to the framework's tool-calling loop"* ([vercel.com/docs/sandbox/ecosystem](https://vercel.com/docs/sandbox/ecosystem)).

**[V]** That same page lists coding agents separately (Devin, Herdr, Hermes) - and there the pattern inverts: the agent runs inside the microVM, credential included. Vercel's Herdr guide: *"Your home directory, SSH keys, shell environment, and Vercel CLI login stay on your machine. The agent authenticates inside the Sandbox, and that login is stored on the Sandbox disk."*

**[I]** The dividing line is ownership of the tool loop. When you own the loop, `execute()` goes wherever you like. When you drive a packaged CLI agent, the CLI owns its loop. Reprove has chosen packaged CLI agents; that choice is what forecloses (a) as a general answer.

---

## 3. `@ai-sdk/harness`: the decisive finding

Verified by downloading and reading the published tarballs (which ship full `src/*.ts`), independently of the GitHub tree.

### 3.1 Versions **[V]**

`npm view`, 2026-08-29:

| Package | Version | Published |
| --- | --- | --- |
| `@ai-sdk/harness` | 1.0.93 | 2026-08-28T17:25:37Z |
| `@ai-sdk/harness-codex` | 1.0.95 | 2026-08-28T17:25:41Z |
| `@ai-sdk/harness-claude-code` | 1.0.97 | 2026-08-28T17:25:37Z |
| `@ai-sdk/harness-opencode` | 1.0.95 | 2026-08-28T17:25:43Z |
| `@ai-sdk/harness-acp` | 1.0.31 | 2026-08-28 |
| `@ai-sdk/sandbox-vercel` | 1.0.93 | 2026-08-28T17:26:00Z |
| `@ai-sdk/sandbox-just-bash` | 1.0.93 | 2026-08-28T17:25:59Z |

First stable `1.0.0`: 2026-06-25T12:47:38Z. The README still says *"This package is **experimental**."*

### 3.2 The sandbox is mandatory and the CLI runs inside it **[V]**

`HarnessV1StartOptions.sandboxSession` is non-optional, and `HarnessAgent.createSession` throws without one:

> `'HarnessAgent.createSession: configure `sandbox` on HarnessAgent or pass `sandboxSession` to createSession().'`

Docs agree at a higher level: *"all AI SDK agent harnesses operate in a sandbox, keeping the host environment safe"* ([ai-sdk.dev/docs/ai-sdk-harnesses/overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)).

The Codex adapter writes a bridge into the sandbox, `pnpm install`s inside it, and spawns it through the sandbox session (`ai-sdk-harness-codex-1.0.95/src/codex-harness.ts:471`):

```ts
const proc = await toolSafeSandboxSession.spawn({
  command: `node ${shellQuote(`${bootstrapDir}/bridge.mjs`)} --workdir ${shellQuote(workDir)} ...`,
  env,
  abortSignal: startOpts.abortSignal,
});
```

The provider docs confirm: *"The adapter runs a bridge inside the sandbox and streams Codex thread events back to the host over a sandbox-exposed WebSocket."* ([ai-sdk.dev/providers/ai-sdk-harnesses/codex](https://ai-sdk.dev/providers/ai-sdk-harnesses/codex)). `@ai-sdk/harness-acp` does the same (`src/v1/acp-v1-harness.ts:595`).

**[V]** Adapter families differ and the difference matters: `codex`, `claude-code`, `opencode`, `deepagents` use the in-sandbox bridge; `cursor`, `fx`, `grok-build` use in-sandbox ACP; **`pi` and `cline` run the agent in the host Node.js process**. Reprove's three are all in the safe family. Never add `pi` or `cline` without revisiting this.

### 3.3 Credential brokering **[V]**

`ai-sdk-harness-1.0.93/src/utils/sandbox-credential-brokering.ts`, read verbatim from the tarball:

```ts
const SANDBOX_CREDENTIAL_PLACEHOLDER_PREFIX = 'aisdkhc_';

export function generateSandboxCredentialPlaceholder(): string {
  return `${SANDBOX_CREDENTIAL_PLACEHOLDER_PREFIX}${randomBytes(32).toString('base64url')}`;
}
```

The interface contract, from `src/v1/harness-v1-network-sandbox-session.ts`:

> *"Outbound HTTPS request transformation applied outside the sandbox security boundary. ... Credential values belong in `transform.headers`, while the sandbox process receives only a non-secret placeholder. Implementations must overwrite matching request headers after the request leaves the sandbox rather than making transformed values available inside it."*

The Codex wiring (`harness-codex/src/codex-auth.ts`) matches on the placeholder and transforms to the real key:

```ts
matchHeaders:     { Authorization: `Bearer ${sandboxEnvironment.CODEX_API_KEY}` },  // placeholder
transformHeaders: { Authorization: `Bearer ${environment.CODEX_API_KEY}` },         // real key
```

Claude Code does the same for `x-api-key` and `Authorization` (`harness-claude-code/src/claude-code-auth.ts`); OpenCode has the identical branch (`opencode-harness.ts:312`).

The sandbox-side interface is a plain structural type with no Vercel coupling:

```ts
readonly setNetworkPolicy?: (policy: HarnessV1NetworkPolicy) => PromiseLike<void>;
readonly setRequestTransformations?: (t: ReadonlyArray<HarnessV1RequestTransformation>) => PromiseLike<void>;
readonly addRequestTransformations?: (t: ReadonlyArray<HarnessV1RequestTransformation>) => PromiseLike<void>;
readonly restricted: () => SandboxSession;

type HarnessV1NetworkPolicy =
  | { mode: 'allow-all' } | { mode: 'deny-all' }
  | { mode: 'custom'; allowedHosts: ReadonlyArray<string>; allowedCIDRs?: ...; deniedCIDRs?: ... }
  | { mode: 'custom'; allowedHosts?: ...; allowedCIDRs: ReadonlyArray<string>; deniedCIDRs?: ... };
```

`restricted()` is documented as *"Reduced view of this session ... nothing that could stop the sandbox or change its network policy. Pass this to user-tool `execute()` calls."*

### 3.4 The silent downgrade - the single biggest operational trap **[V]**

Brokering is conditional. `codex-harness.ts:274-315`:

```ts
if ('addRequestTransformations' in sandboxSession && sandboxSession.addRequestTransformations != null) {
  /* placeholder into the sandbox, real key into the transformation */
  credentialsBrokered = true;
} else {
  warnCredentialBrokeringUnavailable();
}
```

and `warnCredentialBrokeringUnavailable()` is only:

```ts
console.warn('The sandbox implementation does not support configuring request transformations, so credential brokering does not work. Falling back to less secure credential forwarding.');
```

In that branch `codex-harness.ts:439` forwards `sandboxAuthEnvironment`, which still holds the **real** key, straight into the sandbox process env. **A `console.warn` is the only thing between you and shipping a live API key into a box running attacker-controlled `postinstall` scripts.** There is no config flag to make brokering mandatory.

Sandbox-provider support, checked package by package on 2026-08-29:

| Provider | `addRequestTransformations` | Consequence |
| --- | --- | --- |
| `@ai-sdk/sandbox-vercel` 1.0.93 | **[V]** yes | brokered |
| `@e2b/ai-sdk-sandbox` 0.3.0 | **[V]** yes - changelog: *"Harness adapters ... now broker credentials at the egress proxy instead of forwarding real API keys into the sandbox."* | brokered |
| `@coder/ai-sdk-sandbox` 0.4.6 | **[V]** no - README: *"`setNetworkPolicy` is not implemented (omitted) - egress is governed by your Coder template/deployment, not this provider."* | **real key into the sandbox, silently** |
| `@ai-sdk/sandbox-just-bash` 1.0.93 | **[V]** no (also cannot expose ports, so bridge adapters reject it) | n/a |

**Mitigation [V]:** every adapter takes a `credentialForwarding` callback, invoked with the value about to enter the sandbox, and `@ai-sdk/harness/utils` exports `isSandboxCredentialPlaceholder()`. A three-line guard converts the silent downgrade into a hard failure:

```ts
credentialForwarding: ({ credential, environmentVariableName }) => {
  if (!isSandboxCredentialPlaceholder(credential)) {
    throw new Error(`refusing to forward a real ${environmentVariableName} into the sandbox`);
  }
  return credential;
},
```

**[I]** Reprove should ship this in its harness wrapper and treat it as non-negotiable, because the failure is otherwise invisible in logs anyone actually reads.

### 3.5 The host-side attack surface nobody asks about **[V]**

Tool traffic flows the *opposite* way from what option (a) assumed. `harness-agent.ts:156`:

> *"**Host tool execution.** User tools passed in `settings.tools` are executed on the host whenever the underlying runtime calls them; the result is fed back to the harness via `submitToolResult`. **Adapter builtin tools (e.g. Claude Code's `Bash`) pass through untouched.**"*

Mechanically: an in-sandbox loopback relay (`bridge/tool-relay.ts`, `server.listen(0, '127.0.0.1')`) forwards a tool call over the WebSocket to the host, the host runs `tool.execute()`, and the result is relayed back. A `ToolRelayAuthorizer` with a 10-second TTL requires the host to have pre-authorized the exact `(toolName, canonicalJSON(input))` pair.

**[I]** So the only path by which attacker-influenced data reaches the credential-holding process is `settings.tools`. Keep it empty or trivially-validating, and do repo work through the `experimental_sandbox` handle (typed as the bare, `restricted()` `SandboxSession`) rather than host `fs` / `child_process`.

**[V]** There is no `onToolCall`, no tool middleware, and no transport option in `HarnessAgentSettings`. `onToolExecutionStart` / `experimental_onToolCallFinish` are observation points, explicitly `Omit`ted from what `prepareCall` can change. **[V]** Codex additionally refuses built-in tool approvals outright: `"Harness 'codex' does not support built-in tool approval requests; use permissionMode: 'allow-all'."`

---

## 4. The three CLIs, individually

### 4.1 Codex CLI

Checked against `openai/codex` at tag `rust-v0.151.0` (`@openai/codex@0.151.0`, current npm latest), with commands actually run on Linux/WSL2 with `bwrap` present.

**[V] Answering issue question 3 directly - what `--sandbox workspace-write` isolates: writes and network. Not reads.** The policy grants **full-disk read** in every non-`danger` mode. `codex-rs/protocol/src/protocol.rs:1199`:

```rust
pub fn has_full_disk_read_access(&self) -> bool {
    true
}
```

macOS (`sandboxing/src/seatbelt.rs:932`) emits `(allow file-read*)` when that is true; Linux (`linux-sandbox/src/bwrap.rs`) `--ro-bind`s `/` to `/`. Confirmed empirically:

```
$ codex sandbox -c sandbox_mode=workspace-write -- \
    /bin/sh -c 'test -r "$HOME/.codex/auth.json" && echo READABLE || echo NOT_READABLE'
READABLE
```

Same under `read-only`. **`--sandbox workspace-write` protects the filesystem from the agent; it does not protect the credential from workspace code.** The `.git` / `.codex` / `.agents` "protected paths" you will read about in the docs are **write** carve-outs *inside the writable root* - they have nothing to do with `$HOME/.codex`.

**[V]** Modes are `read-only`, `workspace-write`, `danger-full-access` (plus a wire-level `external-sandbox` not exposed via `--sandbox`). `--full-auto` is gone; `codex debug seatbelt|landlock` is now `codex sandbox`. Linux enforcement is **bwrap + seccomp** by default, with Landlock only behind `--use-legacy-landlock`. The sandbox wraps the *child command*, never the Codex process itself.

**[V]** Network is off by default and verifiably so (`curl` → exit 6 under `workspace-write`; → 200 with `sandbox_workspace_write.network_access=true`). **[I]** That is a speed bump, not a fix: a sandboxed child can write a stolen credential into the writable workspace, where a later unsandboxed step - CI upload, artifact, the PR diff itself - carries it out.

**[V] Escalation is a full bypass.** On approval, `core/src/tools/orchestrator.rs:455` retries with `SandboxType::None`. With `--ask-for-approval never` the escalation is refused instead. **[I]** For untrusted PRs, `-a never` is mandatory; anything interactive is a social-engineering surface.

**[V] What `auth.json` actually is.** `login/src/auth/storage.rs:39-65` defines `AuthDotJson` with `OPENAI_API_KEY`, `tokens {id_token, access_token, refresh_token, account_id}`, `last_refresh`, `agent_identity` (which can hold a cleartext `agent_private_key`), `personal_access_token`, `bedrock_api_key`, `bedrock_access_keys`. The refresh token rotates in place against `https://auth.openai.com/oauth/token` on an 8-day interval. Stealing the file yields a durable, self-renewing account credential - not a short-lived token. Mode `0600` is set at creation only; a pre-existing loose-mode file stays loose.

**[V] OpenAI's warnings, verbatim.** From [learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth): *"If you use file-based storage, treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it, paste it into tickets, or share it in chat."* Stronger, from the CI/CD auth page: *"**Do not use this workflow for public or open-source repositories.**"* and *"This is an advanced workflow for enterprise and other trusted private automation. API keys are still the recommended option for most CI/CD jobs ... the runner is trusted private infrastructure."* And from the non-interactive-mode page: *"Do not set `OPENAI_API_KEY` or `CODEX_API_KEY` as a job-level environment variable in workflows that check out or run repository-controlled code."*

**[V] Env-var-only auth works, but the variable is `CODEX_API_KEY`.** `login/src/auth/manager.rs:1445-1462` returns an in-memory credential with no storage object; nothing writes `auth.json`. In 0.151.0 `OPENAI_API_KEY` is *not* an auth path for the main agent loop (the built-in provider sets `env_key: None`). `CODEX_API_KEY` is honored on `exec`, `review`, SDK, and `exec-server`; explicitly disabled on TUI, app-server, and mcp-server. ChatGPT-plan auth without the file requires `CODEX_ACCESS_TOKEN` (Business/Enterprise only), workload-identity federation, or `cli_auth_credentials_store = "keyring"` (which deletes `auth.json` after a successful keyring write). **[I]** A Plus/Pro `codex login` requires the on-disk file.

#### The mitigations that do work

**[V] Permission profiles deny reads.** `[permissions.<name>.filesystem]` maps paths to `read` / `write` / `deny`, where *"`deny` denies both reads and writes under the path"* and *"`deny` wins over equally specific `write` or `read` entries."* Special roots: `:root`, `:minimal`, `:workspace_roots`, `:tmpdir`, `:slash_tmp`, plus `~/path` and absolute paths. `:minimal` does not include `$HOME`. Verified working, including escape attempts:

```
$ codex sandbox -c 'default_permissions="ci"' \
    -c 'permissions.ci={extends=":workspace", filesystem={":root"="read", "~/.codex"="deny"}}' -- ...
AUTH_NOT_READABLE     # and /etc/passwd still readable, tooling still works
# via symlink:         Permission denied
# via /proc/self/root: denied
# via ..:              denied
```

It is a bwrap mask, not a path-string filter. OpenAI ships an equivalent example (`":root" = "deny"` + `":minimal" = "read"`). Caveats **[V]**: docs label profiles *"Beta ... under active development and may change"*; docs also say profiles and legacy `sandbox_mode` do **not** compose (*"Codex uses those older sandbox settings instead of `default_permissions`"*) though the observed `codex sandbox` behaviour contradicted that - **verify precedence yourself**; and `codex exec` has no `--permission-profile` flag, so you must set `default_permissions` via config or `-c`.

**[V] Egress control:** `features.network_proxy` constrains already-enabled command network access to a domain policy. The docs are careful that these are orthogonal - *"The feature changes how enabled network access is enforced; it does not grant network access by itself"* and *"Without an active proxy, profile domain rules do not restrict direct network access."* Defaults: `enabled = false`, `allow_local_binding = false`, `allow_upstream_proxy = true`. It does **not** filter web search, connectors, MCP servers, or browser/Computer-Use traffic.

**[V] `codex responses-api-proxy` is a first-party credential broker.** From its README: *"A strict HTTP proxy that only forwards `POST` requests to `/v1/responses` to the OpenAI API, injecting the `Authorization: Bearer $OPENAI_API_KEY` header. Everything else is rejected with `403 Forbidden`."* and *"designed to be run by a privileged user with access to `OPENAI_API_KEY` so that an unprivileged user cannot inspect or tamper with the process."* Key read from stdin, `mlock`ed, zeroized. **[I]** It protects an API key (not `auth.json`), prevents theft but not use - the loopback listener is unauthenticated, so PR code can still burn quota - and does not separate execution from the agent.

**[V] `codex exec-server` is the one genuine tool-execution seam among the three CLIs.** A JSON-RPC service (`process/start|read|write|terminate`, `fs/*`) over `ws://IP:PORT`, `stdio`, or `--remote URL --environment-id ID` across a Noise relay. The shell tool and `apply_patch` genuinely route through it (`core/src/unified_exec/process_manager.rs:1196,1206,1246`; `core/src/tools/runtimes/apply_patch.rs:161,175`). Configured via `$CODEX_HOME/environments.toml`:

```toml
default = "devbox"
include_local = false          # no local execution path at all

[[environments]]
id  = "devbox"
url = "ws://127.0.0.1:4512"
```

Nothing in its protocol carries `auth.json`. **[V]** But: it is `[EXPERIMENTAL]`; `environments.toml` and `CODEX_EXEC_SERVER_URL` appear in **no** public doc page, config reference, or `llms.txt`; and the plain `ws://` listener carries no authorization - only the Noise relay path does. **[I]** A `ws://0.0.0.0:PORT` exec-server is open RCE. Bind it to a private container network or not at all.

#### Two footguns that defeat the mitigations above

**[V] A repo-controlled `.codex/config.toml` can disable your sandbox.** `config/src/config_layer_source.rs:21` gives `ConfigLayerSource::Project` precedence **25**, above user config's **20**. The project-layer denylist blocks `openai_base_url`, `model_provider`, `notify`, `profile`, `otel` - but **not** `sandbox_mode`, `default_permissions`, `permissions`, or `approval_policy`. It is gated on directory trust, and both sides were confirmed empirically: untrusted → the project layer is ignored and the hardened profile holds; trusted → the PR's `sandbox_mode = "danger-full-access"` wins and the sandbox is gone. Worse, trust can be granted implicitly: `app-server/src/request_processors/thread_processor.rs:1334-1348` auto-marks a project trusted when no trust level is set and the effective permissions can write the cwd - so any workspace-write app-server session silently and permanently trusts the repo. **[V]** `codex exec` does not do this. **[I]** Rule: use `codex exec`, never pre-trust the PR checkout, and use a throwaway `CODEX_HOME` per run.

**[V] Secret-looking env vars are NOT filtered by default.** `config/src/shell_environment_policy.rs:136`: `let ignore_default_excludes = toml.ignore_default_excludes.unwrap_or(true);` - `true` means *ignore the excludes*, i.e. do not filter - and `inherit` defaults to `All`. Confirmed empirically: `CODEX_API_KEY`, `OPENAI_API_KEY`, and `GITHUB_TOKEN` all reached the sandboxed child intact. **So "use `CODEX_API_KEY` instead of `auth.json`" does not by itself help.** Both fixes verified: `shell_environment_policy.ignore_default_excludes=false` or `shell_environment_policy.inherit=core`.

**[V] The control that survives both** is managed `requirements.toml` (system path `/etc/codex/requirements.toml`): *"Admins can deny reads for exact paths or glob patterns with `[permissions.filesystem]`. **Users can't weaken these requirements with local configuration.**"* plus *"When deny-read requirements are present, the local runtime rejects full-access permissions."* Root-owned, outside the repo's reach. **Not empirically tested** (needs root) - verify before depending on it.

**[V] Codex Cloud sidesteps everything:** *"Runs in isolated OpenAI-managed containers... Secrets configured for cloud environments are available only during setup and are removed before the agent phase starts."* **[V]** And OpenAI's own devcontainer is the anti-pattern: `.devcontainer/devcontainer.secure.json` mounts `~/.codex` *and* passes `OPENAI_API_KEY` *and* sets `CODEX_UNSAFE_ALLOW_NO_SANDBOX=1`; the docs concede *"a malicious project can exfiltrate anything available inside the devcontainer, **including Codex credentials**."*

### 4.2 Claude Code

`@anthropic-ai/claude-code` 2.1.251, `@anthropic-ai/claude-agent-sdk` 0.3.251.

**[V] Where tools run:** same process, same host as the credential. `code.claude.com/docs/en/sandboxing.md`:

> *"The sandbox isolates Bash subprocesses. Other tools operate under different boundaries: **Built-in file tools**: Read, Edit, and Write use the permission system directly rather than running through the sandbox. **Environment variables**: sandboxed Bash commands inherit the parent process environment by default, including any credentials set there."*

and `sandbox-environments.md`: *"[the sandboxed Bash tool] restricts only Bash commands. Built-in file tools, MCP servers, and hooks still run directly on your host."*

**[V] Credentials on Linux:** `~/.claude/.credentials.json`, mode `0600`. Precedence: cloud provider creds → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN`. **[I]** `0600` defends against other users, not against the PR's own `postinstall` running as you - which is the entire threat.

**[I] `apiKeyHelper` is not an isolation boundary.** It is a shell command line stored in a settings file that Claude Code runs as the same user; repo code can read the setting and run the helper itself. It shortens credential lifetime (5-minute default TTL, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`); it does not move the secret.

**[V] The permission system cannot redirect a tool call.** `PreToolUse` hook output is `permissionDecision` (`allow` / `deny` / `ask` / `defer`), `permissionDecisionReason`, `updatedInput`, `additionalContext`. The Agent SDK `canUseTool` has the same shape:

```typescript
type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; ... }
  | { behavior: "deny"; message: string; interrupt?: boolean; ... };
```

**[I]** A `PreToolUse` HTTP hook could run the command remotely and smuggle output back through `permissionDecisionReason` (which is "shown to Claude" on deny). This abuses a denial channel as a result channel, makes every call look failed to the model, and is unsupported. Do not build on it.

**[V] Claude Code ships its own credential brokering.** `sandbox.credentials` takes `files` and `envVars` entries with `mode: "deny"` or `mode: "mask"`:

> *"With `mask`, the sandboxed command sees a per-session sentinel value instead of the real one. Each `mask` entry can list `injectHosts` ... When a request leaves the sandbox for one of them, the sandbox proxy replaces the sentinel with the real value. The command and anything it logs never hold the real credential, but its requests still authenticate."*

Masking requires `network.tlsTerminate` so the proxy can see request contents; *"Without it, masking fails without exposing anything."* File masking is Linux/WSL2 only (macOS falls back to `deny`). Requires v2.1.199+.

**[V] Defaults are dangerous and must be overridden:** *"**Default read behavior**: read access to the entire computer, except certain denied directories. Note that this default still allows reading credential files such as `~/.aws/credentials` and `~/.ssh/`."* and *"There is no built-in credential deny list, so only the files and variables you list are restricted."* The `~/.claude` "protected paths" list denies **writes**, not reads. Worse: *"By default, if the sandbox cannot start because dependencies are missing or the platform is unsupported, Claude Code shows a warning and runs commands without sandboxing."* Set `sandbox.failIfUnavailable: true`. Enforcement is Seatbelt on macOS, `bubblewrap` + `socat` on Linux/WSL2; native Windows is unsupported.

**[V] The strongest single knob:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` - *"strip Anthropic and cloud provider credentials from subprocess environments (Bash tool, hooks, MCP stdio servers). The parent Claude process keeps these credentials for API calls, but child processes cannot read them ... On Linux, this also runs Bash subprocesses in an isolated PID namespace so they cannot read host process environments via `/proc`."*

**[V] Anthropic's guidance on untrusted code is blunt.** `devcontainer.md`: *"dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, **including the Claude Code credentials stored in `~/.claude`**. Only use dev containers when developing with trusted repositories."* `sandbox-environments.md` routes "work on an untrusted repository" to *"A dedicated virtual machine, or Claude Code on the web."* `claude-code-action`'s `docs/security.md`: *"Do not check out an untrusted ref into the workspace root before this action."*

**[V] Anthropic documents the inversion explicitly** (`agent-sdk/secure-deployment.md`): *"rather than giving an agent direct access to an API key, you could run a proxy outside the agent's environment that injects the key into requests. The agent can make API calls, but it never sees the credential itself."* Achievable with stock Claude Code by pointing `ANTHROPIC_BASE_URL` at a credential-injecting proxy outside the container and giving the container no Anthropic credential.

**[V] The one first-party tool-execution seam Anthropic ships is a different product:** Managed Agents with self-hosted sandboxes - *"Self-hosted sandboxes keep the orchestration on Anthropic's side but move tool execution into infrastructure you control"*; *"an environment key ... authenticates the worker to its queue; your Claude API key creates sessions and reads queue stats from outside the worker host."* Its own security page adds *"If you run untrusted code inside your sandbox, consider provisioning a separate workspace and environment for each trust boundary"* and *"Anthropic's security boundary stops at the sandbox."* **[I]** A genuine split, but it puts Anthropic's control plane in the middle of every review - the opposite of the self-hosted-worker promise. Reference architecture, not a candidate.

**[V] Built-ins can be removed** (`tools: []` in the Agent SDK; a bare `Bash` in `permissions.deny` in the CLI removes the tool from context entirely). **[V]** SDK MCP servers *"run in-process inside your application, not as a separate process"* and are therefore not a seam; external `type: "http"` / `type: "sse"` MCP servers do run elsewhere. **[I]** So a DIY option (a) exists: strip the built-ins and expose your own shell/edit tools from a remote HTTP MCP server on a credential-free box. You then rebuild the file tools' diff/read semantics, lose per-built-in permission matching (`Bash(rm *)`), lose sandbox integration, and own the tuned tool descriptions. High cost, no benefit over the broker.

### 4.3 OpenCode

**[V]** The repo moved: `sst/opencode` 301-redirects to **`anomalyco/opencode`** (202k stars, MIT, active 2026-08-29). `opencode-ai` 1.18.25.

**[V] The server holds the credential and spawns the shell, in one process.** `packages/opencode/src/tool/shell.ts` spawns in-process via Effect's `ChildProcessSpawner` with `{...process.env, ...extra.env}`, so the child inherits the server's full environment. `packages/opencode/src/session/llm.ts` pulls `Auth.Service` and calls `streamText` in the same process; `LLM.node` depends directly on `Auth.node`, and both compose into one `HttpApiApp`.

**[I]** `opencode serve --hostname` controls *who can reach the server*, not where execution happens relative to the credential. Moving the server moves both halves together.

**[V] There is no sandbox, and the project says so.** `SECURITY.md`: *"OpenCode does **not** sandbox the agent. The permission system exists as a UX feature ... it is not designed to provide security isolation. If you need true isolation, run OpenCode inside a Docker container or VM."* Code search for `bubblewrap` / `seccomp` returns zero hits.

**[V] Credentials:** `~/.local/share/opencode/auth.json`, mode `0600`, with env-var fallback. **[I]** A malicious `postinstall` under the bash tool runs as the same user with the server's full env: `cat ~/.local/share/opencode/auth.json` and `env | grep -i API_KEY` both succeed.

**[V] Plugin hooks cannot substitute a result:** `tool.execute.before` mutates args only; `tool.execute.after` fires after the tool has already run server-side. Plugins load in-process. Remote MCP (`type: "remote"`, `StreamableHTTPClientTransport` / `SSEClientTransport`) is the same DIY seam as Claude Code's.

**[I]** Standalone OpenCode is the weakest of the three for this threat model. Under `@ai-sdk/harness-opencode` it inherits the same brokering as the others, which is the only reason it is viable for Reprove at all.

---

## 5. ACP: the protocol that could, and the adapter that doesn't

**[V]** The Agent Client Protocol specifies client-side execution. Client methods include `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`, and `session/request_permission`. The spec: *"The terminal methods allow Agents to execute shell commands within the Client's environment."* Support is optional and capability-gated: *"If `terminal` is `false` or not present, the Agent **MUST NOT** attempt to call any terminal methods."* ([agentclientprotocol.com/protocol/v1/terminals](https://agentclientprotocol.com/protocol/v1/terminals))

**[V] The official Codex adapter does not use it for execution.** `zed-industries/codex-acp` (archived 2026-07-22; development moved to `agentclientprotocol/codex-acp`, active, 322 stars) vendors its own PTY (`vendor/codex-utils-pty/`), has **zero** references to `fs/read_text_file` or `fs/write_text_file`, and treats terminal support as output streaming only. `src/thread.rs:2032`: `// Stream output bytes to the display-only terminal via ToolCallUpdate meta.` The current adapter confirms it - `src/TerminalOutputMode.ts` resolves only between `"terminal_output"` and `"terminal_output_delta"`, both carrying `{ data, terminal_id }` *payloads to display*, never a request to execute.

**[I]** ACP is therefore a theoretical seam with no production implementation on the agents Reprove cares about. Betting on it means writing your own ACP agent wrapper - at which point `codex exec-server` (§4.1) is the shorter path, with the same experimental caveats.

**[V]** For completeness: `@ai-sdk/harness-acp` also runs its agent inside the sandbox (`src/v1/acp-v1-harness.ts:595`) and exposes a `credentialBrokering` callback that must be configured together with `credentialEnv` (`"ACP credentialEnv and credentialBrokering must be configured together."`). Same architecture, same direction.

---

## 6. Options (b) and (c)

### (b) Short-lived per-job credentials

**What it protects against:** a stolen credential's usefulness *after* the job ends. Nothing else. It does not prevent the theft, and it does not prevent abuse during the job window - which for a review job is exactly when a stolen key is most useful.

**[V] OpenAI.** There is no way to mint a short-lived, model-API-scoped key.
- `POST /v1/organization/admin_api_keys` supports `expires_in_seconds` (1 - 31,536,000; omit for no expiry) and returns the value once - but these are **Admin API** keys for managing the org, not for calling Responses/Chat Completions.
- Project API keys have **List / Retrieve / Delete only. No Create.**
- `POST /v1/organization/projects/{project_id}/service_accounts` **does** return a usable project-scoped `api_key.value` immediately - the closest thing to per-job minting - but with **no documented expiry**. You must delete it yourself.
- Realtime `POST /v1/realtime/client_secrets` ephemeral tokens (10s - 7200s, default 600s) are Realtime-only.
- Revocation: *"Revocations of an API key take effect within a few seconds. Most updates that affect authentication results of an API key propagate within 15 minutes, but can potentially take longer."*

**[V] Anthropic.** Strictly worse. The Admin API has List / Get / **Update** only - no create endpoint anywhere. The docs say so on the endpoint itself: *"To view or create your own API keys, go to API keys in the Claude Console."* Keys carry a nullable `expires_at`, but it is set in the Console, not via API. Workspaces are programmatically creatable (blast-radius scoping across jobs), but the key inside one still comes from a human in the UI. Revocation is `status: "archived"` via Update; **[I]** no numeric propagation SLA is published.

**[V] The genuinely expiring path is cloud-provider model access.**
- Claude Code on Bedrock *"uses the default AWS SDK credential chain,"* reuses credentials *"until five minutes before they expire, or for one hour when they carry no expiration,"* and has an `awsAuthRefresh` setting. STS `AssumeRole` credentials are natively expiring and IAM-scoped.
- OpenCode's Bedrock chain includes *"IAM roles, Web Identity Tokens (EKS IRSA)"* - OIDC federation, no static secret at all.
- Codex CLI has Bedrock as a first-class provider (`model_provider = "amazon-bedrock"`, SigV4). **[I]** Vertex is not first-class for Codex; reachable only as a custom provider or via a gateway.
- Vertex via ADC gives ~1-hour OAuth access tokens for Claude Code and OpenCode.

**[V] Vercel AI Gateway as a broker.** BYOK means the downstream process holds only a Gateway key while Vercel holds the provider key. Per-key spend budgets exist. But *"[API keys] never expire unless you revoke them"* - the Gateway key itself is static unless you wrap mint/revoke yourself. OIDC (`VERCEL_OIDC_TOKEN`) is the short-lived alternative but assumes a Vercel-deployed context.

**Verdict on (b): [I]** worth doing, insufficient alone, and the sharpest version is *not* per-job API keys - it is Bedrock/Vertex federated credentials, or an AI Gateway key with a hard spend budget. Note the interaction: once brokering (§3.3) is in place the credential never enters the sandbox, so (b) degrades from primary mitigation to defence in depth against a brokering failure.

### (c) Co-location with egress allowlisting

**What it protects against:** exfiltration. A credential that cannot leave the box is far less valuable than one that can. **What it does not protect against:** anything the allowed destinations enable. The model API is on the allowlist by definition, so a stolen key can still be *used* - just not carried away. It also does nothing about a credential written into the workspace and collected by a later, unsandboxed CI step.

**[V] Vercel Sandbox** is the strongest implementation available.
- Firecracker microVM per sandbox, dedicated kernel, *"designed for untrusted code."*
- `networkPolicy: 'allow-all' | 'deny-all' | { allow, subnets: { allow, deny } }`. Default is `allow-all` - you must set it. Empty policies (`{}`, `{ allow: {} }`, `{ subnets: {} }`, subnets-deny-only) behave as `deny-all`.
- Policies are updatable at runtime without restarting - install dependencies with network, then lock down before running untrusted code.
- Timeouts: default 5 min, max 45 min (Hobby) / 24 h (Pro & Enterprise).
- The firewall runs on the host, outside the microVM: *"A network bypass can be a sandbox escape."*
- Credential injection is first-class: *"Credentials brokering allows the injection of credentials on egressing traffic, while ensuring those secrets never enter the sandbox scope."* / *"The credential never enters the microVM."*

**[V] The documented holes are specific and matter:**
- Domain matching is on TLS **SNI only**. The firewall does not read the HTTP `Host` header for ordinary allowed domains, so **domain fronting works**: *"the firewall does not prevent the mismatch by default."* Mitigation: allowlist narrow single-purpose hostnames, or force `Host` via a `transform` rule (which terminates TLS).
- `subnets.allow` bypasses everything: *"Code can reach any IP in an allowed range by using a literal IP address or a custom DNS resolver. This traffic bypasses SNI filtering, credentials brokering, and requests proxying."*
- `subnets.allow` **leaves DNS unrestricted**: *"Code can use those lookups to send data over DNS."*
- Plain HTTP cannot be domain-filtered at all.
- Under a catch-all `*` rule, connections with no detectable SNI (SSH, non-TLS) pass through untransformed.
- Containers run inside the sandbox do not inherit the proxy CA.

**[V] Claude Code and Codex have same-host equivalents** - `sandbox.network.allowedDomains` + `tlsTerminate` + `credentials.mask`, and `features.network_proxy` with domain rules - enforced by Seatbelt/bwrap+seccomp outside the sandboxed child. **[I]** Weaker than a microVM boundary (same kernel, same user, sandbox-escape surface) but real, and they are what a self-hosted worker on a plain Linux box can actually use.

**Verdict on (c): [I]** necessary, and the pairing that does the real work is (c) *plus* brokering: allowlisting confines the blast, brokering removes the thing worth stealing. Neither alone is sufficient.

### The mitigation that is mostly theatre

**[V]** Lifecycle-script hardening is much weaker than it sounds. npm `ignore-scripts`: *"npm does not run scripts specified in package.json files"* - but *"commands explicitly intended to run a particular script, such as `npm start`, `npm stop`, `npm restart`, `npm test`, and `npm run` will still run their intended script."* pnpm v10 runs no dependency lifecycle scripts unless listed in `onlyBuiltDependencies` (unified into an `allowBuilds` map in pnpm 11, ~2026-04 - check the pin). Yarn: *"Yarn doesn't run postinstalls by default ever since 4.14."*

**[I]** None of these touch the repo's own `package.json` scripts, the test runner, the build step, or config files that execute as real JS (`vitest.config.ts`). **If the review runs the PR's tests, lifecycle-script flags give zero protection.** Set them; do not lean on them.

---

## 7. The finding that contradicts the map

**[V]** `@ai-sdk/harness-codex/src/codex-auth.ts` resolves auth from exactly `OPENAI_API_KEY`, `CODEX_API_KEY`, `AI_GATEWAY_API_KEY` (plus `OPENAI_BASE_URL` / `OPENAI_ORGANIZATION` / `OPENAI_PROJECT` / `VERCEL_OIDC_TOKEN`). `grep -rn "auth\.json"` across the `src/` of all three adapters returns **zero** matches. `ai-sdk.dev`'s Codex provider page lists the same env vars and no subscription sign-in.

**[I] Therefore a ChatGPT- or Claude-subscription seat cannot be driven through `@ai-sdk/harness` at all.** The map's framing correction - "orchestrate the agents you already authenticated on the user's own machine" - does not survive contact with the agent layer the map has already settled on. Either:

- the self-hosted worker is API-key / AI-Gateway-key only, and the pitch changes; or
- the worker shells out to the CLIs directly, outside `@ai-sdk/harness`, and rebuilds brokering itself for a credential that **brokering fundamentally cannot protect** - an OAuth refresh returns *new tokens into the box*, and the CLI must write them back to `~/.codex/auth.json`.

**[I]** This is a decision for the map, not for this ticket, but it blocks #10 and should be surfaced now. Independent corroboration: OpenAI's CI/CD auth page says *"Do not use this workflow for public or open-source repositories,"* and the official Codex ACP adapter states ChatGPT-subscription auth *"doesn't work in remote projects."*

---

## 8. What none of this protects against

**[I] In-place credential abuse.** `HarnessV1RequestTransformation` matches on `host`, `path`, `method`, `queryString`, and `headers`. Nothing binds a rule to a process. Any code inside the sandbox that discovers the placeholder - `/proc/<bridge pid>/environ`, a log, a crash dump - can present it to the allowed host and have the proxy substitute the real key. It cannot carry the key away; it can spend it, from inside, for the sandbox's lifetime. Per-key spend budgets and short sandbox timeouts are the controls, not the boundary.

**[I] Deferred exfiltration.** Blocking egress from the sandbox does not stop untrusted code from writing a stolen secret into the workspace, where a later unsandboxed step - artifact upload, cache, a commit, the PR diff itself - carries it out. Whatever leaves the sandbox must be treated as attacker-controlled.

**[I] Repo code sharing a sandbox with the agent.** The harness architecture puts the agent CLI, the repo, and anything the repo executes in one microVM. That is the correct trade for exfiltration, and it means the finer-grained seam that actually matters for Reprove is not harness-vs-repo but **reading the repo vs executing it**. A review that only reads has a far smaller surface than one that runs `npm test`.
  - **[V]** Vercel Sandbox `createUser` / `createGroup` / `asUser` gives each agent a private `/home/<user>` at mode `770`: *"One agent, running as its own user, cannot read, list, or write another agent's home directory."*
  - **[I]** But sandbox workloads run with `sudo` available, so intra-sandbox user separation is defence in depth against accidents, not a boundary against hostile code. If Reprove needs to execute PR tests, the sound design is a **second sandbox** with `deny-all` egress and no credential of any kind.

**[V] Prompt injection.** Codex's docs: *"Prompt injection can cause the agent to fetch and follow untrusted instructions."* Anthropic's action docs: subprocess env scrubbing *"reduces but does not eliminate prompt injection risk."* Reviewing a PR means feeding attacker-authored text to a model holding a shell. Nothing here addresses that.

---

## 9. What the competitors do: nothing

**[V]**

| Project | What it is | Credential handling | Executes repo code? |
| --- | --- | --- | --- |
| `majiayu000/harness` (64★, MIT, active 2026-08-28) | Rust control plane orchestrating agent fleets; ships a GH Action | *"Harness forwards that provider credential to the Claude container by environment variable name."* | Yes - `harness exec --project "${GITHUB_WORKSPACE}"` |
| `razzant/claudexor` (424★, MIT, active 2026-08-29) | Local best-of-N racing across vendor CLIs; **not** a PR-review tool | Vendor CLI credential stores / env vars | Own repo only - threat model does not apply |
| `mattzcarey/shippie` (2,486★, MIT, active 2026-08-12) | Diff-reading review agent on GH Actions | Env vars / Actions secrets | Does not run the PR's install/build - **but the agent has a `bash` tool** |

Mitigations that do exist are workflow hygiene, not architecture: `majiayu000/harness` blocks fork PRs outright (`github.event.pull_request.head.repo.fork == false`), drops sudo, and uses Landlock/Bubblewrap (macOS falls back to full access, per its own README). `shippie` avoids `pull_request_target` and gates comment triggers on `author_association`. `claudexor`'s SECURITY.md is candid: *"Claudexor does not add an outer Seatbelt, container, or other OS filesystem boundary."*

**[I] Nobody in this space has separated the credential from repo execution.** They either avoid running untrusted code, block fork PRs, or accept the risk. `shippie` is closest to safe and still hands its agent a live shell in the credentialed process, with no SECURITY.md acknowledging it. This is a real differentiator for Reprove - and a cheap one, because `@ai-sdk/harness` already ships the mechanism.

---

## 10. Recommendation

**Kill option (a) as the foundation.** Replace the PRD §24 "potential architecture" diagram (agent outside, restricted tool bridge inward) with the credential-broker alternative already listed one line below it. Record it as an ADR; it is structurally load-bearing and expensive to retrofit. Note `codex exec-server` in the ADR as a real but rejected alternative, with the reasons: undocumented, experimental, Codex-only, unauthenticated by default.

**Hosted path** (settled: Vercel Sandbox): use `@ai-sdk/sandbox-vercel`, brokering on. Set `networkPolicy` explicitly - the default is `allow-all`. Allowlist narrow, single-purpose hostnames (domain fronting is documented). Never use `subnets.allow` with a broad range; it bypasses SNI filtering, brokering, and proxying, and leaves DNS open. Keep `settings.tools` empty or trivially-validating.

**Self-hosted worker path:** brokering is not free here. Either
1. delegate to a provider that implements it - `@e2b/ai-sdk-sandbox` does **[V]**, `@coder/ai-sdk-sandbox` does **not** **[V]**; or
2. build the egress proxy yourself: a container in its own network namespace, a transparent TLS-terminating proxy on the host with a per-job CA, header injection there, and a default-deny domain policy. The credential must live somewhere the container cannot reach - not merely a different process as the same user.

**Ship the `credentialForwarding` guard from §3.4 regardless.** A `console.warn` is not an acceptable failure mode for shipping a live API key into attacker-controlled code, and it is three lines to fix. Make it a regression test, not a comment.

**If a worker ever drives a CLI directly, outside `@ai-sdk/harness`**, the Codex hardening set is: `codex exec` with `-a never`; a throwaway `CODEX_HOME` per run (no `auth.json`, no persisted project trust); `shell_environment_policy.inherit = "none"` or at minimum `ignore_default_excludes = false`; a deny-read permission profile (`":root" = "deny"` + `":minimal" = "read"`, or `":root" = "read"` + `"~/.codex" = "deny"` + `"~/.ssh" = "deny"`); `features.network_proxy` with a narrow domain allowlist; and a root-owned `/etc/codex/requirements.toml` `deny_read` so a `.codex/config.toml` in the PR cannot undo any of it. The Claude Code equivalents are `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, `sandbox.credentials.files` deny on `~/.claude/.credentials.json`, `sandbox.failIfUnavailable: true`, and `ANTHROPIC_BASE_URL` pointed at an injecting proxy with no credential in the box.

**Split reading from executing.** If a review needs to run the PR's tests, do it in a second sandbox with `deny-all` egress and no credential. That is the seam Reprove can actually build, and it is worth more than any harness-level plumbing.

**Layer, in rough order of value:** brokering → egress allowlist → separate execution sandbox → federated/expiring credentials (Bedrock STS, Vertex ADC, or a Gateway key with a spend budget) → lifecycle-script flags → short sandbox timeouts.

---

## API stability risk

**[V]** `@ai-sdk/harness` reached `1.0.0` on 2026-06-25 and is at `1.0.93` on 2026-08-29 - roughly one release per weekday for two months, with adapters versioned independently (`harness-claude-code` already at 1.0.97, `harness-acp` at 1.0.31). The README still self-describes as **experimental** despite the 1.x version, and `experimental_` identifiers appear throughout the public surface (`experimental_sandbox`, `Experimental_SandboxSession`, `experimental_onToolCallStart`).

**[I] Consequences for Reprove:**
- Pin exact versions of `@ai-sdk/harness*` and the sandbox provider, and upgrade them as one set. Core and adapters are released together and are unlikely to be cross-compatible across a gap.
- The credential-brokering contract - the thing this whole architecture rests on - is an *optional* interface method with a `console.warn` fallback. That is precisely the shape that changes quietly. The `credentialForwarding` assertion is the regression test.
- Everything in §3 was read from shipped source, not documentation. `ai-sdk.dev` does not currently document the credential model in any depth (the `/sandboxes` docs page 404s). Re-read the source on every upgrade; the docs will not warn you.
- The Codex surface is churning too: `--full-auto` removed, `codex debug seatbelt|landlock` renamed to `codex sandbox`, Landlock demoted behind `--use-legacy-landlock`, permission profiles marked Beta, `exec-server` `[EXPERIMENTAL]` and undocumented, and the whole docs site relocated from `developers.openai.com/codex/*` to `learn.chatgpt.com/docs/*`.
- Reprove's harness abstraction should isolate callers from `HarnessAgentSettings` so churn lands in one adapter module rather than across the worker.

---

## Open questions

- **[V, contradicts docs]** On Codex, `--sandbox` vs `default_permissions` precedence. The docs say legacy `sandbox_mode` wins; an observed `codex sandbox` run had the profile win. Untested on `codex exec` (needs live auth). Verify before relying on either.
- **Untested:** `/etc/codex/requirements.toml` `deny_read` enforcement (needs root).
- **Untested:** whether `@e2b/ai-sdk-sandbox`'s brokering is actually enforced outside the guest, and whether Cloudflare / Azure / CapsuleOS providers implement it at all.
- **Unverified:** whether a Plus/Pro `codex login` lands a live Platform API key in `auth.json` (the code path exists and swallows failure).
- All Codex empirical results are Linux/WSL2 + bwrap. macOS Seatbelt behaviour is verified from source (`(allow file-read*)`) but not run.

---

## Sources

**`@ai-sdk/harness`** - primary evidence read from published tarballs (`npm pack`; full `src/` shipped): `@ai-sdk/harness@1.0.93` (`src/utils/sandbox-credential-brokering.ts`, `src/utils/credential-forwarding.ts`, `src/v1/harness-v1-network-sandbox-session.ts`, `src/v1/harness-v1-credential-forwarding.ts`, `src/agent/harness-agent-settings.ts`), `@ai-sdk/harness-codex@1.0.95` (`src/codex-harness.ts`, `src/codex-auth.ts`, `src/codex-bootstrap.ts`), `@ai-sdk/harness-acp@1.0.31`, `@e2b/ai-sdk-sandbox@0.3.0`, `@coder/ai-sdk-sandbox@0.4.6`. Mirrored at `https://github.com/vercel/ai/blob/main/packages/harness/`. Docs: [ai-sdk.dev/docs/ai-sdk-harnesses/overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview), [ai-sdk.dev/providers/ai-sdk-harnesses/codex](https://ai-sdk.dev/providers/ai-sdk-harnesses/codex).

**Vercel Sandbox** - [docs/sandbox/concepts](https://vercel.com/docs/sandbox/concepts), [concepts/firewall](https://vercel.com/docs/sandbox/concepts/firewall), [concepts/multi-agent](https://vercel.com/docs/sandbox/concepts/multi-agent), [sdk-reference](https://vercel.com/docs/sandbox/sdk-reference), [ecosystem](https://vercel.com/docs/sandbox/ecosystem), [blog: a sandbox without a network boundary is only half a sandbox](https://vercel.com/blog/a-sandbox-without-a-network-boundary-is-only-half-a-sandbox), [blog: how v0 authenticates to Snowflake without exposing the user's OAuth token](https://vercel.com/blog/how-v0-authenticates-to-snowflake-without-exposing-the-users-oauth-token), [kb: Herdr coding agents in isolated Sandboxes](https://vercel.com/kb/guide/run-herdr-coding-agents-isolated-vercel-sandboxes). eve: [eve.dev/docs/concepts/security-model](https://eve.dev/docs/concepts/security-model), [eve.dev/docs/sandbox](https://eve.dev/docs/sandbox).

**Codex CLI** - source read at `openai/codex` tag `rust-v0.151.0`: `codex-rs/protocol/src/protocol.rs`, `sandboxing/src/seatbelt.rs`, `sandboxing/src/manager.rs`, `linux-sandbox/src/bwrap.rs`, `login/src/auth/storage.rs`, `login/src/auth/manager.rs`, `config/src/shell_environment_policy.rs`, `config/src/config_layer_source.rs`, `core/src/unified_exec/process_manager.rs`, `core/src/tools/orchestrator.rs`, `exec-server/src/environment_toml.rs`, `exec-server/README.md`, `responses-api-proxy/README.md`, `app-server/src/request_processors/thread_processor.rs`. Docs relocated to `learn.chatgpt.com` (old `developers.openai.com/codex/*` 308-redirects): [/docs/auth](https://learn.chatgpt.com/docs/auth), [/docs/auth/ci-cd-auth](https://developers.openai.com/codex/auth/ci-cd-auth), [/docs/agent-approvals-security](https://learn.chatgpt.com/docs/agent-approvals-security), [/docs/permissions](https://learn.chatgpt.com/docs/permissions), [/docs/non-interactive-mode](https://learn.chatgpt.com/docs/non-interactive-mode), [/docs/enterprise/managed-configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration), [/docs/enterprise/access-tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens). ACP adapters: [zed-industries/codex-acp](https://github.com/zed-industries/codex-acp) (archived), [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp).

**Claude Code** - [sandboxing](https://code.claude.com/docs/en/sandboxing), [sandbox-environments](https://code.claude.com/docs/en/sandbox-environments), [authentication](https://code.claude.com/docs/en/authentication), [settings-reference](https://code.claude.com/docs/en/settings-reference), [hooks](https://code.claude.com/docs/en/hooks), [env-vars](https://code.claude.com/docs/en/env-vars), [devcontainer](https://code.claude.com/docs/en/devcontainer), [agent-sdk/custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), [agent-sdk/secure-deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment), [managed-agents/self-hosted-sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes). Versions: `@anthropic-ai/claude-code` 2.1.251, `@anthropic-ai/claude-agent-sdk` 0.3.251.

**OpenCode** - [anomalyco/opencode](https://github.com/anomalyco/opencode) (`sst/opencode` redirects here), `SECURITY.md`, `packages/opencode/src/tool/shell.ts`, `src/session/llm.ts`, `src/auth/index.ts`, `src/mcp/index.ts`, `packages/plugin/src/index.ts`; [opencode.ai/docs/providers](https://opencode.ai/docs/providers). Version `opencode-ai` 1.18.25.

**ACP** - [agentclientprotocol.com/protocol/overview](https://agentclientprotocol.com/protocol/overview), [/protocol/v1/terminals](https://agentclientprotocol.com/protocol/v1/terminals), [/protocol/v1/file-system](https://agentclientprotocol.com/protocol/v1/file-system).

**Credential lifetimes** - [OpenAI admin API keys create](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/admin_api_keys/methods/create), [project API keys](https://platform.openai.com/docs/api-reference/project-api-keys), [project service accounts](https://platform.openai.com/docs/api-reference/project-service-accounts/create), [realtime client secrets](https://platform.openai.com/docs/api-reference/realtime-sessions/create-realtime-client-secret), [API reference overview](https://developers.openai.com/api/reference/overview); [Anthropic Admin API keys](https://platform.claude.com/docs/en/api/admin-api/apikeys/get-api-key), [Admin API overview](https://platform.claude.com/docs/en/manage-claude/admin-api); [Claude Code on Bedrock](https://code.claude.com/docs/en/amazon-bedrock), [Codex on Bedrock](https://developers.openai.com/codex/amazon-bedrock); [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), [authentication and BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok).

**Package managers** - [npm ignore-scripts](https://docs.npmjs.com/cli/v11/using-npm/config#ignore-scripts), [pnpm settings](https://pnpm.io/10.x/settings), [pnpm approve-builds](https://pnpm.io/cli/approve-builds), [Yarn security](https://yarnpkg.com/features/security).

**Competitors** - [majiayu000/harness](https://github.com/majiayu000/harness), [razzant/claudexor](https://github.com/razzant/claudexor), [mattzcarey/shippie](https://github.com/mattzcarey/shippie).
