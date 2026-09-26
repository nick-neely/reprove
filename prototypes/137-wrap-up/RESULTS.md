# #137 results: a deadline wrap-up on a long review thread

PROTOTYPE, never merged. Answers [Measure a deadline wrap-up on a long review
thread](https://github.com/nick-neely/reprove/issues/137) for [ADR
0032](../../docs/adr/0032-deadline-wrap-up-turn.md).

Setup: a real Vercel Sandbox (iad1, 2 vCPU). It runs the #135 image: Codex CLI 0.156.1, Harness 1.0.104, the patched
bridge, the allowlist wrapper and Reviewer uid 2000. The instructions are the ADR 0020 `verify` policy from the #114 rig.
The Provider credential is a firewall header transform, not the ADR 0021 proxy. The driver runs on the exe.dev host,
where `runCommand` costs 330-370 ms and a Neon `select 1` costs 70 ms. A Workflow step beside the Sandbox and store
would pay less. Raw per-run records are in `out/p137-*.json` and logs in `out/*.log`.

| Run | Model | Context at A | A lands in | Reserve (A to persisted) |
|---|---|---|---|---|
| `p137-long-muhru03k` | gpt-6-sol | 199,574 | review turn, a request in flight | **16.0 s** |
| `p137-long-muhrojsv` | gpt-6-sol | 162,418 | review turn, a request in flight; wrap-up hit TPM | **18.7 s** (Codex finished; Harness had failed the turn) |
| `p137-repair-muhrmiro` | gpt-6-sol | 12,700 | repair turn, first request in flight | **19.7 s** |
| `p137-repair-muhrekel` | gpt-6-luna | 12,712 | repair turn | 18.0 s |
| `p137-repair-muhrbv3r` | gpt-6-luna | 14,042 | after the repair turn completed | 15.0 s |
| `p137-long-muhrg705` | gpt-6-luna | 42,893 | after the turn finished | 19.6 s |

## 1. The reserve

| Step | Observed (ms) |
|---|---|
| abort, turn settles | 1-2 |
| `doStop()` returns `threadId` | 280-1,120 after A |
| quiescence proof done | 780-1,470 after A |
| custody transaction (5 statements, Neon, from this host) | 1,150-1,840 (one cold 4,480) |
| generation-2 `doStart({ resumeFrom })` | 1,540-2,120 |
| ADR 0031 §7 bridge checks on the new idle bridge | 1,570-2,150 |
| **wrap-up turn** (prompt to finish) | **8,200-12,200** |
| validate + persist | 640-680 |

Everything except the wrap-up turn totals about **6-7 s**. The wrap-up turn dominates, and on these runs output length
drives it more than thread length: at 200K context with a warm cache, the turn took 8.7 s for 127 output tokens. Two
measured effects make the worst case larger:

- **The prompt cache is not reliable across a short gap.** In `muhru03k`, the review turn's first request came about
  100 s after the last seed, and it hit **0 cached tokens** out of 199,574. Its prefill plus 128 output tokens took about 11 s.
  The wrap-up's own re-read was cached (199,755/199,839) on every long run, including across the bridge respawn, but
  the reserve cannot assume it.
- **The tokens-per-minute limit binds on a long thread.** On this org, gpt-6-sol allows 500K TPM (gpt-6-luna 200K), and
  cached input counts toward it: luna's 429 read "Requested 67,223" on a mostly cached context. A 160-200K thread
  supports about 2.5 requests a minute. In `muhrojsv`, the aborted turn had just spent 487K. The wrap-up request was
  throttled ("Used 374,471, Requested 164,213, try again in 4.6 s"), and Codex retried and finished 11 s after its first
  event. The wait is bounded by the context divided by the refill rate, about 24 s for 200K at 500K/min.

Worst case from these parts: 7 s of mechanism, plus about 11 s of uncached prefill, plus a TPM wait of up to about 24 s,
plus output. A Findings-heavy answer of about 4K output tokens would take roughly 40-50 s at the observed rates
(inferred, not measured). That is about **90 s**. **Three minutes holds with about 2x headroom over that estimate**, and
more than 8x over anything observed. [#115](https://github.com/nick-neely/reprove/issues/115) sets the number.

## 2. `toolCallId`

- **Stable across `attach`.** Each run suspended the initial turn twice. The second attach deliberately rewound
  `lastSeenEventId` to the first cursor, so the bridge replayed 2-3 tool results. Every replay carried the same
  `toolCallId` and byte-identical result content (sha over the result). No id was ever reused for a different command.
- **Unique within a turn**, including code-mode's parallel calls in one step (`item_3`, `item_4`).
- **Not unique across turns.** The id is Codex's `item.id`, and numbering restarts with every `codex exec` process, which
  means every turn: `item_2` opens turns 1, 2 and 3 of the same Pass. ADR 0032 §4's key
  `(passId, bridgeGeneration, turnOrdinal, toolCallId)` is **confirmed**. The turn ordinal is load-bearing. The
  generation is redundant while turn ordinals are Pass-wide, but harmless. This holds only while a turn never respawns
  `codex exec` mid-turn, which is the silent `rerun` fallback ADR 0031 already turns into `resume_lost`.

## 3. Usage

- **Codex's `finish` Usage is cumulative for the thread**, and it is restored across processes and bridge generations.
  Every `finish` equals the rollout's running `total_token_usage`. The wrap-up's `finish` in `muhrmiro` is 94,538, which
  is turn 1's 81,100 plus its own 13,438.
- So **the wrap-up's `finish` covers the aborted turn's completed model responses**: any that finished before A are in
  the running total.
- **It never covers the response in flight at A.** Codex records no `token_count` for it, and no later total includes it.
  The run records have one on every abort: the repair turn's first request (about 12.7K input) and the long runs' second
  review request (about 162K and 200K input). Whether OpenAI bills an aborted streamed request's input was not measured
  (no usage-API access here). Treat it as billed. So one full context of input per abort is unmetered by the Harness.
  That gap is the question for [Decide whether the Provider route meters Usage per
  response](https://github.com/nick-neely/reprove/issues/138).
- ADR 0023 attributes Usage as distinct increments. With a cumulative counter, each turn's increment is a difference
  between successive `finish` totals. The aborted turn's completed part surfaces inside the wrap-up's difference, not
  as its own increment.

## 4. Quiescence against a backgrounded Reviewer process

- The Reviewer started the fixture's helper as `setsid nohup node tools/helper.js … &`. The helper ignores TERM and HUP
  and detaches a grandchild into a further session. Both **survived** the abort and `doStop()`. So did a planted
  own-session, double-forked, TERM-ignoring pair.
- A plain `nohup … &` without `setsid` is reaped by Codex code-mode when the command ends, within 300 ms, before it
  even writes its log.
- The abort killed the `codex exec` processes within about 200 ms. `doStop()` removed the old bridge and its listener.
  Neither touched the Reviewer's detached processes.
- `pkill -KILL -u 2000` in a loop, then the proof, **held on every run**: no uid-2000 process, **no zombies** (the
  Sandbox's PID 1 is `sandbox-init` and it reaps), the old bridge pid gone, nothing listening on 3000. It took 1 round
  on five runs and **2 on one**, so the proof must loop, not kill once.
- Step 3 is therefore load-bearing. Without it, Reviewer-detached processes would carry into the wrap-up beside the
  new bridge.

## 5. The rest of the handoff

- **The same thread every time.** `doStop()` always returned a `threadId`, the generation-2 bridge resumed it, a single
  rollout file held every turn, and the final `doStop()` returned the same id. No compaction happened (the window is
  258,400 for both models).
- **Generation-2 bridge checks pass.** The Reviewer cannot sudo, read the bridge environs or read `.agent-runs`, and
  every guessed token gets `1008` on loopback. On the public route, absent, wrong and the **generation-1 token** all get
  `1008`. The only token holders are setuid `sudo` (real uid 1000), its root `sh` and the root bridge, as #135 found.
- **The wrap-up prompt (v0 in `wrapup.mjs`) worked.** Across 6 wrap-ups there were zero tool calls and every answer
  was schema-valid. `muhrmiro` kept its two verified Findings with `unfinished: null`. `muhru03k` returned no Findings
  and an honest `unfinished`, and recorded "the review was stopped" as a Limitation, which the Check already says.

## 6. Two defects found on the way

- **A Codex reconnect fails the turn.** When Codex hits a 429 (or any stream error), it emits
  `Reconnecting... n/5 (…)` and retries. The bridge forwards that as an `error` frame. Harness 1.0.104 settles the turn
  as rejected on any `error` frame, and Reprove's brokered Adapter marks the turn failed on `event.type === "error"`
  (`packages/adapters/src/brokered.ts:272`). Meanwhile Codex keeps running and completes the turn: 11 s later in
  `muhrojsv`, with the Harness no longer listening. On this tier, any thread over about 150K tokens will meet it, and so
  would a network blip. Filed as an implementation bug outside the map.
- **A continue must carry the same instructions.** This is from reading the pinned Harness source
  (`dist/index.js`, `synchronizeTurnConfiguration`), not measured. `doContinueTurn` fingerprints its `instructions` and
  `tools` too. Omitting `instructions` stores a different fingerprint, and the next `doPromptTurn` with the policy then
  restarts the thread, silently. The #114 rig's `doContinueTurn` omitted them. These runs passed them and stayed on one
  thread.

## Spend

OpenAI, gpt-6-sol, from rollout totals at $2 / $0.20 per 1M uncached / cached input:
- `muhru03k`: about $0.90
- `muhrojsv`: about $0.77
- `muhrmiro`: about $0.05
- plus up to about $0.75 for the three in-flight requests, which the rollouts never recorded (worst case, all
  uncached)

The gpt-6-luna plumbing runs cost well under $0.30. The total is at most about **$2.8 of the $5 bound**. Sandbox time was 7
Sandboxes of 3-9 minutes each at 2 vCPU. One Sandbox leaked when a driver crashed on the unhandled Harness rejection;
it was stopped by name.

## Running it

`npm i` here, then `node wrapup.mjs repair|long [model] [baseFiles]`. Credentials are the #114 rig's
(`~/.config/reprove-proto-114/env`, Vercel CLI login). `P137_ABORT_AFTER=<n>` sets how many review-turn tool results
the long run waits for before A.
