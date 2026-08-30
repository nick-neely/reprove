/**
 * Normative schema for `.reprove.yml`, the repository configuration contract.
 *
 * Decided by ADR 0011 (docs/adr/0011-repository-configuration-contract.md).
 * This is a specification artifact, not shipped code: no package exists yet.
 * When `@reprove/protocol` is created per ADR 0010, this is what it copies.
 *
 * Verified against zod 4.5.4 under `tsc --strict`: it compiles, unknown keys are
 * rejected at every level (including `review.mode` and `security.allowedRoutes`,
 * the two names this map deliberately banned), an empty file resolves through
 * every inner default, and `overrides` refuses non-path-local keys.
 *
 * Three rules the shape encodes, which prose alone would not hold:
 *
 *   1. `.strict()` everywhere - unknown keys are rejected, never ignored and
 *      never forwarded (ADR 0005, generalized to the whole file by ADR 0011 §1).
 *   2. Section membership *is* the resolution rule. `review` resolves
 *      Repository-over-Owner; `security` resolves by narrowing, with the Owner
 *      layer read as a ceiling and never as a default (ADR 0011 §3).
 *   3. Every field declares a retention class (ADR 0011 §9). There is no
 *      generic arbitrary-string field: adding one would silently reclassify
 *      the snapshot.
 */

import { z } from 'zod' // zod 4

// ---------------------------------------------------------------------------
// Retention classification
//
// `resolvedConfig` is stored on the Run and purged by field class at 90 days
// under ADR 0008's existing `contentPurgedAt` marker. A field is `content`
// only when it can carry repository-authored free text; today that is the
// four Project commands and nothing else.
// ---------------------------------------------------------------------------

export type RetentionClass = 'policy' | 'content'

/** Dotted paths within `resolvedConfig` purged at 90 days. */
export const CONTENT_BEARING_PATHS = [
  'review.commands.install',
  'review.commands.build',
  'review.commands.test',
  'review.commands.typecheck',
] as const

// ---------------------------------------------------------------------------
// Ladders. Order is the narrowing order: index 0 is narrowest.
// A key may only appear in `security` if its type has a defined narrowing
// operation (ADR 0011 section 3), which is why these are ordered tuples
// rather than bare unions.
// ---------------------------------------------------------------------------

export const EXPOSURE_LADDER = ['none', 'scoped', 'account'] as const
export const AUTONOMY_LADDER = ['inspect', 'verify', 'fix'] as const
export const SEVERITY_LADDER = ['low', 'medium', 'high', 'critical'] as const

export const exposure = z.enum(EXPOSURE_LADDER)
export const autonomy = z.enum(AUTONOMY_LADDER)
export const severity = z.enum(SEVERITY_LADDER)

/** Ladder minimum: the narrower of two positions on an ordered ladder. */
export const meetLadder = <T extends readonly string[]>(
  ladder: T,
  a: T[number],
  b: T[number],
): T[number] => (ladder.indexOf(a) <= ladder.indexOf(b) ? a : b)

// ---------------------------------------------------------------------------
// Bounds. The file is parsed host-side on the Worker, outside the Sandbox
// (ADR 0009), so every bound here is a host-side denial-of-service control as
// much as a usability one.
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Maximum size of `.reprove.yml` on disk. */
  fileBytes: 64 * 1024,
  /** Maximum YAML nesting depth. */
  depth: 16,
  maxIgnoreGlobs: 256,
  maxOverrides: 64,
  maxOverridePaths: 64,
  maxEgressHosts: 64,
  globChars: 512,
  commandChars: 2048,
  /** Maximum size of the serialized `resolvedConfig` snapshot. */
  snapshotBytes: 128 * 1024,
} as const

/**
 * YAML parser settings. Not expressible in zod, and load-bearing: an alias is
 * in-document indirection expanded host-side, and an expansion bomb is a
 * host-side denial of service (ADR 0011 section 1).
 */
export const YAML_PARSE = {
  version: '1.2',
  schema: 'core',
  customTags: false,
  merge: false,
  maxAliasCount: 0,
} as const

const glob = z.string().min(1).max(LIMITS.globChars)

/** A shell command. The only content-bearing class in the file. */
const command = z.string().min(1).max(LIMITS.commandChars)

// ---------------------------------------------------------------------------
// Path-local policy: the only keys an `overrides` entry may carry.
//
// Threshold and `ignore` compose because both are evaluated per Finding path
// at publication. Harness, Model, Autonomy, budget, placement and Project
// commands are pinned once per Run, so admitting them here would create
// undefined composition for a pull request spanning two packages
// (ADR 0011 section 6).
// ---------------------------------------------------------------------------

export const threshold = z
  .object({
    /** Minimum Severity that reaches GitHub. ADR 0002 default. */
    severity: severity.default('medium'),
    /**
     * Verification bar for publication. `verified`-only would gut the output,
     * so it defaults off (ADR 0002).
     */
    verification: z.enum(['any', 'verified']).default('any'),
  })
  .strict()

export const pathLocalPolicy = z
  .object({
    threshold: threshold.partial().optional(),
    ignore: z.array(glob).max(LIMITS.maxIgnoreGlobs).optional(),
  })
  .strict()

export const override = pathLocalPolicy
  .extend({
    paths: z.array(glob).min(1).max(LIMITS.maxOverridePaths),
  })
  .strict()

// ---------------------------------------------------------------------------
// `review` - ordinary quality and product policy.
// Resolution: Repository value, else Owner value, else Reprove default.
// Shallow per-key. No deep merge: a deep merge makes effective configuration
// unpredictable from reading either layer.
// ---------------------------------------------------------------------------

export const projectCommands = z
  .object({
    install: command.optional(),
    build: command.optional(),
    test: command.optional(),
    typecheck: command.optional(),
  })
  .strict()

/**
 * ADR 0005's small typed per-Harness advanced options. Ships empty and
 * `.strict()`, so every key is rejected until one is added deliberately.
 * Reserving the shape without inventing keys is the point.
 */
export const harnessOptions = z
  .object({
    codex: z.object({}).strict().optional(),
    claudeCode: z.object({}).strict().optional(),
    openCode: z.object({}).strict().optional(),
  })
  .strict()

export const reviewSection = z
  .object({
    enabled: z.boolean().default(true),

    /** Requested placement. Resolves onto the Run's `spec.placement`. */
    worker: z.enum(['self-hosted', 'hosted']).optional(),

    harness: z.enum(['codex', 'claude-code', 'opencode']).optional(),

    /**
     * An opaque catalogue id. The control plane owns the Model catalogue and
     * pins the exact Model on the Run; a Worker never enumerates models
     * (ADR 0005).
     */
    model: z.string().min(1).max(128).optional(),

    /** Only `standard` exists; composition is out of this map's scope. */
    strategy: z.enum(['standard']).default('standard'),

    /**
     * Requested Autonomy. A level the resolved (Harness, Route) cannot enforce
     * is a Refusal at dispatch, never a downgrade and never a parse error
     * (ADR 0011 section 5).
     */
    autonomy: autonomy.optional(),

    /** Run budget. The Adapter enforces the Pass sub-budget (ADR 0005). */
    budget: z.number().positive().finite().optional(),

    /** How long the Run stays claimable before terminal `unscheduled`. */
    deadline: z.string().regex(/^\d+[smh]$/).optional(),

    /** `REQUEST_CHANGES` is opt-in (ADR 0002). */
    event: z.enum(['COMMENT', 'REQUEST_CHANGES']).default('COMMENT'),

    threshold: threshold.default({ severity: 'medium', verification: 'any' }),

    /**
     * Publication-time only. Matching Findings are retained internally and not
     * projected onto GitHub. Does not touch the Workspace, the Reviewer's
     * reading, or verification (ADR 0011 section 7).
     */
    ignore: z.array(glob).max(LIMITS.maxIgnoreGlobs).default([]),

    /**
     * Resolved from the base ref. Hygiene, not a control: under `verify` the
     * Reviewer holds a shell and can run anything the head contains (ADR 0004).
     * A fixed set of four, never an open map.
     */
    commands: projectCommands.optional(),

    /**
     * ADR 0009's base-convention re-admission switch. A quality control rather
     * than a security control - both positions are secure, because disabling it
     * can only make the Reviewer less informed, never more privileged - so it
     * lives here rather than in `security`, but like every base-ref key a pull
     * request cannot flip it for its own Run.
     */
    baseConventions: z.boolean().default(true),

    harnessOptions: harnessOptions.default({}),

    /** Last match wins, after CODEOWNERS and .gitignore idiom. */
    overrides: z.array(override).max(LIMITS.maxOverrides).default([]),
  })
  .strict()

// ---------------------------------------------------------------------------
// `security` - authority and permission.
//
// Resolution: meet(Reprove boundary, Owner ceiling, Repository request ?? safe
// default). The Owner layer is a ceiling and never a default: an Owner value
// means "repositories are permitted to request this", not "enable this
// everywhere". Owner absence means no additional restriction, not deny-all -
// the Repository-level safe default still applies.
//
// Every key below has a defined narrowing operation. A key without one does not
// belong in this section (ADR 0011 section 3).
// ---------------------------------------------------------------------------

export const securitySection = z
  .object({
    /**
     * Ladder minimum. The durable way to say "never let a password-equivalent
     * account credential run here". Route is deliberately absent: it is an
     * Adapter implementation detail, not a gate (ADR 0011 section 4).
     */
    maxExposure: exposure.default('account'),

    /** ADR 0004's single Provenance opt-in. Boolean AND. */
    allowExternalProvenance: z.boolean().default(false),

    /** Dependency lifecycle scripts during install. Boolean AND. */
    installScripts: z.enum(['deny', 'allow']).default('deny'),

    /**
     * ADR 0006's hosted-fallback opt-in. Falling back changes execution
     * location, credential model, Isolation and Exposure at once, so it is a
     * change of security posture rather than a scheduling convenience.
     * Boolean AND.
     */
    allowHostedFallback: z.boolean().default(false),

    /**
     * Additional approved egress destinations, beyond Reprove's proxy policy.
     * Set intersection where an Owner ceiling exists. There is no `allow-all`.
     */
    egress: z
      .array(z.string().min(1).max(253))
      .max(LIMITS.maxEgressHosts)
      .default([]),
  })
  .strict()

// ---------------------------------------------------------------------------
// The file, and the Owner ceiling
// ---------------------------------------------------------------------------

/** `.reprove.yml`, read whole from the base ref. Never from the head. */
export const repositoryConfig = z
  .object({
    // `prefault`, not `default`: an absent section is parsed as `{}` *through*
    // the schema so every inner default applies, which is the same path a
    // missing file takes. zod 4's `default` takes the output type and would
    // require restating every default here.
    review: reviewSection.prefault({}),
    security: securitySection.prefault({}),
  })
  .strict()

/**
 * The Owner layer. `review` supplies defaults a Repository may override;
 * `security` supplies ceilings a Repository may not exceed. Stored in one
 * Owner-scoped, RLS-covered table (ADR 0008 left `repository` with no
 * configuration columns precisely so this stayed open).
 */
export const ownerConfig = z
  .object({
    review: reviewSection.partial().optional(),
    security: securitySection.partial().optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// The resolved snapshot
// ---------------------------------------------------------------------------

/**
 * What the Run actually ran under, after the Owner ceiling and monotonic
 * narrowing are applied. Stored on `spec`; `configDigest` is
 * `hash(canonical(resolvedConfig))`, which replaces ADR 0007's digest of the
 * raw repository file - that stopped describing anything once a second layer
 * existed.
 *
 * Wire shape is plain JSON per ADR 0010: no branded types, no zod transform
 * whose meaning exists only in TypeScript.
 */
export const resolvedConfig = z
  .object({
    schemaVersion: z.number().int().positive(),
    review: reviewSection,
    security: securitySection,
  })
  .strict()

export type RepositoryConfig = z.infer<typeof repositoryConfig>
export type OwnerConfig = z.infer<typeof ownerConfig>
export type ResolvedConfig = z.infer<typeof resolvedConfig>

// ---------------------------------------------------------------------------
// Refusal reasons this contract introduces
//
// Control-plane origin. ADR 0011 section 5 generalizes `Refusal` to any
// pre-dispatch decision not to execute; ADR 0006's protocol message is one
// origin of the noun, not its definition. Each names the requirement that
// failed. None falls back to defaults: ADR 0004 bans anything that warns and
// runs, and reviewing under configuration the repository did not author is
// exactly that.
// ---------------------------------------------------------------------------

export const CONFIG_REFUSAL_REASONS = [
  /** Not parseable, schema-invalid, or carrying an unknown key. */
  'config_invalid',
  /** Over a byte, depth, or item bound in LIMITS. */
  'config_too_large',
  /** `.reprove.yaml` present where no `.reprove.yml` exists. */
  'config_misnamed',
] as const

/**
 * A request the Owner ceiling forbids is NOT a Refusal. `meet` applies and the
 * effective value is the narrower one, because narrowing moves toward the safe
 * position - the opposite direction from the silent downgrade ADR 0004 bans.
 * It stays legible rather than silent: the narrowed value is what
 * `resolvedConfig` records, and the config Check reports the cap when it runs.
 */
