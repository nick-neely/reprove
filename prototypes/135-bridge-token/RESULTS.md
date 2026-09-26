# PROTOTYPE for #135: results

**Verdict: pass.** On a real Vercel Sandbox (`@vercel/sandbox` 3.5.0, Harness 1.0.102, Codex
Harness 1.0.104, Codex CLI and SDK 0.156.1, `gpt-6-sol`), the ADR 0031 launch path keeps the bridge
token away from the Reviewer. Every check in [#135](https://github.com/nick-neely/reprove/issues/135)
passed on two full runs (`out/run-4.log`, `out/run-5.log`). One check is worded wrongly in the
ticket (see "Codex's environ" below), but the invariant behind it holds. The `ubuntu`-launch fallback
was not needed.

Run it with `npm i && node prove.mjs`. It uses the #114 rig's credentials
(`~/.config/reprove-proto-114/env` plus the Vercel CLI login). The Provider credential is a
firewall header transform (the #114 `b0` scaffold), not the ADR 0021 proxy. That is out of scope
here, and the real key never enters the VM.

## What was run

`prove.mjs` builds everything in a fresh Sandbox:

- the pinned 0.156.1 bootstrap files, snapshotted from the #131 Adapter build
  (`codex-image-0.156.1.json`);
- the ADR 0031 §6 bridge patch: a 64-hex check before binding, and `timingSafeEqual`, each replace
  asserted to match exactly once;
- the §5 two-stage wrapper (`sandbox/reprove-codex`, `sandbox/reprove-codex-stage2`);
- a Reviewer uid 2000 with no sudoers rule;
- `.agent-runs` as `0700 ubuntu`.

It then drives the real Harness. `mintBridgeToken` returns a host-generated CSPRNG token and throws
on a second call. The session's `io.id` is the recorded instance ID, and the bridge is spawned with
`runCommand({ sudo: true, env, detached: true })`. Every check runs between `doStart` and
`doPromptTurn`, and again during and after one real Codex tool call. The token is never printed.
Host-side comparisons use a hash prefix, and every artifact write is refused if it contains the
token or the key.

## Results (run 5)

| Check | Result |
|---|---|
| Reviewer `id` | `uid=2000(reviewer) groups=2000`, `NoNewPrivs 1` |
| `sudo -n true` as Reviewer | denied (exit 1). `sudo -l -U reviewer`: "not allowed to run sudo". Sudoers has only `ubuntu ALL=(ALL) NOPASSWD:ALL` |
| Reviewer reads bridge `/proc/<pid>/environ` (node and its `sh -c` parent) | denied |
| Reviewer lists `.agent-runs`, lists the bridge dir, reads `bridge-meta.json` and `event-log.ndjson` | all denied |
| Loopback WS as Reviewer: absent, empty, `abc`, wrong 64-hex, wrong uppercase | all closed `1008`, 0 messages |
| Public `sandbox.domain(3000)`: absent, empty, wrong | all closed `1008` |
| Public route with the correct token (positive control) | `bridge-hello`, so the `1008`s are refusals and not a broken route |
| Token in any `/proc/*/cmdline` (idle and during the tool call) | none |
| Processes whose environ holds the token | exactly three: `sudo` (uids 1000/0/0/0, setuid), its root `sh -c`, and the root bridge. None is readable by the Reviewer |
| Vercel command history (22 records via raw `GET …/cmd/<id>`, plus the list endpoint) | token absent. Records carry `id, name, args, cwd, sessionId, startedAt, exitCode, durationMs`, with no `env` field |
| Tool call (Codex `bash`) uid and `no_new_privs` | 2000, `1` |
| `BRIDGE_*` in the tool's environment | 0 |
| Tool's ancestors: `sh`, `codex`, the npm `codex` node launcher | environ **readable** (same uid), 0 `BRIDGE_*` names in each |
| Tool's ancestors: bridge, root `sh`, `sudo`, `sandbox-init` (pid 1) | environ denied |
| `HOME`, `CODEX_HOME` | `/home/reviewer`, `/home/reviewer/.codex`, both Reviewer-owned |
| `ubuntu` file API reads `bridge-meta.json` and `event-log.ndjson` in the `0700` dir | yes (57 B, `waiting`; 2571 B, 10 lines). Token in neither |
| Session `id` across `Sandbox.get` by name | `sbx_…` identical to the recorded instance ID |
| Patched bridge on port 3001: unset, empty, `abc`, 63 hex, 65 hex, uppercase, non-hex | exit 78, never bound. The valid control bound (`bridge-ready`), then timed out |

## Findings that change the ADRs

1. **Codex's environ is readable by the Reviewer, and that is fine.** Codex, its npm node launcher
   and the tool shell all run as the Reviewer uid, so a tool can read their `/proc/<pid>/environ`.
   The ticket's check "`/proc/$PPID/environ` (Codex) cannot be read" is false as worded. The
   invariant that matters holds: the wrapper strips the `BRIDGE_*` variables before `setpriv`, so no
   process the Reviewer can read carries the token. The permanent check should be exactly that: the
   token is in no Reviewer-readable environ and no cmdline.
2. **How `sudo: true` works on this image.** The in-VM agent runs `sudo sh -c <cmd>` as `ubuntu`,
   and `/etc/sudoers.d/sandbox` sets `Defaults !env_reset`. So the `env` passed to `runCommand`
   survives into root, and it also sits in the environ of the setuid `sudo` process, whose real uid
   is 1000. That process is protected by setuid non-dumpability, not by its uid. The Reviewer cannot
   read it. `ubuntu` is root-equivalent anyway.
3. **The `ubuntu`-launch fallback in ADR 0031 §4 would not work as written on this image.** With
   `!env_reset`, a `sudo -n` preserve list filters nothing, so the wrapper would need `env -i` or
   explicit `unset`. The fallback is not needed, but its wording should say so.
4. **`.agent-runs/<id>` is keyed by `doStart`'s `sessionId` (the Pass ID), not by the session
   `io.id`.** `io.id` feeds only `bridge.sandboxId` and `mintBridgeToken`. ADR 0031 §2 says the
   instance ID feeds both.
5. **The Reviewer's tool environment carried `SUDO_COMMAND`, `SUDO_USER`, `SUDO_UID`, `SUDO_GID`
   and `SUDO_HOME`** in runs 4 and 5. They held no secret, but they reached the Reviewer only
   because the wrapper removed four named variables from an environment that `!env_reset` passes
   whole. That is fixed in run 6 below.
6. **The stock image moved.** It is now Ubuntu 26.04, `/vercel/sandbox` does not exist until created,
   and `/usr/local/bin` and `node` are owned by uid 1001, which has no passwd entry. A Reviewer created
   with the next free uid would own `node`, which is the #114 observation. The Reviewer uid must be
   fixed away from 1001, and the privilege preflight (ADR 0024 §7) should check it.

## Spend

Five Sandbox sessions of 1 to 2 minutes each: two failed during setup, then three full runs (the
first attempt failed Vercel auth before creating one). There were three `gpt-6-sol` turns of about
19k input tokens (about half cached) and 460 to 810 output tokens each, about $0.08 in total. That is well inside the ticket's $1 and five-session bound.

## Follow-up: an allowlisted Reviewer environment (run 6)

`sandbox/reprove-codex` no longer removes named variables. It starts the Reviewer from `env -i`
and sets a fixed `PATH`, `HOME`, `CODEX_HOME`, `USER`, `LOGNAME`, `SHELL` and `LANG`. From the
bridge it carries only `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
and the CA-bundle variables, when they are set. The values travel as a heredoc on fd 3 that the
`env -i` shell sources, never on a command line. A local test passed values containing quotes, `$`,
backticks and newlines through intact, and dropped the token, `SUDO_*` and a variable whose name is
not a shell identifier. `out/run-6.log`:

| Check | Result |
|---|---|
| Names that reached the wrapper, recorded by name only | 30, including `BRIDGE_*`, `AI_SDK_HARNESS_CLIENT_APP`, five `SUDO_*` and `TERM` |
| Dropped by the wrapper | exactly those nine |
| First Reviewer process (the npm `codex` launcher) | every name is on the allowlist except `NODE_PATH`, which pnpm's `.bin/codex` shim exports after the wrapper |
| `SUDO_*` and `BRIDGE_*` in the tool's environment | none |
| Names Codex adds for its tools | `CODEX_CI`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_VERSION`, `CODEX_MANAGED_*`, `TERM`, `COLORTERM`, `NO_COLOR`, the pagers, `LC_ALL`, `LC_CTYPE` |
| Provider reachable | yes: the turn completed (18.9k input, 808 output tokens) |
| TLS from a tool through the firewall | `curl` 401 and Node `fetch` 401 from `api.openai.com`, so the CA-bundle variables are enough |
| Every run-5 check | unchanged: refusal, `1008`s, positive control, no token in any cmdline or command history, stable session `id` |

The permanent check this adds is that the first Reviewer process's environ names are a subset of
the allowlist plus the image shim's `NODE_PATH`.
