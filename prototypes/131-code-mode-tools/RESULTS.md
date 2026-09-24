# #131: do code-mode tools run on a brokered Codex turn?

Live check for [#131](https://github.com/nick-neely/reprove/issues/131), run 2026-09-24 against
the real OpenAI Responses API. Throwaway branch `prototype/131-code-mode-tools`, never merged.

**Answer: yes, on all three configurations, 13 of 13 live Passes.** Every Pass ran both commands
and the model's final answer carried both nonces. The model called the tools as code-mode
`exec` custom tool calls on the Responses Lite request shape, and as direct `exec_command`
function calls on the fallback shape. No run hit `invalid_prompt`, an HTTP error or a tool timeout.
All instruction probes were satisfied.

**A separate Adapter defect showed up along the way.** The Adapter failed every `gpt-6-sol`
Pass with `result_invalid`, on both pins, although the model's final answer was valid. The cause
is that `brokered.ts` joins every `text-delta` in a turn into one string. That includes the
model's `phase: "commentary"` preamble ("I'll run the two commands ..."), so the joined text is
not JSON (see [Adapter answer defect](#adapter-answer-defect)). `gpt-5.6-sol` hit the same
defect but recovered in its repair turn.

## Method

- **What ran.** This was the real Adapter (`packages/adapters`, built from this branch) against
  real Docker. Each run did two things:
  1. `probeCodexInstructions` in its own Sandbox, seeded with `CODEX_PROBE_FILES`, as
     `docs/codex-adapter.md` prescribes.
  2. `createCodexAdapter(...).pass(...)` in a second Sandbox, with the probe's proof as
     `instructionProbe`.

  The inputs were `authentication: { kind: "api-key", provider: "openai" }`, reasoning effort
  `medium` and `timeoutMs: 240000`. The path was bridge `@ai-sdk/harness-codex` 1.0.104 and core
  1.0.102 → custom provider → host proxy (placeholder → real key) → `api.openai.com/v1/responses`.
- **The only substitution.** The Adapter's documented `fetch` option (Provider HTTP boundary)
  wraps the platform `fetch`. It records the request that the proxy has already rewritten and
  the reply, and returns the reply unchanged. The real key is added by the proxy and was never
  written anywhere: the authorization header is logged only as a length, and every artifact is
  scanned for the key and for `sk-` before it is written.
- **Images.** `build-images.mjs` mirrors `tools/build-codex-image.mjs` but writes per-lock tags
  (`reprove-codex-131:<cli>-1.0.104`), so the shared `reprove-codex:0.153.4-1.0.104` image was
  never touched.
- **The 0.156.1 lock.** It is `bootstrap-0.156.1.patch`: `CODEX_CLI_VERSION` and the Adapter-owned
  frozen lock, regenerated with `pnpm install --lockfile-only --ignore-scripts`. The regenerated
  lock has the same shape as the 0.153.4 one, with only the versions and integrity hashes
  changed. That Adapter build was copied to `packages/adapters/dist-0156`, which is not committed.
  The bridge and core were unchanged.
- **Pass prompt.** The policy asked the model to run `cat /reprove/workspace/nonce.txt` (a
  root-owned `0444` file holding a random `n1-...`) and `echo n2-...`, then return
  `summary: "file=<...> echo=<...>"`, writing `NO_TOOL` rather than guessing.
- **What counts as tool execution.** A run passes only if the Adapter's own `observed` stream
  (bridge `bash` tool-call/result pairs) has both commands with exit 0, and the model's
  first-turn final answer has both nonces. `n1` exists only inside the Sandbox file.
- **Spend ledger.** `out/ledger.jsonl` records one line per Provider response, from
  `response.completed.usage`. Prices, in USD per 1M tokens as input / cached input / output:

  | Model | Input | Cached input | Output | Source |
  | --- | --- | --- | --- | --- |
  | `gpt-6-sol` | 2 | 0.20 | 10 | the brief |
  | `gpt-5.6-sol` | 4 | 0.40 | 20 | assumed: no price exists in the repo |

  Reasoning tokens are counted inside output tokens. The script stops making requests once the
  ledger reaches $2.60.

Reproduce with `node build-images.mjs`, then `node run.mjs <A|B|C|D> <n>`, then `node analyze.mjs`.
The Adapter build for 0.156.1 must be in `packages/adapters/dist-0156`.

## Results

| Config | Runs | Tools executed? | Nonces correct (first turn) | Tool-call shape | Adapter outcome | CLI warnings |
| --- | --- | --- | --- | --- | --- | --- |
| **A** `gpt-6-sol` @ 0.156.1 (real metadata) | 4 | **yes, 4/4** | 4/4 | `custom_tool_call` `exec`, code `await tools.exec_command({cmd, workdir})` | 4/4 `failed/result_invalid` after repair (defect below) | `session-flags: preferred_auth_method is ignored` (new at 0.156.1) |
| **B** `gpt-5.6-sol` @ 0.153.4 (today's default) | 4 | **yes, 4/4** | 4/4 | `custom_tool_call` `exec` | 4/4 `completed`, `repairTurnUsed: true` every time | none |
| **C** `gpt-6-sol` @ 0.153.4 (fallback, control) | 3 | **yes, 3/3** | 3/3 | `function_call` `exec_command` | 3/3 `failed/result_invalid` after repair | `Model metadata for gpt-6-sol not found. Defaulting to fallback metadata` |
| D (ablation) A + Responses Lite header injected | 2 | yes, 2/2 | 2/2 | same as A | same as A | same as A |

### Request shape at the proxy (first Pass request)

| Config | Top-level `tools` | `instructions` | `input[0]` | `parallel_tool_calls` | Lite header on the wire |
| --- | --- | --- | --- | --- | --- |
| A | key absent | key absent | `additional_tools`: `functions[exec,wait,request_user_input,request_user_input_async]`, `clock[sleep]`, `collaboration[followup_task,interrupt_agent,list_agents,send_message,spawn_agent,wait_agent]` | false | **absent** |
| B | key absent | key absent | `additional_tools`: `functions[exec,wait,request_user_input]`, `collaboration[...]` | false | **absent** |
| C | `exec_command, write_stdin, request_user_input, view_image, multi_agent_v1[...], get_goal, create_goal, update_goal` | 16,979 chars | message | true | absent |

On all three configurations:

- The forwarded headers were `accept`, `authorization`, `content-type` and `x-codex-turn-metadata`.
- Every request had `text.format` `json_schema` (strict) and `reasoning.effort: "medium"`.
- `service_tier` was absent from the request, and the response reported `service_tier: "default"`.
- Every HTTP status was 200 and every response was `response.completed`.

**Why the Lite header is absent** (observed, with the cause read from code): the host proxy
forwards only the headers in `FORWARDED_HEADERS` (`packages/sandbox-container/src/proxy.ts:48`),
and `x-openai-internal-codex-responses-lite` is not in that list. The research doc captured the
CLI sending it. So on Reprove's real route, the Provider gets a Lite-shaped body without the Lite
header. That did not stop tools from running. Ablation D put the header back after the proxy and
changed nothing observable.

### How `command_execution` Evidence arrives

The path is the same on every configuration:

1. The CLI emits `command_execution`.
2. The bridge turns it into `tool-call` `bash` (`nativeName: "shell"`, `providerExecuted: true`,
   input `{"command":"/bin/bash -lc '<cmd>'"}`) and then `tool-result` (`{exitCode, output}`).
   You can see this in the bridge `event-log.ndjson` copied out of each Pass Sandbox.
3. `observed` records it as, for example, `/bin/bash -lc 'cat /reprove/workspace/nonce.txt' => 0`.

In code mode, one `exec` custom tool call that makes a nested `tools.exec_command` produces one
observed command. The code-mode `exec` wrapper itself is not observed. The CLI rollout records the
`custom_tool_call`/`custom_tool_call_output` pair.

### Instruction probe (ADR 0009 canaries) and per-turn cost

All 13 probes returned `satisfied: true`:

- no canary appeared in any Provider request body;
- `/tmp/reprove-canary-executed` was absent, so the repository MCP server did not run;
- the answer completed.

Per-run averages:

| Config | Probe input tok | Probe output tok | Probe cost | Pass requests | Pass input (cached) tok | Pass output tok | Pass cost | Pass wall time | Slowest request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 9,383 | 53 | $0.0193 | 6 | 58,721 (48,582) | 485 | $0.0348 | 17.2 s | 3.9 s |
| B | 8,599 | 27 | $0.0349* | 4 | 35,466 (26,419) | 324 | $0.0532* | 14.6 s | 4.4 s |
| C | 7,028 | 59 | $0.0146 | 6 | 44,202 (36,529) | 388 | $0.0265 | 18.5 s | 7.1 s |
| D | 9,383 | 52 | $0.0108† | 6 | 58,848 (48,655) | 510 | $0.0352 | 16.9 s | 4.0 s |

- \* At the assumed `gpt-5.6-sol` price.
- † One D probe hit the prompt cache (9,380 of 9,383 input tokens cached, $0.0024).
- Pass figures cover both turns (first turn and repair).
- The Adapter's cumulative `usage` matched the sum of the ledger's per-request usage.
- Real metadata raises the probe's input tokens by about 33% over fallback (9,383 vs 7,028).

**Total spend: $0.7994** across 27 probe and Pass invocations and 84 Provider requests,
including one aborted probe (`C-r0-aborted`, $0.0146, a bug in my collector script). That is
under the $3 cap.

## Adapter answer defect

The model sends a short `phase: "commentary"` message before its tool calls and a
`phase: "final_answer"` message at the end. The bridge emits both as `text-delta` events on
separate text items (`item_1`, `item_4` in `out/C-r1/pass-*event-log.ndjson`).
`packages/adapters/src/brokered.ts` does `text += event.delta` for every one, and
`parseAnswer(text)` then fails:

- **`gpt-6-sol` (A, C, D).** The commentary is prose, so the joined text is
  `I'll run ...{"summary":...}`. The repair turn re-runs the commands with another commentary
  message and fails the same way. The result is `result_invalid` 9/9. The final answer on its
  own parsed and was correct 9/9.
- **`gpt-5.6-sol` (B).** The commentary is itself schema-shaped JSON
  (`{"summary":"I'll run ...","findings":[]}`), so the joined text is two JSON objects and fails.
  The repair turn runs no tools and emits one message, so the Pass completes. It completes only
  because of the repair: 4/4 used their one repair turn. **[I]** Any real review Pass with a
  preamble spends its repair budget on this, and a repair turn that calls tools again fails the
  Pass.

**[I]** #114 did not see this because its workflow stored the raw joined `text` without running
`parseAnswer`. A contract-suite fixture that emits a commentary message before a tool call would
catch it. Keeping only the last text item, or only `final_answer`-phase text, looks like the
narrow fix. Not changed here: that is out of scope.

## Against `docs/research/codex-pin-bump-0156.md`

- **§1 point 2 / #31894 risk: not borne out on this route.** `additional_tools` with code-mode
  `exec` over the custom provider is callable for both `gpt-6-sol` @ 0.156.1 and `gpt-5.6-sol`
  @ 0.153.4, 8/8 (10/10 with D). The bridge authors' comment in 1.0.125 does not match what
  this API did on 2026-09-24.
- **"Lite header present" (§1 table) is true of the CLI, not of what reaches OpenAI.**
  Reprove's proxy strips it (see above). The research captures bypassed the proxy.
- **§1 point 3 confirmed live.** Nested code-mode commands arrive as `command_execution` and
  become `bash` observed Evidence.
- **§1 point 4 confirmed.** The fallback warning appears at 0.153.4 and not at 0.156.1. At 0.156.1
  there is a new warning: the CLI ignores `preferred_auth_method`, which bridge 1.0.104 sets whenever it uses a custom base URL (`dist/bridge/index.mjs`). It
  was harmless in these runs.
- **Service tier.** The research says the request had `service_tier: null`. Here the key was
  absent after the proxy. Either way it was not priority: responses reported `default`.
- **Instruction probe cost (left "unknown" in the research).** Measured above; the canaries held
  on 0.156.1.
- **No sign of #47490 tool timeouts** (slowest request 7.1 s) or of `invalid_prompt`.
  **[I]** These prompts were tiny and benign, so this does not show the absence of either on
  real review prompts.

## Raw logs (`out/`)

| File | Contents |
| --- | --- |
| `ledger.jsonl` | Spend ledger, one line per Provider response. |
| `summary.json` | Per-run digest from `analyze.mjs`. |
| `<run>/result.json` | Nonces, probe verdict, Adapter output (`observed`, `usage`, progress events). |
| `<run>/requests.jsonl` | Per-request metadata: redacted headers, body shape, output items, terminal event, usage, latency. |
| `<run>/bodies/` | Full request bodies and raw SSE replies. Kept complete for `*-r1` only; later runs keep the first probe and Pass request. |
| `<run>/{probe,pass}-*rollout*.jsonl` | CLI session rollout copied out of the Sandbox. |
| `<run>/{probe,pass}-*event-log.ndjson`, `*start-config.json` | Bridge state. The event log covers the last turn only. |
| `<run>.console.txt` | Host stdout/stderr, including CLI warnings. Missing for `C-r1`, whose warning was seen on the terminal only. |
