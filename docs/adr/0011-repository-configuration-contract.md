# Repository configuration is inert data read from the base ref, in two sections with two resolution rules

Reprove needs a user-facing configuration contract, and the keys were largely fixed by
earlier tickets. What was open was the format, the authoritative ref, the precedence
between an Owner and a Repository, and what happens when configuration is invalid or
asks for something that cannot be enforced. This ADR settles those, and in doing so
amends [ADR 0007](0007-run-result-and-finding.md)'s `configDigest`, generalizes
[ADR 0006](0006-worker-protocol.md)'s `Refusal`, and extends
[ADR 0008](0008-persistence-tenancy-and-retention.md)'s purge and publication disposition.

## 1. The file is inert data, and it cannot be executable

`.reprove.yml` at the repository root. YAML 1.2 core schema, parsed with **no custom
tags, no merge keys and no anchors or aliases**, under a byte cap and a nesting-depth
cap. One zod schema, strict: **unknown keys are rejected, never ignored and never
forwarded**, extending [ADR 0005](0005-adapter-boundary.md)'s rule from per-Harness
options to the whole file.

Types come from publishing the schema, not from executing it: zod emits a JSON Schema
that editors consume through a `# yaml-language-server: $schema=` comment. That is the
whole benefit a `reprove.config.ts` would have bought.

**Executable configuration is refused on the strength of where configuration is read.**
[ADR 0009](0009-repo-controlled-instruction-boundary.md) reads base content **host-side
on the Worker, from the pinned base SHA** - outside the Sandbox, outside every boundary
this map has built, and on the Native Route next to a credential of `account` Exposure.
A TypeScript config would execute repository-authored code *there*. ADR 0004 already
strips repository Git hooks during Workspace materialization specifically to deny
"repo-controlled behavior"; an executable config file is a Git hook with better
ergonomics and a worse blast radius. YAML anchors are excluded for the smaller version
of the same reason: an alias is in-document indirection expanded host-side, and an
expansion bomb is a host-side denial of service.

**`.reprove.yaml` is not a second spelling.** Finding it where no `.reprove.yml` exists
is a `Refusal` naming the rename, because silently falling through to defaults would be a
silent downgrade of whatever the repository actually asked for.

## 2. The whole file is read from the base ref, and there is no split rule

One invariant, stated in the documentation in these words:

> **A pull request cannot change the configuration used to review itself.**

The alternative - security keys from base, ordinary keys from head - requires classifying
every key, forever. That is exactly the field-level classification ADR 0009 rejected for
third-party Harness configuration, and its reason transfers without modification: one new
key whose security relevance is not noticed silently becomes a grant a pull request makes
to itself. ADR 0009's own case, OpenCode's `instructions` key, proves the classification
does not even bottom out at the field.

The cost is accepted deliberately: **a pull request that changes `.reprove.yml` is
reviewed under the old configuration**, and so is the pull request that first adopts
Reprove. That friction is paid once per configuration change and buys an invariant a user
can hold in their head.

**Head configuration is parsed as prospective data and never applied** (§8).

## 3. Two sections, two resolution rules, and the distinction is structural

`.reprove.yml` has two top-level sections whose resolution rule follows the section
rather than a list maintained in merge code:

```
Reprove defaults  ->  Owner layer  ->  Repository file

review:     ordinary quality and product policy
            effective = Repository value, else Owner value, else Reprove default
            shallow per-key; no deep merge

security:   authority and permission
            effective = meet(Reprove boundary, Owner ceiling, Repository request ?? safe default)
```

Two rules are worth their cost because an organization-wide revocation is a real
requirement. Hiding which rule applies to which key is not.

**The Owner layer in `security:` is a ceiling, never a default.** An Owner value means
*repositories are permitted to request this*, not *enable this everywhere*:

```
Owner permits + Repository absent           -> disabled
Owner permits + Repository explicitly asks  -> enabled
Owner forbids + Repository explicitly asks  -> disabled
Owner absent                                -> no additional restriction; the safe default still applies
```

An Owner therefore has exactly one job and one field per key, and no repository ever
inherits an execution grant it did not request - which is the silent posture change
ADR 0004 bans, arriving by inheritance instead of by fallback.

**A request the Owner ceiling forbids is not a Refusal.** The meet applies and
the effective value is the narrower one. Narrowing moves toward the safe position, which
is the opposite direction from the silent downgrade ADR 0004 bans - and refusing here
would let one Owner ceiling change break every repository that had opted in. It stays
legible rather than silent: the narrowed value is what `resolvedConfig` records, and the
config Check reports the cap when it runs.

**A key may only live in `security:` if its type has a defined narrowing operation**:
boolean `AND`, ladder minimum, numeric minimum, set intersection. This is what keeps
"narrowest permitted value" from being prose. Threshold can never move into `security:`
even if someone wants the ceiling, because "narrower" has no security meaning for a
publication filter - a higher threshold publishes less and hides more.

## 4. Configuration constrains domain and security properties, never Adapter internals

**Route never appears in configuration.** `CONTEXT.md` holds that a Route is *"an
implementation detail of an Adapter, not something its callers choose between"*; ADR 0004
removed Route from the dispatch gate in favour of `Exposure x Isolation x Provenance`,
and ADR 0007 demoted it to an audit fact that nothing gates on. A permitted-Routes key
would restore Route as a gate through the configuration schema, outliving the ADR that
removed it. Issue [#15](https://github.com/nick-neely/reprove/issues/15)'s line about
configuration gaining "a Route and Provenance surface" predates ADR 0004 and is
superseded here.

An Owner that wants *never let a password-equivalent account credential run here* writes
the durable form:

```yaml
security:
  maxExposure: scoped
```

This stays correct when a fourth Route appears, and it makes a placement ceiling
unnecessary: hosted execution is brokered and self-hosted native execution is what
reaches `account`, so capping Exposure already constrains placement without naming it.
The general rule is the section title: configuration constrains the properties Reprove
gates on, never how an Adapter achieves them.

## 5. Invalid configuration is a `Refusal`, and `Refusal` is generalized to say so

`CONTEXT.md`'s definition already fits - *a decision not to dispatch, made before
execution begins, because a requirement was not met* - so this **broadens the noun rather
than inventing a fourth pre-dispatch outcome**. ADR 0006's protocol message becomes one
*origin* of a Refusal, not its definition:

```
control-plane Refusal   invalid or unresolvable configuration; Owner policy conflict;
                        other pre-Run eligibility failure
Worker Refusal          capability, Isolation or Exposure failure, transported
                        through the Worker protocol
```

`Refusal: config_invalid` produces a visible failing Check naming the key that failed and
no Run at all. **If configuration cannot be resolved well enough to construct a valid
Run, no Run needs to exist to carry the Refusal.** There is no fallback to defaults:
ADR 0004's *"nothing warns and runs"* is the governing rule, and a review conducted under
a configuration the repository did not author is exactly a silent downgrade.

**Asking for what a Harness cannot enforce is a Refusal at dispatch, not a parse error.**
A repository setting `autonomy: inspect` with `harness: codex` has written a
schema-valid file; whether the resolved artifacts can enforce it is answered by ADR 0009's
behavioral probe against an artifact fingerprint, which exists only at dispatch. ADR 0009
retired version allowlists precisely because a control-plane table of Harness capabilities
was wrong within this map's own lifetime, and a parse-time check would rebuild one.

## 6. `overrides` is a restricted schema, not a recursive partial

No per-directory `.reprove.yml` and no ancestor walk - that mechanic is what ADR 0009
spent an entire decision closing, and rebuilding it for Reprove's own file would reopen
it at a new path. Path-specific policy lives in an `overrides` list inside the single
root file, matched **last-match-wins** after `CODEOWNERS` and `.gitignore` idiom.

`overrides` entries admit **only path-local keys** - Threshold and `ignore` - under their
own zod schema rather than `Partial<Config>`. A Run has one pinned Harness, Model,
Autonomy, budget, placement and one set of Project commands; a pull request touching both
`packages/web/**` and `packages/api/**` would give any of those undefined composition
semantics. Threshold and `ignore` compose cleanly because both are evaluated per Finding
path at publication.

## 7. `ignore` suppresses publication and nothing else

`ignore` means exactly: **Findings anchored to matching paths are retained internally and
not projected onto GitHub.** It does not remove files from the Workspace, does not
prevent the Reviewer reading them, and does not change verification. Removing paths from
the Workspace would break the build and break `verify`; restricting the Reviewer's
attention is unenforceable, because under `verify` it holds a shell and legitimately needs
to read a vendored file to follow a call.

This is Threshold's shape, and it inherits Threshold's property: applied when a Review is
published rather than when a Finding is made, so changing it never requires a new Run.
ADR 0008's publication disposition gains a value:

```
inline_comment | review_body | suppressed_threshold | suppressed_dedupe | suppressed_ignore
```

Where both would suppress, **`suppressed_ignore` wins** as the more specific explanation.

Cost is the Run budget's job. There is no advisory attention hint: two keys that look
alike and bind at different times are worse than one honest one, and if *spend less
attention on generated files* is later a real requirement it gets its own name and its
own semantics.

## 8. Prospective head validation is an independent Check

A pull request that changes Reprove configuration gets its own Check, separate from the
review Check:

```
Reprove          execution outcome for the actual Run, under base configuration
Reprove config   prospective validity of the head configuration
```

Mixing them would let a broken head file report failure for a Run that succeeded exactly
as designed, violating ADR 0007's *the Check reports execution, not verdict* from the
opposite direction. The config Check must be able to fail, or the feedback is decorative.

It **runs whenever the pull request proposes a configuration change** - including a
config-like mistake such as adding `.reprove.yaml` - and it runs even when review
execution does not: when `enabled` is false, when no Worker is online, and when the Run
is Refused for an unrelated reason. It requires no Worker, Sandbox, Harness or Provider
credential, so gating it on review execution would be artificial. `enabled: false` means
*do not execute reviews*, not *malformed configuration should become invisible*.

It is **not** posted on pull requests that do not touch configuration, which is what
keeps it from being noise on repositories with review disabled.

## 9. `configDigest` covers the resolved snapshot, which is retained by field class

Once more than one layer exists, hashing the repository file stops describing what a Run
ran under. **This amends ADR 0007**: the Run's `spec` carries

```
resolvedConfig    normalized, bounded, schema-versioned; no secrets; after Owner ceiling
                  and monotonic narrowing are applied; includes the resolved overrides
                  that governed publication
configDigest      hash(canonical(resolvedConfig))
```

so that six months later *what policy governed this Run* is answered by `resolvedConfig`
and *is that exact effective configuration unchanged* by `configDigest`. ADR 0007's
stated purpose - that editing the configuration file cannot rewrite what a past Run ran
under - is preserved and strengthened, since an Owner ceiling change is now visible too.

**The snapshot does not escape ADR 0008's retention boundary.** Project commands are
arbitrary repository-authored strings and can carry credentials, URLs, paths or literal
data, so `resolvedConfig` is retained **by field class**, marked on the Run with
ADR 0008's existing `contentPurgedAt` marker rather than a config-specific one:

```
preserved indefinitely   enums, booleans, numeric budgets, Thresholds, Harness, Model,
                         Autonomy, Exposure ceilings, security grants and ceilings,
                         publication policy, paths and globs
purged at 90 days        commands.*, and any field later classified as content-bearing
```

Paths and globs are preserved because ADR 0008 already preserves a Finding's `path` and
`line` indefinitely. **Every field declares its retention class when it is introduced,
and there is no generic arbitrary-string escape hatch** - a schema that admitted one
would silently reclassify itself. Reprove therefore may not reproduce a shell command
string after 90 days, which is the correct trade: config archaeology does not get to
weaken a content-retention boundary the tenancy ADR argued for.

## 10. The schema

Section membership is the resolution rule, so the shape is the decision:

```yaml
# yaml-language-server: $schema=https://reprove.dev/schema/reprove.json
review:
  enabled: true
  worker: self-hosted        # resolves onto spec.placement
  harness: codex
  model: <catalogue id>
  strategy: standard
  autonomy: verify
  budget: <number>
  deadline: <duration>
  event: COMMENT             # REQUEST_CHANGES is opt-in
  threshold:
    severity: medium
    verification: any
  ignore:
    - generated/**
  commands:                  # Project commands; base ref; hygiene, not a control
    install: pnpm install
    build: pnpm build
    test: pnpm test
    typecheck: pnpm typecheck
  baseConventions: true      # ADR 0009's re-admission switch; quality control, default on
  harnessOptions: {}         # ADR 0005's typed advanced options; empty at launch
  overrides:
    - paths: [packages/web/**]
      threshold: { severity: high }
      ignore: [packages/web/generated/**]

security:
  maxExposure: account            # ladder minimum
  allowExternalProvenance: false  # ADR 0004's single opt-in
  installScripts: deny            # boolean AND
  allowHostedFallback: false      # ADR 0006; boolean AND
  egress: []                      # set intersection when an Owner ceiling exists
```

`commands` is a **fixed set of four**, not an open map, because an open map is the
arbitrary-string escape hatch §9 forbids. It is renamed from PRD §31's `validation:`
because `CONTEXT.md` holds that *`validate` means schema validation and nothing else*;
the glossary term is Project commands. ADR 0004's finding stands unchanged: they resolve
from the base ref and are hygiene rather than a control, since under `verify` the
Reviewer holds a shell.

`harnessOptions` **ships empty**. ADR 0005 admitted a small typed set *added deliberately
as real use cases appear*, and reserving the shape without inventing keys is the honest
foundation move.

The file carries **no version key**: strict rejection of unknown keys plus additive-only
evolution keeps old files valid, and `resolvedConfig` carries the `schemaVersion` that
matters for audit. A breaking change would introduce one deliberately.

## Consequences

- ADR 0007's `configDigest` changes meaning (§9); the Run gains `resolvedConfig` and
  `contentPurgedAt`.
- ADR 0006's `Refusal` is generalized to a pre-dispatch decision with two origins (§5);
  `CONTEXT.md` is amended to match.
- ADR 0008 gains a publication disposition value and a Run-level purge class (§7, §9),
  and the Owner ceiling needs one Owner-scoped, RLS-covered table - which ADR 0008
  anticipated by leaving `repository` with no configuration columns.
- PRD §7, §30 and §31 lose their `[Undecided]` markers.
- Anything that later wants to gate on how an Adapter works must find the domain property
  it is really reaching for, or argue with §4.
