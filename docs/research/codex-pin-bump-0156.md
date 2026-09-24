# What moving the Codex pin to 0.156.1 (and the Harness to 1.0.123/1.0.125) changes

Research for [#130](https://github.com/nick-neely/reprove/issues/130), section "The pin moves too".
Investigated 2026-09-24.

Claims are tagged **[V]** verified (package tarball or source read at a named version or tag, a
command actually run with its output quoted, or a first-party page quoted) or **[I]** inferred
(reasoning from verified facts, labelled as such). "Live check" means the claim needs a real
Provider turn, which this investigation did not make.

## Point-in-time versions

| Thing | Current pin | Latest on npm | How established |
| --- | --- | --- | --- |
| `@ai-sdk/harness` (core) | 1.0.102 | 1.0.123 (2026-09-22) | `npm pack`, `npm view ... time` **[V]** |
| `@ai-sdk/harness-codex` (bridge) | 1.0.104 | 1.0.125 (2026-09-23) | `npm pack`, `npm view ... time` **[V]** |
| `@openai/codex` + `@openai/codex-sdk` | 0.153.4 (Adapter lock) | 0.156.1 (2026-09-23) | `npm pack`, tags `rust-v0.153.4`, `rust-v0.155.0`, `rust-v0.155.1`, `rust-v0.156.0`, `rust-v0.156.1` fetched from `openai/codex` **[V]** |
| Codex embedded in bridge 1.0.104 | `@openai/codex-sdk` 0.149.1 | - | `dist/bridge/package.json` **[V]** |
| Codex embedded in bridge 1.0.125 | `@openai/codex-sdk` 0.155.0 | - | `dist/bridge/package.json`, `dist/bridge/pnpm-lock.yaml` **[V]** |

Codex binaries run: `@openai/codex@0.153.4-linux-x64` and `@openai/codex@0.156.1-linux-x64`,
`codex --version` printing `codex-cli 0.153.4` and `codex-cli 0.156.1` **[V]**.

**Method for the request captures in this doc.** Each binary was run as the bridge runs it
(`codex exec --experimental-json`, the bridge's `agent_bridge_openai` custom provider with
`wire_api="responses"` and `supports_websockets=false`, `--sandbox danger-full-access`,
`approval_policy="never"`, `project_doc_max_bytes=0`, `skills.include_instructions=false`,
`web_search="disabled"`, and Reprove's trailing `--ignore-user-config --ignore-rules`) against a
local HTTP server that recorded the `/v1/responses` body. A dummy key was used and no request left
the machine. Where the doc says "simulated", the server replied with a scripted Responses SSE
stream (the same shape `tools/codex-contract.test.mjs` uses) so the CLI executed a tool call.
Script and outputs are in the appendix.

---

## 1. Which Codex version first ships `gpt-6-sol` metadata, and what it sets

**`gpt-6-sol` first appears in the bundled catalog at `rust-v0.156.1`.** **[V]**
`codex-rs/models-manager/models.json` has no `gpt-6-sol` entry at `rust-v0.153.4`, `0.154.0`,
`0.155.0`, `0.155.1` or `0.156.0`, and has one at `0.156.1`. The 0.156.1 release is a hotfix whose
entire note is "Choose GPT-6 Sol or GPT-6 Luna from the model picker" (PR #47405, "[hotfix 0.156.0]
Add GPT-6 Sol and Luna to the model catalog") **[V]**
([release](https://github.com/openai/codex/releases/tag/rust-v0.156.1)). Upstream issue
[#47420](https://github.com/openai/codex/issues/47420) (open, filed on 0.154.0) complains that no
stable release had it; it predates 0.156.1 **[V]**.

`gpt-6-*` generally: `gpt-6-astra` has been in the catalog since at least 0.153.4 (added in 0.154.0's
notes as "GPT-6-Astra is now available in the model picker", but already present in the 0.153.4
`models.json`) **[V]**. `gpt-6-luna` arrives with `gpt-6-sol` in 0.156.1 **[V]**. The #114 warning
at 0.153.4 was therefore specific to `gpt-6-sol`; the fallback lookup is a longest-prefix match on
slug (`find_model_by_longest_prefix` in `models-manager/src/manager.rs`) and `gpt-6-astra` is not a
prefix of `gpt-6-sol` **[V]**.

`gpt-6-sol` declares `minimal_client_version: "0.155.0"` **[V]**, but 0.155.x does not bundle it
**[V]**. **[I]** A 0.155.x client could only obtain it from a remote `/models` catalog. That path is
not taken for API-key auth unless API-key model discovery is enabled
(`api_key_model_discovery_enabled` defaults to `false` in `OpenAiModelsManager::new_with_optional_cache`,
`manager.rs:328`) **[V]**. So the bridge 1.0.125's embedded 0.155.0 would still use fallback
metadata for `gpt-6-sol` on Reprove's brokered route **[I]**.

### What the 0.156.1 entry sets **[V]**

| Field | `gpt-6-sol` @ 0.156.1 | `gpt-5.6-sol` (0.153.4 and 0.156.1, unchanged) | Fallback (`model_info_from_slug`, both tags) |
| --- | --- | --- | --- |
| `context_window` / `max_context_window` | 272000 / 872000 | 272000 / 872000 | 272000 / 272000 |
| `apply_patch_tool_type` | `freeform` | `freeform` | `None` |
| `tool_mode` | `code_mode_only` | `code_mode_only` | `None` (so `Direct` unless a feature flag asks for code mode) |
| `use_responses_lite` | `true` | `true` | `false` |
| `shell_type` | `shell_command` | `unified_exec` | `UnifiedExec` |
| `supported_reasoning_levels` | low, medium, high, xhigh, max, ultra | same | empty |
| `default_reasoning_level` | `medium` | `low` | none |
| `truncation_policy` | tokens, 10000 | tokens, 10000 | bytes, 10000 |
| `supports_parallel_tool_calls` | true | true | (default) |
| `multi_agent_version` | `v2` | (see file) | `None` |
| `experimental_supported_tools` | `send_user_message_async`, `clock` | `[]` | `[]` |
| `support_verbosity` / `default_verbosity` | true / `low` | same | false / none |
| `default_service_tier` | `priority` | none | none |
| `include_{apps,plugin}_usage_instructions` | false | true | false |
| `node_repl_auto_review_required` | true | false | false |
| instructions template | "You are Codex, an agent based on GPT-6. ..." | "... based on GPT-5. ..." | bundled `prompt.md` |
| pricing | no pricing field exists in the schema | - | - |

The `effort: "ultra"` level is described as "Maximum reasoning with automatic task delegation"
**[V]**. The bridge's typed `reasoningEffort` stays `'low' | 'medium' | 'high' | 'xhigh' | 'max'` in
both 1.0.104 and 1.0.125 **[V]**, so Reprove's advertised set for `gpt-6-sol` would be the same five
as GPT-5.6 Sol **[I]**.

`default_service_tier: "priority"` is not sent on Reprove's route: every captured request body had
`service_tier: null`, including `gpt-6-sol` at 0.156.1 **[V]**. That matters because a priority tier
would change the API price the ticket quotes **[I]**.

### What behaviour differs from fallback metadata **[V, captured]**

The first `/v1/responses` request for the prompt `run ls`, same flags, only version and model varying:

| Capture | Top-level `tools` | `input[0]` | `instructions` | Lite header | `parallel_tool_calls` |
| --- | --- | --- | --- | --- | --- |
| 0.153.4, `gpt-6-sol` (fallback) | `exec_command, write_stdin, request_user_input, view_image, multi_agent_v1, get_goal, create_goal, update_goal` | message | 16,979 chars | absent | true |
| 0.156.1, `gpt-6-sol` (real) | `null` | `additional_tools`: namespaces `functions` (`exec`, `wait`, `request_user_input`, `request_user_input_async`), `clock` (`sleep`), `collaboration` (`spawn_agent`, `send_message`, `wait_agent`, `followup_task`, `interrupt_agent`, `list_agents`) | empty (moved into developer messages) | `x-openai-internal-codex-responses-lite: true` | false |
| 0.153.4, `gpt-5.6-sol` (today's default) | `null` | `additional_tools`: same shape, no `clock` | empty | present | false |
| 0.156.1, `gpt-5.5` (control) | `exec_command, write_stdin, request_user_input, apply_patch, view_image, get_goal, create_goal, update_goal, tool_search` | message | 21,299 chars | absent | true |

Under code mode the model gets one custom tool, `functions.exec`, which "Evaluates the provided
JavaScript code in a fresh V8 isolate" with "no Node, no file system, no network access", and
reaches the real tools as `tools.<name>(...)` **[V, quoted from the captured tool description]**. At
0.156.1 the nested tools declared for `gpt-6-sol` are `apply_patch, create_goal, exec_command,
get_goal, update_goal, view_image, write_stdin, clock__curr_time` **[V]**.

So, relative to the #114 run:

1. **`apply_patch` becomes registered.** Registration is `environment_mode.has_environment() &&
   model_info.apply_patch_tool_type.is_some()` (`core/src/tools/spec_plan.rs:1211` at 0.156.1,
   `:1239` at 0.153.4) **[V]**. Fallback has `None`, so #114 ran without `apply_patch`; 0.156.1
   `gpt-6-sol` has it, nested under `exec` **[V, captured]**. No feature flag removes it: the old
   `apply_patch_freeform` feature is `Stage::Removed` **[V]**.
2. **The request switches to Responses Lite plus code-mode-only tools.** This is the shape
   openai/codex [#31894](https://github.com/openai/codex/issues/31894) (open, labels `bug`, `exec`,
   `tool-calls`) reports as leaving `codex exec` models with no callable tools. The 0.156.1
   `build_responses_request` still sends `tools: None` and puts the schemas in `additional_tools`
   (`core/src/client.rs:885-917`) **[V]**. The bridge 1.0.125 source says so directly: its
   `DEFAULT_CODEX_MODEL` stays `gpt-5.5` because "Newer GPT-5.6 models use Responses Lite, which
   does not expose their code-mode tools as callable through the custom model provider used by the
   harness ... until the upstream bug is resolved: https://github.com/openai/codex/issues/31894"
   (`src/codex-harness.ts:76-86`) **[V]**. **[I] The #114 success on `gpt-6-sol` (16 tool calls,
   three verified Findings) was obtained on the fallback path, which sends plain top-level tools.
   The real metadata moves it onto the path the bridge authors say is broken. Whether OpenAI's API
   now honours `additional_tools` over a custom provider is the single most important live check.**
   The same applies to today's default: `gpt-5.6-sol` has taken the Responses Lite path on 0.153.4
   all along **[V, captured]**, and the contract suite does not exercise it (see §2.9).
3. **Code-mode nested commands still arrive as `command_execution` items.** In a simulated turn at
   0.156.1 the scripted Provider called `functions.exec` with
   `const r = await tools.exec_command({cmd: "echo reprove-canary-$((6*7))"}); text(r);`. The CLI
   ran the command and the JSONL stream carried `item.started`/`item.completed` of
   `type: "command_execution"` with `exit_code: 0` and `aggregated_output: "reprove-canary-42\n"`,
   exactly as the 0.153.4 direct `exec_command` call did **[V]**. The bridge turns these into the
   `bash` tool-call/tool-result pair `brokered.ts` observes, and that mapping is unchanged
   1.0.104 to 1.0.125 **[V]**. **[I]** Reprove's observed-command Evidence therefore survives code
   mode, provided the model can call `exec` at all (point 2).
4. **The fallback warning disappears.** At 0.153.4 it is emitted as an exec JSONL
   `{"type":"item.completed","item":{"type":"error","message":"Model metadata for \`gpt-6-sol\` not
   found. ..."}}` **[V]**. The bridge maps a completed `error` item to a warning, not an error
   (`create-emit-stream-event.ts:258-264`, both versions) **[V]**, so it never failed a Pass. At
   0.156.1 no such item is emitted **[V]**.
5. **`shell_type: shell_command` has no effect in 0.156.1.** `add_shell_tools` checks only
   `ConfigShellToolType::Disabled` and then registers `exec_command` whenever `unified_exec` is on
   (`spec_plan.rs:1032-1070`); no `ShellToolType::ShellCommand` consumer exists in `core/src` or
   `tools/src` **[V, grep]**.
6. **Multi-agent tools are exposed on both paths.** Fallback exposes `multi_agent_v1`; real
   metadata exposes the `collaboration` namespace (`spawn_agent`, ...). `features.multi_agent=false`
   and `features.goals=false` did not remove the `collaboration` namespace at 0.156.1 **[V,
   captured]**. This is input to #117.

---

## 2. What the bridge 1.0.125 and core 1.0.123 embed and change

**Embedded runtime: `@openai/codex-sdk` 0.155.0 / `@openai/codex` 0.155.0** (up from 0.149.1)
**[V]**. No bridge release embeds 0.156.x: the last runtime refresh is 1.0.121 (published
2026-09-22 03:22Z, "update underlying harness SDKs to their latest versions"), before 0.156.0 was
published (2026-09-22 19:55Z) **[V]**. Reprove must keep replacing the embedded lock to get
`gpt-6-sol` metadata **[I]**.

The full `src/` diff 1.0.104 to 1.0.125 touches `codex-harness.ts`, `codex-bootstrap.ts`,
`bridge/create-emit-stream-event.ts`, `bridge/codex-step-tracker.ts`, the bridge's
`package.json`/lock, and adds `codex-subscription.ts` **[V]**. `bridge/index.ts`,
`bridge/cli-relay.ts`, `bridge/tool-relay*.ts`, `codex-auth.ts` and `codex-bridge-protocol.ts` are
byte-identical **[V]**. The compiled `dist/bridge/index.mjs` differs by 69 diff lines: web-search
event handling and two dropped `return;` statements **[V]**.

Item by item:

1. **Model selection: breaking for Reprove.** 1.0.106 "remove[s] formerly deprecated `model` and
   `modelId` config on harness adapter settings" **[V, CHANGELOG]**. In 1.0.125 `doStart` sets
   `const model = DEFAULT_CODEX_MODEL` (`'gpt-5.5'`), and the per-turn value is
   `promptOpts.model ?? model` / `continueOpts.model ?? model` **[V]**. `brokered.ts` passes `model`
   to `createCodex(...)` and not to `doPromptTurn` **[V]**. **[I] On 1.0.125 that setting no longer
   exists: TypeScript should reject the object-literal property, and if it were forced through,
   every Pass would silently run `gpt-5.5`.** The fix is to pass `model` on `doPromptTurn` (the
   `HarnessV1TurnSettings.model` field exists in both core versions **[V]**) and keep it on any
   continuation.
2. **`permissionMode` and `builtinToolFiltering`: unchanged.** Both still throw
   `HarnessCapabilityUnsupportedError` for `builtinToolFiltering != null` and for any
   `permissionMode` other than `allow-all` (`codex-harness.ts:215-232`) **[V]**.
3. **Forced sandbox and approval: unchanged.** The bridge still builds
   `threadOptions = { sandboxMode: 'danger-full-access', approvalPolicy: 'never',
   skipGitRepoCheck: true, ... }` after spreading `start.codexConfig` into the `config` object
   (`bridge/index.ts:125-215`) **[V]**. The SDK turns those into `--sandbox danger-full-access` and
   `--config approval_policy="never"` **[V]**.
4. **`codexConfig` passthrough: unchanged.** `{ ...start.codexConfig, developer_instructions,
   model_reasoning_summary: 'detailed' }`, then provider keys, then `mcp_servers` when supplied
   **[V]**. The settings doc still says "Values managed by this adapter take precedence" **[V]**.
   New: `codexConfig.cli_auth_credentials_store` is read on the host by the native-subscription
   resolver (item 10) **[V]**.
5. **The Codex constructor Reprove patches: unchanged.** `new codexSdk.Codex({` occurs exactly once
   in 1.0.125's `dist/bridge/index.mjs` (line 1430), followed by the same `apiKey`, `baseUrl`,
   `env`, `config` spread as 1.0.104 (line 1395) **[V]**. `image.ts`'s split-count check passes.
   `getBootstrap()` still returns `bootstrapDir: '.harness-bootstrap/codex'` with
   `${bootstrapDir}/bridge.mjs`, so `codexImageFiles()`'s filter still finds it **[V]**.
6. **Bootstrap and session state moved: breaking for Reprove's preflight.** 1.0.125 (change
   `9c8c0c1`) resolves bootstrap and `.agent-runs` under `harnessStateDirectoryPath({ sandboxHomeDir
   })` = `$HOME/.ai-sdk-harness`, never under `defaultWorkingDirectory` **[V, source and
   CHANGELOG]**. `resolveSandboxDefaultWorkingDirectory` is no longer called by the Codex adapter
   **[V]**. The spawn command is `node ${bootstrapDir}/bridge.mjs ...` with
   `bootstrapDir = $HOME/.ai-sdk-harness/.harness-bootstrap/codex` **[V]**. Reprove's `preflight.ts`
   symlinks `/reprove/runtime/.harness-bootstrap/codex` to `/opt/reprove/codex` **[V]**. **[I] With
   `HOME=/reprove/home` (`CODEX_ENVIRONMENT`), the bridge would look in
   `/reprove/home/.ai-sdk-harness/.harness-bootstrap/codex`, so the symlink must move there, and
   bridge state (event log, CLI shim) moves from `/reprove/runtime` to the `/reprove/home` mount.**
   The #114 hosted bootstrap that "linked into the Harness's bootstrap path" needs the same change.
7. **Detach, suspend, reattach and cursor: logic unchanged, transport hardened.** The attach, then
   replay, then rerun ladder in `doStart` is textually unchanged, including the comment that
   `resumeFrom` "always `rerun`" when attach is unavailable and that rerun is "Lossy" (`:360-480`,
   `:1089-1135`) **[V]**. The `catch {}` that swallows a failed attach and falls through is unchanged
   **[V]**. **So the harness still falls back to `rerun` silently** **[V]**. What changed is in core
   `SandboxChannel`: `connect()` now receives an `AbortSignal`, reconnect has a hard deadline
   including connect time, `close`/`beginClose`/suspend abort in-flight connects, and the buffered
   replay preserves arrival order across listener types (`7115a3f`) **[V]**. A new
   `reconnect?: SandboxChannelReconnectOptions` setting is exposed (default 30 s) **[V]**. The cursor
   still carries `bridge.port` and `bridge.token` **[V]**. `mintBridgeToken` is now typed
   `HarnessV1MintBridgeTokenCallback` (same `(sandboxId) => string` role) **[V]**.
8. **Abort or interrupt of a running turn: unchanged.** The host sends `{ type: 'abort' }` and
   settles the turn with the abort reason (`codex-harness.ts:929-947`); the shared bridge runtime's
   `case 'abort'` is unchanged (core `bridge/index.ts` differs only by one dropped `return;`) **[V]**.
   The bridge aborts `thread.runStreamed(..., { signal })`, and the SDK passes that signal to
   `child_process.spawn`, which kills `codex exec` (`@openai/codex-sdk` `dist/index.js:263-276`)
   **[V]**. `codex exec` converts only Ctrl-C (`tokio::signal::ctrl_c`) into a graceful
   `TurnInterrupt` (`exec/src/lib.rs:1115-1261` at 0.156.1, same at 0.153.4) **[V]**. **[I] There is
   still no graceful interrupt on this stack: an abort kills the CLI process, as ADR 0020 assumed and
   #114 observed.** 0.156.1's CLI code also has `code_mode_interrupt`, but it is
   `Stage::UnderDevelopment`, default off **[V]**.
9. **Usage per turn: unchanged, zero until `finish`.** The bridge stores usage from
   `turn.completed` and emits it only on the final `finish` as
   `totalUsage: turnUsage ?? defaultUsage()` (`bridge/index.ts:223-276`) **[V]**. 0.156.1 adds
   `cache_write_input_tokens` to `turn.completed.usage` **[V, simulated]**; the bridge's `mapUsage`
   ignores it **[V]**.
   *Contract-suite gap:* `tools/codex-contract.test.mjs` answers the `gpt-5.6-sol` request with a
   top-level `function_call` named `exec_command` **[V]**. A code-mode model would call
   `functions.exec` instead **[V, captured tool set]**. The suite cannot detect the §1 point 2
   failure **[I]**.
10. **Credential forwarding and placeholder: unchanged for Reprove's inputs.** `codex-auth.ts`,
    core `credential-forwarding.ts` and `sandbox-credential-brokering.ts` are byte-identical
    **[V]**. New `resolveCodexAuthentication` can read a native ChatGPT subscription from the
    *host's* `$CODEX_HOME/auth.json` or OS keychain and refresh it against `auth.openai.com`
    (`codex-subscription.ts`, core `native-subscription/*`, change `cdc12a1` in 1.0.110) **[V]**. It
    returns before any of that when `auth` is a flat string record
    (`isHarnessAuthenticationEnvironment(auth)`) **[V]**. `brokered.ts` always passes
    `{ OPENAI_API_KEY }` or `{ AI_GATEWAY_API_KEY }`, so **[I] no ambient host credential is
    consulted**. That depends on keeping `auth` a record; passing `'direct'` or omitting `auth` would
    now reach into host credentials, contrary to docs/codex-adapter.md. Request transformations
    gain `requestHeaders` only on the subscription path **[V]**.
11. **Custom tools relay: unchanged.** `cli-relay.ts`, `tool-relay.ts` and `tool-relay-auth.ts` are
    identical **[V]**. Reprove passes `tools: []`.
12. **Other.** Web search call events now take their query from `item.action.query` and emit a
    single tool-call (1.0.110/1.0.120) **[V]**. Reprove sets `webSearch: false`. Core pins `ai`
    7.0.113 and `@ai-sdk/provider` 4.0.18 **[V]**.

---

## 3. Codex CLI 0.153.4 to 0.156.1 on the surfaces Reprove depends on

| Surface | Finding |
| --- | --- |
| `features.shell_tool` | Still `Stage::Stable`, default `true` (`features/src/lib.rs:960-965`) **[V]**. Setting it `false` removes `exec_command` and `write_stdin` and nothing else: at 0.156.1 `gpt-6-sol` it leaves `apply_patch`, `view_image`, goals and `clock` nested under `exec`, plus the `collaboration` namespace; at 0.153.4 fallback it leaves `request_user_input`, `view_image`, `multi_agent_v1` and goals **[V, captured]**. With real metadata, `shell_tool=false` no longer yields a tool set without a write-capable tool, because `apply_patch` stays **[V]**. Input to #117. |
| `apply_patch` registration | Keyed on `model_info.apply_patch_tool_type.is_some()` at both tags **[V]**; see §1 point 1. |
| `--ignore-user-config`, `--ignore-rules` | Identical definitions, both `global = true` (`exec/src/cli.rs:40-45`) **[V]**, so they still parse after the SDK's trailing `resume <threadId>` **[I]**. Help text: "Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`." and "Do not load user or project execpolicy `.rules` files." **[V]**. `--ignore-rules` still maps to `ignore_user_and_project_exec_policy_rules` **[V]**. New `--worktree` (on by default from 0.156.0) refuses to combine with `--ignore-user-config` **[V]**; Reprove does not pass `--worktree`. |
| `project_doc_max_bytes` | Still read by `load_project_instructions`; `remaining == 0` breaks before any environment is read, and `read_agents_md` returns `None` for `max_total == 0` (`core/src/agents_md.rs:68-72`, `:131-133`) **[V]**. New: host-supplied "thread instructions" are joined alongside user instructions, and a new host contribution is bounded "independently of project_doc_max_bytes" (`agents_md_manager.rs`) **[V]**. **[I]** Neither is repository-sourced. The ADR 0009 canaries decide (live check). |
| `skills.include_instructions` | Same `SkillsConfig.include_instructions: Option<bool>` and the same consumers **[V]**. `skills_extension` tests changed substantially **[V]**, so canary re-run needed **[I]**. |
| Repo MCP / instruction discovery | No change found to how `--ignore-user-config` gates config layers in `exec/src/lib.rs` outside the new worktree branch **[V]**. The canary is still the only proof **[I]**. 0.154.0 notes: "Startup avoids running workspace-controlled helpers before trust is established" **[V, release notes]**. |
| `OPENAI_API_KEY` / `CODEX_API_KEY` | `exec` still builds its auth manager with `enable_codex_api_key_env: true`; `CODEX_API_KEY` and `OPENAI_API_KEY` constants unchanged **[V]**. New OAuth "gateway auth" module (`login/src/gateway_auth*.rs`), only reached when configured **[V exists / I not engaged]**. |
| Turn interrupt | See §2.8. |
| Exec-mode resume | SDK still emits `exec ... resume <threadId>` **[V]**. 0.154.0 to 0.156.0 notes mention resume fixes for remote resume and Plan mode **[V]**. |
| JSONL event schema | Only web-search items changed (structured `action`, new `results`) **[V]**. |

---

## 4. Can the bridge and the CLI move independently?

**Yes at the SDK API level.** `@openai/codex-sdk` `dist/index.js` has the same SHA-256
(`d62ed107033bdba8...`) at 0.149.1, 0.153.4, 0.155.0 and 0.156.1; `dist/index.d.ts` is identical
from 0.153.4 to 0.156.1 (0.149.1 differs only by adding `"persistent"` to `ModelReasoningEffort`)
**[V]**. The bridge talks to the CLI only through that SDK, so bridge 1.0.104 drives
`@openai/codex-sdk` 0.156.1 exactly as it drives 0.153.4 **[V]**. The only CLI-to-bridge contract is
the JSONL event stream, whose schema changed only for web search **[V]**. **[I] Bumping only the
Adapter lock to 0.156.1 and keeping bridge 1.0.104 is the smallest change that yields `gpt-6-sol`
metadata.** It needs no code change beyond `CODEX_CLI_VERSION` and the lock.

**The bridge and the core must move together.** `@ai-sdk/harness-codex` 1.0.125 depends on
`@ai-sdk/harness` exactly `1.0.123`, and 1.0.104 on exactly `1.0.102` **[V, package.json]**.

**Moving the bridge to 1.0.125 is three breaking changes for Reprove** **[V for the upstream
change, I for the Reprove consequence]**:

1. `createCodex({ model })` removed; pass `model` per turn (§2.1).
2. Bootstrap and session-state paths move under `$HOME/.ai-sdk-harness` (§2.6).
3. `createReadBridgeAsset` changed signature (map of literal URLs) **[V]**. Reprove does not call
   it **[V, grep]**.

Nothing in 1.0.105 to 1.0.125 is needed for `gpt-6-sol`. Its benefits to Reprove are the
`SandboxChannel` abort and ordering fixes and the configurable reconnect window **[I]**.

---

## 5. Open upstream issues relevant here (as of 2026-09-24)

| Issue | State | Relevance |
| --- | --- | --- |
| [openai/codex#31894](https://github.com/openai/codex/issues/31894) "gpt-5.6 Responses Lite turns do not expose exec/code-mode tools in codex exec" | open since 2026-07-09; last comment 2026-09-16 | §1 point 2. The 0.156.1 request shape is the one described. Cited by the bridge source as the reason its default is `gpt-5.5`. |
| [openai/codex#47490](https://github.com/openai/codex/issues/47490) "Tool execution times out on GPT-5.6 Sol and GPT-6 Astra while GPT-5.5 works" | open, on `codex-cli 0.156.1` | Same model family (code-mode, Responses Lite); labels `tool-calls`, `connectivity`. |
| [openai/codex#47656](https://github.com/openai/codex/issues/47656) "GPT-6 Sol tasks taking 40+ minutes" | open (Codex app) | Latency input to Pass deadlines; app, not CLI. |
| [openai/codex#47420](https://github.com/openai/codex/issues/47420) "No GPT-6 Sol" | open | Resolved in effect by 0.156.1. |
| [openai/codex#47333](https://github.com/openai/codex/issues/47333), [#46304](https://github.com/openai/codex/issues/46304) | open | `gpt-6-sol` rejected for some ChatGPT accounts. Relevant only to the native route. |
| [openai/codex#45993](https://github.com/openai/codex/issues/45993), [#47041](https://github.com/openai/codex/issues/47041), [#46093](https://github.com/openai/codex/issues/46093) | open | `invalid_prompt` rejections of benign prompts on GPT-6 Astra / GPT-5.6 Sol. Not reported for `gpt-6-sol` yet; worth watching for review prompts. |
| [openai/codex#31843](https://github.com/openai/codex/issues/31843) "GPT-5.6 models get no tools in read-only sandbox" | closed | Related history; Reprove uses `danger-full-access`. |
| [vercel/ai#18609](https://github.com/vercel/ai/issues/18609) "support provider-native process/filesystem semantics and preinstalled adapter payloads" | open | Would replace Reprove's bootstrap symlink. |
| [vercel/ai#16379](https://github.com/vercel/ai/issues/16379) "spawn E2BIG when a large host tool catalog is passed through the codex config command line" | open | Not hit (`tools: []`). |

No open vercel/ai issue was found on silent `rerun`, interrupt or per-turn usage for
`harness-codex` **[V, `gh search issues`]**.

---

## Implications for #130's checklist

- **The pin moves for the metadata, and the metadata is the risk.** `gpt-6-sol` on 0.156.1 stops
  being a fallback-metadata, direct-tools model and becomes a Responses Lite, code-mode-only model
  like `gpt-5.6-sol`. The bridge authors avoid that path over a custom provider **[V]**, and Reprove
  has no evidence either way **[I]**. A live `gpt-6-sol` turn on 0.156.1 that runs a command is the
  gating check. If it fails, the two workable choices are staying on fallback metadata
  deliberately, or overriding the catalog through `model_catalog_json` (a `config.toml` key at both
  tags, `config/src/config_toml.rs:391`) **[V exists / I usable via `codexConfig`]**.
- **The same question applies to the current default `gpt-5.6-sol`** **[I]**. Nothing in the repo
  shows a live brokered `gpt-5.6-sol` turn running a command.
- **CLI-only bump is cheap; bridge bump is not.** A CLI-only bump needs a lock regeneration. A
  bridge bump also needs the per-turn `model`, a moved preflight symlink and hosted bootstrap path,
  and a fresh qualification of the changed channel code.
- **#117:** `shell_tool=false` still removes shell execution, but no longer leaves a
  read-only-shaped tool set, because `apply_patch` and multi-agent `collaboration` tools remain on
  the new pin.
- **#128:** silent `rerun` fallback unchanged.
- **#129:** still no graceful interrupt; abort kills the process.

## Assumption -> status on new pin

| Assumption (what rested on the old pin) | Status on 0.156.1 CLI (+ bridge 1.0.125 where noted) |
| --- | --- |
| `gpt-6-*` metadata fallback warning appears | **changed**: gone for `gpt-6-sol` at 0.156.1 [V] |
| `apply_patch` not registered for `gpt-6-sol` | **changed**: registered (nested under code-mode `exec`) [V] |
| `gpt-6-sol` uses plain top-level tools (the #114 path) | **changed**: Responses Lite + code-mode-only [V]; whether tools are callable: **unknown, needs live check** |
| Observed commands arrive as `command_execution` / bridge `bash` events | **unchanged** [V simulated]; live model behaviour **unknown, needs live check** |
| Harness throws on non-`allow-all` `permissionMode` and on `builtinToolFiltering` | **unchanged** [V] |
| Bridge forces `danger-full-access` + `approval_policy=never` after `codexConfig` | **unchanged** [V] |
| `features.shell_tool` exists and removes shell execution | **unchanged** flag [V]; residual tool set **changed** (`apply_patch`, `collaboration`) [V] |
| Image's checked insertion at `new codexSdk.Codex({` matches | **unchanged** on 1.0.125 [V] |
| `--ignore-user-config` / `--ignore-rules` accepted by `codex exec` (incl. resume) | **unchanged** [V] |
| `project_doc_max_bytes=0`, `skills.include_instructions=false` suppress discovery; ADR 0009 canaries hold | code path **unchanged** [V]; canaries **unknown, needs live check** (probe re-run) |
| Probe's canary detection works on the request body | **unchanged**: whole-body substring match, so shape-independent [V] |
| Credential forwarding + placeholder check; no ambient host auth | **unchanged** while `auth` stays a flat record [V]; new host-credential path exists in 1.0.125 [V] |
| `createCodex({ model })` selects the Model | **changed on bridge 1.0.125**: removed, default `gpt-5.5`, pass `model` per turn [V] |
| Bridge state and bootstrap under `/reprove/runtime` (preflight symlink) | **changed on bridge 1.0.125**: `$HOME/.ai-sdk-harness` [V] |
| attach -> replay -> rerun ladder; silent `rerun` fallback | **unchanged** [V] |
| Cursor carries bridge port + token | **unchanged** [V] |
| Bridge cannot gracefully interrupt a running turn (abort kills the CLI) | **unchanged** [V code]; [I] behaviour |
| Slice Usage zero until `finish` | **unchanged** [V] |
| Instruction probe cost | **unknown, needs live check** (Responses Lite request shape and `gpt-6-sol` price differ) |
| Bridge 1.0.104 works with CLI/SDK 0.156.1 | **unchanged** SDK API (identical JS) [V]; runtime **needs `pnpm verify` + live check** |
| Bridge and core pin independently | **no**: 1.0.125 requires core exactly 1.0.123 [V] |
| Priority service tier billed by default for `gpt-6-sol` | **not sent** on this route (`service_tier: null`) [V] |

## Appendix: reproducing the captures

Binaries from `npm pack @openai/codex@<v>-linux-x64`. The capture server wrote each request body to
disk and answered `400` (shape capture) or a scripted SSE stream (simulation). Invocation, per run:

```sh
HOME=$dir/home CODEX_HOME=$dir/home/.codex CODEX_API_KEY=sk-dummy-capture \
  codex exec --experimental-json \
  --config 'model_provider="agent_bridge_openai"' \
  --config "model_providers.agent_bridge_openai={name=\"Agent Bridge OpenAI\",base_url=\"http://127.0.0.1:$port/v1\",env_key=\"CODEX_API_KEY\",wire_api=\"responses\",supports_websockets=false}" \
  --config 'project_doc_max_bytes=0' --config 'skills.include_instructions=false' \
  --config 'model_reasoning_effort="medium"' --config 'approval_policy="never"' --config 'web_search="disabled"' \
  --model "$model" --sandbox danger-full-access --cd "$dir/ws" --skip-git-repo-check [extra --config] \
  'run ls' --ignore-user-config --ignore-rules < /dev/null
```

The simulated code-mode reply was a Responses `custom_tool_call` item
`{ namespace: "functions", name: "exec", input: "const r = await tools.exec_command({cmd: \"echo reprove-canary-$((6*7))\"}); text(r);" }`,
followed on the next request by an assistant message. These captures omit the bridge's
`developer_instructions`, `model_reasoning_summary` and output schema, which do not affect tool
registration **[I]**.
