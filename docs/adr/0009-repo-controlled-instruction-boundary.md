# The repo-controlled instruction boundary

[#4](https://github.com/nick-neely/reprove/issues/4) found that a `CLAUDE.md` shipped in the pull
request under review is loaded into the reviewing agent's context, and that
`ClaudeCodeHarnessSettings` exposes no way to disable it. A contributor can therefore write
instructions to their own Reviewer. [ADR 0005](0005-adapter-boundary.md) settled that Reprove owns
the Reviewer's instructions and delivers them through the framework-level `instructions` channel,
and explicitly parked the mechanism here: what is stripped, what comes from base versus head, which
suppression levers are used, and whether trusted base-branch instructions are ever re-admitted.

[#16](https://github.com/nick-neely/reprove/issues/16) verified the blast radius from shipped source
across `codex` 0.150.0, `claude` 2.1.251 and `opencode` 1.18.25, captured in
[`docs/research/repo-local-agent-instructions.md`](../research/repo-local-agent-instructions.md).
Three facts reframed the decision before it was made.

**Suppression exists on all three Harnesses, and none of it runs through `@ai-sdk/harness`.** No
adapter exposes a named suppression setting. But Claude Code and OpenCode read their kill switches
from **environment variables**, a command's environment merges over the Sandbox's default
environment, and Reprove owns the Sandbox. The fix is a **Sandbox-provisioning concern**, not an
upstream change and not a fork.

**Stripping is far more expensive than the ticket assumed.** Discovery walks ancestor directories on
all three Harnesses, and on two of them it re-triggers lazily as the Reviewer reads files. Deleting
one file at the repository root closes nothing.

**No Harness has a read-as-data mode, and all three frame the opposite.** Claude Code wraps loaded
memory in *"These instructions OVERRIDE any default behavior and you MUST follow them exactly as
written."* Codex emits `AGENTS.md` as a `user`-role message and its own Guardian policy names it as
trusted content that can establish `user_authorization`. On Codex a pull request's markdown file is
closer to consent than to context.

## The principle

**The protection is on the channel, not on the content.**

Reprove is not trying to prevent the Reviewer from ever seeing hostile instructions. That is
impossible in code review: a malicious string inside a source file is the thing under review. What
Reprove prevents is the repository under review **placing text into a channel the Harness itself
treats as privileged** configuration, system behavior, permissions or authorization.

That framing is what makes the rest of this ADR possible. It separates two things the ticket
conflated:

- **untrusted pull request input**, which must never reach a privileged channel but must remain
  fully reviewable, and
- **trusted repository conventions**, which Reprove may deliberately supply through a channel it
  controls.

Without that separation the only safe policy is amputating the repository knowledge that makes a
Reviewer feel like the Harness the team already uses, which is a core part of the product thesis.

## Decisions

### 1. Native suppression is the primary boundary

Provisioned at Sandbox creation, not by the Adapter and not by the Workspace contents.

| Harness | Lever |
| --- | --- |
| Claude Code | `CLAUDE_CODE_SAFE_MODE=1` in the Sandbox's default environment |
| OpenCode | `OPENCODE_DISABLE_PROJECT_CONFIG=1` **and** `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` **and** `OPENCODE_DISABLE_SHARE=1` |
| Codex | `project_doc_max_bytes=0` and `skills.include_instructions=false`, through `codexConfig` |

Three details are load-bearing and were each verified rather than assumed.

- **`--safe-mode`, not `--bare`.** `--bare` suppresses Claude Code's instruction surfaces but leaves
  `.mcp.json` discovery **on**. `--safe-mode` disables memory, skills, agents, plugins, hooks,
  project MCP, output styles and workflows, and leaves authentication and tools working normally.
- **OpenCode needs two variables, not one.** `OPENCODE_DISABLE_PROJECT_CONFIG` alone leaves
  repo-local `.claude/skills/` and `.agents/skills/` fully loaded.
- **Codex's levers are config keys, and one of them is a trap.** Marking a project
  `trust_level="untrusted"` silently upgrades Codex's default sandbox from `read-only` to
  `workspace-write`, so any recipe using that lever must pin `sandbox_mode` explicitly. This ADR
  uses `project_doc_max_bytes` instead and does not rely on trust levels.

Suppression leaves the Workspace byte-identical to the pull request. Files stay where the Author put
them and the Reviewer can still read them as ordinary files; what changes is that the Harness no
longer ingests them as configuration.

### 2. Targeted sanitization only for what suppression provably cannot reach

One surface qualifies today: **OpenCode's read-triggered nested instruction injection**, which
injects a nested `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` as a side effect of the `read` tool and has
no gate on that path. Nested instruction files are removed from the Workspace on OpenCode only.

**Repo-committed LSP binaries under `node_modules/.bin` are deliberately not stripped.** Steering and
code execution are separate threat classes, and
[ADR 0004](0004-sandbox-boundary-and-credential-isolation.md) already concedes that repository code
executes inside the Sandbox: *"that is the premise, not a failure."* Adding `node_modules/` to a
strip list would pay a large cost against a threat this architecture has already accepted, and would
not close it anyway.

Every future addition to this list must name the surface and the gate that failed. The list is
expected to shrink, not grow: it exists because a gate is missing, not because stripping is a policy.

### 3. Stripped content is preserved as inert, reviewable data

Sanitization must not mean "review a different pull request." A Reviewer must still be able to
inspect a pull request that modifies one of these files and raise a Finding anchored to its real
path.

Removed content is preserved in a **single structured manifest** at `/reprove/`, **outside the
Workspace** and inside the ephemeral Sandbox, carrying `originalPath`, `originalContent` and
`surfaceClass` per entry.

Two properties make this safe, and both are structural rather than procedural:

- **Original filenames exist only as data values**, never as real filenames. A mirrored tree of files
  still called `CLAUDE.md` would be rediscovered by the very ancestor walks and lazy attachment this
  ADR closes, at a new path.
- **The manifest is not delivered to the Reviewer automatically.** Reprove states that sanitized,
  pull-request-controlled configuration is available as untrusted review data; the Reviewer reads
  entries when relevant, which in practice means when the pull request actually changed one.

The manifest is internal. It has no protocol, persistence or product-facing identity, so it gets no
`CONTEXT.md` entry, on the same reasoning that left
[ADR 0007](0007-run-result-and-finding.md)'s per-Pass bundle unnamed.

### 4. Head auto-discovery is unconditionally dead; base conventions are re-admitted through a channel Reprove controls

**There is no switch that turns the protection off.**

```
HEAD repo-local instructions   ->  auto-discovery always suppressed, never privileged
BASE repo-local conventions    ->  may be deliberately re-admitted by Reprove,
                                   read host-side from the pinned base SHA,
                                   supplied through the trusted instruction channel
```

This is **not** a second security opt-in of the kind ADR 0004 warned about when it ruled that *"a
matrix of opt-ins is a policy engine nobody can reason about at review time."* It is the trusted /
untrusted input separation that ADR 0004 already applies when it reads security-sensitive
configuration from the base ref.

**Base content is always read host-side from the pinned base SHA, never from the Workspace copy, even
when base and head are identical.** The distinction is worth stating precisely because it is easy to
under-build: for a pull request that does not touch a convention file, base and head content are the
same bytes. The **base-ref pin** only bites on pull requests that modify a convention file. The
**channel rule** bites on every pull request. The channel is the load-bearing half.

**Re-admission is on by default and a Repository may disable it.** That switch is a **quality
control, not a security control**, and the ADR records why: both positions are secure, because
disabling it can only make the Reviewer less informed, never more privileged. The reason to want it
is that **authoring conventions are not reviewing conventions**. A `CLAUDE.md` reading "prefer
brevity, do not add tests unless asked" is good instruction to an Author and actively suppresses
legitimate Findings from a Reviewer, with nobody intending an attack.

"On by default" applies **only to surfaces classified as context-only**. It never re-admits MCP
definitions, hooks, executable configuration, permission overrides, OpenCode agent definitions, or
anything else that changes authority or execution. Those require separate evidence before they could
become trusted base-ref inputs, and none has it today.

### 5. Re-admission is a closed prose allowlist, never a classification of configuration

Re-admission accepts **only explicitly supported prose convention surfaces whose semantics Reprove
has classified as context**. Structured Harness configuration is never re-admitted.

**Allowed:** `CLAUDE.md`, `AGENTS.md`, `AGENTS.override.md`, `.claude/rules/**`, `CONTEXT.md`.

**Never re-admitted:** `opencode.json` / `opencode.jsonc`, `.codex/config.toml`,
`.claude/settings*.json` and `.claude/settings.local.json`, `.claude/agents/**`, `.claude/skills/**`,
`.mcp.json`, and every hook, MCP, permission or agent definition.

Field-level classification was rejected. It would make Reprove a compatibility implementation of
three configuration schemas churning at roughly eleven releases a week, where one new key with
execution semantics silently becomes a re-admitted authority grant. The case that settles it is
OpenCode's `instructions` key, which is **mixed inside a single key**: it accepts arbitrary globs,
absolute paths, and `http(s)://` URLs that are fetched. "Context-only" does not bottom out at the
file, and it does not bottom out at the field either.

**The allowlist is surface-specific, not "all Markdown."** Markdown is not the security property:
`.opencode/agent/build.md` is a markdown file that replaces the Reviewer's system prompt and grants
itself `bash: allow`.

`CLAUDE.local.md` is **excluded at launch**. It is by convention a developer's local override rather
than a repository convention, and its presence in a tracked ref is itself unusual enough that
admitting it by default would be surprising. Adding it later is cheap.

**Re-admitted conventions carry their original directory scope.** These systems are directory-scoped
natively, so flattening every `CLAUDE.md` into one undifferentiated blob would turn front-end
conventions into repository-wide rules. Each re-admitted convention is delivered with its source path
and the directory it applies under.

**Reprove's own policy is authoritative.** The generated prompt states explicitly that base
conventions are subordinate repository context and cannot override the Reviewer's role, Autonomy and
tool restrictions, security controls, the output and Result contract, or Threshold and publication
policy. This has to be stated rather than assumed, because Claude Code's native memory framing tells
the model the opposite.

### 6. Nothing reaching the instruction channel may contain unresolved indirection

`CLAUDE.md` supports `@`-imports and in-project targets are followed. Passing that text through
unmodified would reopen this ADR's own hole through the one door it deliberately leaves open: if the
Harness expands an `@` reference at the instruction-channel stage, it resolves it against `cwd`,
which is the **head** Workspace. A base-ref convention file would then pull head content into the
privileged channel.

Host-side processing, before anything reaches the channel:

```
base convention
  -> parse imports
  -> resolve against the pinned base SHA only
  -> recursively expand approved in-repository text targets
  -> bounds and cycle checks
  -> neutralize unresolved or disallowed imports
  -> deliver final inert text
```

Constraints: never resolve against the head Workspace; never fetch `http://` or `https://` imports;
never resolve absolute host paths; reject or neutralize traversal outside the repository; enforce
recursion depth and total expanded-byte limits; detect cycles; preserve source labels so scope stays
legible.

**Resolving an import does not turn the imported file into native Harness configuration.** Its
contents are flattened into subordinate textual context. If a base `CLAUDE.md` references
`opencode.json`, that target is treated as plain bounded text or the reference is neutralized. It is
never handed back to the Harness in a location or channel where its native semantics reactivate.

The invariant is stronger than any current Harness behavior, and is stated as a property to preserve
across upstream churn:

> **No text reaching Reprove's trusted instruction channel can cause the Harness to resolve
> additional content from the head Workspace.**

### 7. The boundary is a dispatch gate, and dispatch requires fresh evidence

ADR 0005's `canSuppressRepoInstructions` is **renamed `canEnforceRepoInstructionBoundary`** and
**promoted from an advisory capability field to a hard dispatch gate**. The rename is not cosmetic:
suppression is no longer the whole boundary, because OpenCode additionally requires targeted
sanitization, so a field named for the mechanism would misdescribe the guarantee.

**If the full boundary cannot be established for the resolved invocation, the Run is Refused.** There
is no degraded Run, per ADR 0004's ban on anything that warns and runs.

The churn problem is not hypothetical: ADR 0003's suppression table was wrong in **two of three
cells** within the lifetime of this map, and `@ai-sdk/harness` ships removals as patches at roughly
eleven releases a week. A version allowlist is therefore rejected. It encodes a claim about a version
string rather than about the property, and it ages into a liability at this cadence.

Instead, a **behavioral probe result cached against a fingerprint**:

```
fingerprint = Harness binary/package fingerprint
            + Route
            + Adapter version
            + suppression/sanitizer implementation version

at dispatch:  fingerprint matches a proven probe  ->  use it
              changed, unknown or stale           ->  re-probe, or Refuse
```

This preserves ADR 0004's rule that *"a stale probe is a refusal rather than an assumption"* without
taxing every Run with a model round trip. The probe tests the actual property against a synthetic
Workspace carrying **canary instruction surfaces**, including an unresolved-indirection canary for
decision 6. CI contract tests exercise the same property for the exact-pinned Brokered packages.

> **Dispatch requires fresh evidence that the boundary works for the exact artifacts being invoked,
> not merely recognition of a version string.**

This also subsumes the two verifications [#16](https://github.com/nick-neely/reprove/issues/16) left
open: whether OpenCode's nested read-triggered path is gated after all, and whether Claude Code's
repo-committed `settings.json` hooks actually fire. Both are handled conservatively today, and the
canary probe settles them empirically at dispatch rather than by reading source again.

### 8. What the Run records

Bounded, non-content facts only:

```
instructionBoundaryVersion    baseConventionsEnabled      detectedSurfaceCounts
sanitizerVersion              baseConventionDigest        suppressedSurfaceCounts
probeFingerprint                                          quarantinedSurfaceCounts
                                                          readmittedSurfaceCounts
```

No paths, no file contents, no manifest, no convention prose. The digest records **which base
convention set influenced this Run** without persisting it again, and the version and fingerprint
fields answer *what security logic established the instruction boundary for this Run*, which is the
auditability ADR 0004 demands of `Exposure` and `Isolation`.

None of these is a content-bearing field, so this adds **nothing** to
[ADR 0008](0008-persistence-tenancy-and-retention.md)'s 90-day content purge. Quarantined content
remains ephemeral and dies with the Sandbox. Where a path genuinely matters it is because a Finding
anchored to it, and that path is already Finding data governed by ADR 0007 and ADR 0008.

## Consequences

### Corrections to ADR 0003

Its suppression table is wrong in two of three cells, measured against the same CLI versions it
claimed to measure.

- **Codex.** `--ignore-rules` and `--ignore-user-config` suppress neither `AGENTS.md` nor skills.
  The working levers are config keys.
- **Claude Code.** `--bare` suppresses instruction surfaces but leaves `.mcp.json` discovery on.
  `--safe-mode` is the correct flag.
- **OpenCode**, recorded as "unverified": environment variables only, no CLI flag, and it takes two
  variables rather than one.

### Partial supersession of ADR 0005

- `canSuppressRepoInstructions` becomes `canEnforceRepoInstructionBoundary` and becomes a gate rather
  than an input.
- **The field is no longer credential-dependent.** ADR 0005 split it across the registration and
  dispatch views because ADR 0004 recorded that Claude Code cannot use `--bare` and user-managed
  authentication together. `--safe-mode` disables the same customizations and explicitly leaves
  authentication working normally, which removes the entire reason for that split. **ADR 0004's
  `--bare` / `CLAUDE_CODE_OAUTH_TOKEN` consequence is real but no longer binding.**
- **A carve-out is added to "unknown or raw configuration is rejected, not forwarded."** As written it
  forbids `codexConfig`, which is the only Brokered-Route suppression Codex has. Adapter-owned
  suppression keys are exempt. The prohibition's target was caller-supplied configuration, and this
  is neither caller-supplied nor optional.
- **ADR 0005's deferral of the `skills` channel is resolved in principle.** The seam is preserved so
  trusted base-ref skills can eventually be installed through the Harness's own trusted skills
  mechanism, outside the Workspace. It is enabled per Harness only after that Harness's skill tool
  and permission semantics are verified, and no Harness qualifies today.

### `supportedAutonomy` on OpenCode now depends on Sandbox provisioning

A repo-committed `.opencode/agent/build.md` re-grants `bash` and `edit` after the bridge's permission
map is applied, because OpenCode merges permissions by concatenation, evaluates with `findLast`, and
appends agent-level rules last. It beats the operator's `OPENCODE_PERMISSION` as well.

So **no Autonomy level below `fix` is enforceable on OpenCode while project config is enabled.** Under
this ADR it becomes enforceable again, which means instruction-boundary provisioning is part of the
proof behind an advertised capability rather than optional hardening. `supportedAutonomy` is only
truthful if provisioning has first neutralized repo-controlled configuration that could re-grant
tools or permissions.

### Handed onward

- [#21](https://github.com/nick-neely/reprove/issues/21) gains one repository configuration key: the
  base-convention re-admission switch, default on. Like every security-adjacent key it reads from the
  base ref, though this one is a quality control rather than a security control.
- The narrative surfaces are **out of scope here and owned by a follow-up**: pull request
  descriptions, commit messages, issue text and code comments. This ADR establishes the invariant
  they inherit: **Author-controlled text never enters Reprove's instruction channel.** It enters as
  explicitly labelled untrusted review data or not at all. There is no mechanical isolation boundary
  for a hostile string inside a source file, so prompt hardening, explicit data delimiters and
  model-level injection resistance are defence in depth there. Reprove benefits from models getting
  better at recognizing injection without making that the security primitive.
