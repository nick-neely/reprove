<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/worker-core

## dist/adapter.d.ts

```ts
/**
 * The Adapter as Worker core drives it: one Pass invocation, a resolved
 * capability, and the unnamed per-Pass bundle that comes back.
 *
 * The port lives here rather than in `@reprove/adapters` on purpose. ADR 0005
 * fixes what an Adapter *exposes*; what an Adapter is *given* is decided by the
 * only thing that authorizes a Pass, and that is Worker core. Stating it here
 * also keeps `@reprove/adapters` free of `@reprove/protocol`, which ADR 0010
 * requires: an Adapter yields this bundle and Worker core composes the wire
 * Result, so an Adapter that knew the wire format would be reaching a layer
 * above itself.
 *
 * Three properties of the shape are load-bearing.
 *
 * **The interface is a single Pass invocation, not a session.** Session
 * creation, `detach`/`resume` and reattachment across step boundaries stay
 * inside the Adapter, because publishing a lifecycle only two of three
 * Harnesses honour is the false uniformity PRD §19 warns against.
 *
 * **The repair turn is the Adapter's mechanism and Worker core's decision.**
 * ADR 0005 puts one bounded repair turn inside the same Pass and the same
 * Sandbox, and also gives Reprove ownership of Result conformance. Only Worker
 * core can decide conformance - schema validation and the Evidence cross-check
 * are its - so the Pass request carries `check`, and what an Adapter may do
 * about a complaint is run its one repair turn and ask again.
 *
 * The word is **conformance** rather than acceptance throughout. `CONTEXT.md`
 * reserves Acceptance for the control plane's decision to absorb a submitted
 * Result into its Run, states that it happens only there, and distinguishes it
 * by name from the validation a Worker performs on its own output. Reusing it
 * here would re-collapse the two operations ADR 0010's clarification of ADR
 * 0006 separated.
 *
 * **The bundle is strictly narrower than a Result.** It carries candidate
 * Findings and *claimed* Evidence, and nothing here has crossed the Worker
 * boundary yet. Everything that leaves the Sandbox is attacker-controlled.
 */
import type { Autonomy, Harness, Severity, Usage, Verification } from "@reprove/protocol/v1";
import type { Sandbox } from "@reprove/sandbox-container";
import type { TrustedInstructions } from "./instructions.js";
export type { Autonomy, Harness } from "@reprove/protocol/v1";
/**
 * The resolved capability view: the one folding in the credential, the Sandbox,
 * `Exposure` and the pinned Model. The registration view answers a different
 * question at a lower fidelity and is not what a Pass may be authorized
 * against.
 */
export interface ResolvedCapability {
    /** The levels this resolved invocation can actually enforce. */
    readonly supportedAutonomy: readonly Autonomy[];
    /**
     * ADR 0009's hard dispatch gate. Named for the guarantee rather than for the
     * mechanism, because suppression alone is not the whole boundary.
     */
    readonly canEnforceRepoInstructionBoundary: boolean;
    /** Whether the pinned-Model check can be performed at all. */
    readonly reportsResolvedModel: boolean;
    /**
     * The behavioural probe's fingerprint over the Harness artifact, Route,
     * Adapter version and suppression implementation. A version allowlist was
     * rejected: it encodes a claim about a version string rather than about the
     * property.
     */
    readonly probeFingerprint: string;
    /** When the probe behind this capability was taken, in epoch milliseconds. */
    readonly probedAt: number;
}
/** One command a Reviewer says it ran, and what it says came back. */
export interface ClaimedEvidence {
    readonly command: string;
    readonly exitCode: number | null;
    readonly durationMs: number;
    /** Unbounded, in-Sandbox, attacker-controlled. It never crosses as it is. */
    readonly output: string;
}
/** One location, as a candidate Finding claims it. */
export interface CandidateLocation {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
}
/**
 * A Finding as the Reviewer made it, before anything has been checked.
 *
 * `verification` arrives as the Reviewer assigned it and is never rewritten:
 * ADR 0002 makes it the whole trust signal a Finding carries, and quietly
 * editing it downward would corrupt the one thing it is for.
 */
export interface CandidateFinding {
    readonly title: string;
    readonly body: string;
    readonly severity: Severity;
    readonly verification: Verification;
    readonly location: CandidateLocation;
    readonly anchoredText: string;
    readonly evidence: readonly ClaimedEvidence[];
    readonly patch?: {
        readonly path: string;
        readonly startLine: number;
        readonly endLine: number;
        readonly replacement: string;
    };
}
/**
 * One tool execution the Adapter observed on the Harness's own stream.
 *
 * This is the record a claim is checked against. It proves the Harness observed
 * the execution; it does not make the command's output trustworthy.
 */
export interface ObservedToolCall {
    readonly command: string;
    readonly exitCode: number | null;
}
/** How a Pass ended, in the Adapter's own vocabulary. */
export type PassOutcome = "completed" | "partial" | "failed";
/**
 * ADR 0007's per-Pass bundle, which deliberately has no domain name.
 *
 * Strategy composition happens above the Adapter, so one invocation cannot own
 * the final Result. Today the relationship is one Pass to one bundle to one
 * Result, and the distinction has no referent on any surface.
 */
export interface AdapterPassOutput {
    readonly outcome: PassOutcome;
    /** Required exactly when the outcome is `partial`. */
    readonly stoppedBy: "budget_exhausted" | "cancelled" | "superseded" | null;
    readonly summary: string;
    /**
     * Hypotheses verification disproved, which never became Findings. Carried
     * because a Reviewer that disproved ten claims and raised none did work a
     * Reviewer that raised none without looking did not.
     */
    readonly disprovedHypothesisCount: number;
    readonly findings: readonly CandidateFinding[];
    readonly observed: readonly ObservedToolCall[];
    readonly usage: Usage;
    /** `null` where the Harness does not report what it resolved to. */
    readonly resolvedModel: string | null;
    readonly repairTurnUsed: boolean;
    /** Required exactly when the outcome is `failed`. */
    readonly failureReason: string | null;
}
/** What Worker core says about a bundle it will not build a Result from. */
export interface ConformanceComplaint {
    readonly reason: "result_invalid" | "evidence_unsupported";
    readonly detail: string;
}
/**
 * Everything a Pass is given. Note what is absent: no credential, no GitHub
 * authority, no raw narrative, and no repository-supplied instructions.
 */
export interface PassRequest {
    readonly runId: string;
    readonly passId: string;
    readonly model: string;
    readonly autonomy: Autonomy;
    /** Reprove-authored, plus deliberately re-admitted base conventions. */
    readonly instructions: TrustedInstructions;
    /** The Sandbox Worker core already launched, attested and authorized. */
    readonly sandbox: Sandbox;
    /** Pass budget enforcement, which no adapter offers on its own. */
    readonly signal: AbortSignal;
    /**
     * Worker core's conformance check, which the Adapter may answer with its one
     * bounded repair turn. A `null` complaint means the bundle would survive it.
     */
    readonly check: (output: AdapterPassOutput) => ConformanceComplaint | null;
}
export interface Adapter {
    readonly harness: Harness;
    /** The resolved view, taken fresh per dispatch. */
    readonly capability: () => Promise<ResolvedCapability>;
    readonly pass: (request: PassRequest) => Promise<AdapterPassOutput>;
}
```

## dist/dispatch.d.ts

```ts
/**
 * Everything Worker core decides before a single byte of repository code runs.
 *
 * ADR 0004 gates dispatch on `Exposure` x `Isolation` x `Provenance`, ADR 0005
 * makes a resolved capability the only view safe to act on, ADR 0009 promotes
 * the instruction boundary from an advisory field to a hard gate, and ADR 0011
 * gives a Repository a maximum Exposure it will run under. They are one ordered
 * decision here rather than five scattered conditions,
 * because the guarantee is the conjunction: **nothing warns and runs.** A
 * missing hard requirement is a Refusal, never a narrowing and never a log
 * line, and a warning in a Worker log is silent to the person whose pull
 * request is being reviewed.
 *
 * Every function here is pure and can only refuse. That is the shape of "Worker
 * core alone authorizes execution": an Adapter's capability and a Sandbox's
 * Attestation are *inputs* to this decision, and neither is a decision.
 */
import type { Autonomy, Exposure, Provenance } from "@reprove/protocol/v1";
import type { ResolvedCapability } from "./adapter.js";
/**
 * `CONTEXT.md`'s Isolation ladder, whole.
 *
 * Wider than what `@reprove/sandbox-container` can produce, deliberately: the
 * matrix has `microvm` rows, and a table that omitted the rung nothing
 * implements yet would have to be rewritten rather than extended when one does.
 */
export type IsolationLevel = "microvm" | "container-rootless" | "container";
/**
 * How old a capability probe may be and still be acted on.
 *
 * Five minutes is a Phase 0 fixture and not a measured value. What is not a
 * fixture is that a bound exists at all: `@ai-sdk/harness` ships removals as
 * patches at roughly eleven releases a week, so a capability is a measurement
 * with a shelf life rather than a fact about a version string.
 */
export declare const PROBE_MAX_AGE_MS: number;
/** Why Worker core will not serve this Run. Closed, and each names a fact. */
export type RefusalReason = "capability_unresolved" | "capability_probe_stale" | "instruction_boundary_unenforceable" | "autonomy_unsupported" | "exposure_above_maximum" | "isolation_insufficient" | "provenance_ineligible" | "narrative_title_missing" | "narrative_not_protected" | "sandbox_refused";
/**
 * A Refusal's substance, before it is addressed to a Run.
 *
 * A reason code and the relevant resolved facts, never a global verdict: a
 * Worker knows only "I cannot serve this Run, for reason X", and what that
 * means for the Run is the control plane's to decide from the candidate pool,
 * Repository policy and prior Refusals.
 */
export interface RefusalCause {
    readonly reason: RefusalReason;
    readonly required: string | null;
    readonly actual: string | null;
}
export interface DispatchInput {
    readonly autonomy: Autonomy;
    readonly provenance: Provenance;
    /** The one opt-in, read from the base ref so a pull request cannot grant it. */
    readonly allowExternalProvenance: boolean;
    /** Resolved from the credential at dispatch, never from registration. */
    readonly exposure: Exposure;
    /**
     * The Repository's `security.maxExposure`, already narrowed by whatever Owner
     * Ceiling applied. The Worker is the only place it can bind: ADR 0004 resolves
     * `Exposure` from the credential at dispatch, so the control plane that read
     * the key never saw the value it constrains.
     */
    readonly maximumExposure: Exposure;
    /** What the Sandbox provider's host capability actually established. */
    readonly isolation: IsolationLevel;
    readonly capability: ResolvedCapability;
    readonly now: number;
}
/**
 * ADR 0004's dispatch table, as the set of Provenance values a cell permits.
 *
 * Stated as a function of the two axes rather than as a literal table so the
 * one opt-in is visible as the single branch it is. `internal` classifies risk
 * rather than conferring safety: it means an attacker would have to be a
 * collaborator, not that there is no attacker.
 *
 * @param exposure What a fully compromised Sandbox would yield.
 * @param isolation How strongly that Sandbox is separated from its host.
 * @param allowExternalProvenance The Repository's one opt-in, from the base ref.
 * @returns Every Provenance this cell permits, in ladder order.
 */
export declare const permittedProvenance: (exposure: Exposure, isolation: IsolationLevel, allowExternalProvenance: boolean) => readonly Provenance[];
/**
 * Refuses a Run before execution is authorized, or returns `null`.
 *
 * Ordered, and the order is the point: the capability gates come first, because
 * a stale probe means every fact below it was measured against artifacts nobody
 * re-checked, and a Refusal that named the matrix instead would send an
 * operator to look at the wrong thing.
 *
 * @param input Every resolved fact the decision is made from.
 * @returns The cause that refused the Run, or `null` where none did.
 */
export declare const checkDispatch: (input: DispatchInput) => RefusalCause | null;
```

## dist/evidence.d.ts

```ts
import type { Finding } from "@reprove/protocol/v1";
import type { ConformanceComplaint, CandidateFinding, ObservedToolCall } from "./adapter.js";
export interface CrossCheckInput {
    readonly findings: readonly CandidateFinding[];
    /** Every tool execution the Adapter saw on the Harness's own stream. */
    readonly observed: readonly ObservedToolCall[];
}
export type CrossCheck = {
    readonly findings: readonly Finding[];
    readonly complaint: null;
} | {
    readonly findings: null;
    readonly complaint: ConformanceComplaint;
};
/**
 * Checks every claim against what was observed and carries what survives.
 *
 * Observations are consumed as they are matched, so two claims of one command
 * need two observations of it. A shared pool rather than a per-Finding one,
 * because the Adapter observed one Pass and a Reviewer citing the same run in
 * two Findings is citing one execution.
 *
 * @param input The candidate Findings, and the Adapter's observed tool calls.
 * @returns The Findings as Reprove will carry them, or the complaint that
 *   stopped them - never both, and never a Finding edited into acceptability.
 */
export declare const crossCheckEvidence: (input: CrossCheckInput) => CrossCheck;
```

## dist/index.d.ts

```ts
export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";
export declare const packageName: "@reprove/worker-core";
/**
 * Shell. Exercising all three permitted edges through their package exports
 * makes ADR 0010's matrix row a compiled fact rather than a declaration.
 */
export declare const composedFrom: {
    readonly adapters: "@reprove/adapters";
    readonly protocolVersion: 1;
    readonly sandboxContainer: "@reprove/sandbox-container";
};
export type { ConformanceComplaint, Adapter, AdapterPassOutput, Autonomy, CandidateFinding, CandidateLocation, ClaimedEvidence, Harness, ObservedToolCall, PassOutcome, PassRequest, ResolvedCapability, } from "./adapter.js";
export { checkDispatch, permittedProvenance, PROBE_MAX_AGE_MS, } from "./dispatch.js";
export type { DispatchInput, IsolationLevel, RefusalCause, RefusalReason, } from "./dispatch.js";
export { crossCheckEvidence } from "./evidence.js";
export type { CrossCheck, CrossCheckInput } from "./evidence.js";
export { admitConventions, composeInstructions, renderInstructions, } from "./instructions.js";
export type { AdmissionPolicy, AdmittedConvention, ConventionChannel, ConventionOrigin, ConventionRejection, ConventionSource, InstructionRequest, RejectedConvention, TrustedInstructions, } from "./instructions.js";
export { encodeNarrative, NARRATIVE_LIMITS, NARRATIVE_PATH, } from "./narrative.js";
export type { NarrativeInput, NarrativeOutcome, NarrativeRecord, NarrativeRefusal, NarrativeSurface, ProtectedFile, } from "./narrative.js";
export { WORKER_OUTCOME_KINDS } from "./outcome.js";
export type { FailurePhase, FailureReason, InternalFailure, WorkerOutcome, WorkerOutcomeKind, } from "./outcome.js";
export { composeResult } from "./result.js";
export type { ComposedResult, ResultInput } from "./result.js";
export { createWorkerCore } from "./run.js";
export type { Materialize, RunInput, WorkerCore, WorkerCoreOptions, } from "./run.js";
export { PHASE0_SANDBOX_PROFILE, sandboxRequestFor, suppressionEnvironment, } from "./sandbox.js";
export type { SandboxProfile } from "./sandbox.js";
```

## dist/instructions.d.ts

```ts
/**
 * Reprove's trusted instruction channel, and the separation that keeps
 * pull-request-controlled text out of it.
 *
 * [ADR 0009](../../../docs/adr/0009-repo-controlled-instruction-boundary.md)
 * puts the protection **on the channel, not on the content**. Reprove does not
 * try to stop a Reviewer from ever seeing hostile instructions - a malicious
 * string inside a source file is the thing under review. What it stops is the
 * repository under review placing text into a channel the Harness itself treats
 * as privileged.
 *
 * That splits the input in two, and this module is where the split is made:
 *
 * ```text
 * untrusted pull request input  ->  never privileged, fully reviewable
 * trusted base-ref conventions  ->  deliberately re-admitted, subordinate
 * ```
 *
 * Two rules do the work, and each defends a different half. **Origin decides
 * admission**: a convention is read host-side from the pinned base SHA, and a
 * head-origin surface is never admitted whatever it contains. **Indirection is
 * neutralized**: an admitted convention cannot make the Harness resolve
 * anything further, because an `@` reference expanded at the instruction-channel
 * stage resolves against `cwd`, which is the head Workspace.
 */
import type { Autonomy } from "./adapter.js";
import { NARRATIVE_PATH } from "./narrative.js";
/** Where a convention came from. Only one of these is ever re-admitted. */
export type ConventionOrigin = "base" | "head";
/** A candidate convention, read host-side and offered for admission. */
export interface ConventionSource {
    /** Repository-relative, forward-slashed. */
    readonly path: string;
    readonly content: string;
    readonly origin: ConventionOrigin;
}
/** Why a candidate did not reach the channel. */
export type ConventionRejection = "head_origin" | "not_allowlisted" | "re_admission_disabled";
/**
 * An admitted convention, carrying the directory it applies under.
 *
 * The scope is kept because these systems are directory-scoped natively:
 * flattening every `CLAUDE.md` into one undifferentiated blob would turn
 * front-end conventions into repository-wide rules.
 */
export interface AdmittedConvention {
    readonly path: string;
    readonly scope: string;
    readonly content: string;
}
export interface RejectedConvention {
    readonly path: string;
    readonly reason: ConventionRejection;
}
export interface ConventionChannel {
    readonly admitted: readonly AdmittedConvention[];
    readonly rejected: readonly RejectedConvention[];
}
/**
 * What the Repository said about re-admission.
 *
 * A quality control rather than a security control, and ADR 0009 records why:
 * both positions are secure, because disabling it can only make the Reviewer
 * less informed, never more privileged. Authoring conventions are not
 * reviewing conventions.
 */
export interface AdmissionPolicy {
    readonly enabled: boolean;
}
/**
 * Decides which candidate conventions reach Reprove's trusted channel.
 *
 * @param sources Every candidate, each carrying the ref it was read from.
 * @param policy The Repository's re-admission switch.
 * @returns What was admitted, and every rejection named.
 */
export declare const admitConventions: (sources: readonly ConventionSource[], policy: AdmissionPolicy) => ConventionChannel;
/**
 * Everything Reprove delivers through the framework-level `instructions`
 * channel. There is no other member: narrative and head Workspace content are
 * absent from this type, which is what makes their absence checkable.
 */
export interface TrustedInstructions {
    /** Reprove-authored, and authoritative over everything below it. */
    readonly policy: string;
    readonly conventions: readonly AdmittedConvention[];
    /** Where the Reviewer is told to find `authority: none` review data. */
    readonly narrativePath: typeof NARRATIVE_PATH;
}
export interface InstructionRequest {
    readonly autonomy: Autonomy;
    readonly conventions: readonly AdmittedConvention[];
}
/** Composes the channel. Nothing reaches it that was not passed in here. */
export declare const composeInstructions: (request: InstructionRequest) => TrustedInstructions;
/**
 * The channel's text, in the order authority runs: Reprove's policy first, then
 * each convention under a heading naming the path and directory it applies to.
 *
 * Rendering is separate from composition so a test can assert on the exact text
 * a Harness would receive, which is the property ADR 0012's release-blocking
 * contract tests are about.
 */
export declare const renderInstructions: (instructions: TrustedInstructions) => string;
```

## dist/narrative.d.ts

```ts
/** The one path. Fixed, and deliberately not derived from anything. */
export declare const NARRATIVE_PATH: "/reprove/input/narrative.json";
/**
 * ADR 0012's byte-level contract.
 *
 * GitHub publishes neither a maximum length nor Unicode-counting semantics for
 * either field, so Reprove owns the bound rather than inheriting undocumented
 * platform behaviour. `encodedBytes` is derived rather than chosen: the worst
 * JSON escape expands one input byte to six, so the two content limits total
 * 399,360 encoded bytes and the remainder is headroom for the fixed schema and
 * the bounded metadata.
 */
export declare const NARRATIVE_LIMITS: {
    readonly titleBytes: 1024;
    readonly descriptionBytes: number;
    readonly encodedBytes: number;
};
/** The two surfaces Reprove supplies, in the order the file carries them. */
export type NarrativeSurface = "pull_request.title" | "pull_request.description";
/**
 * One record, exactly as it is encoded.
 *
 * `authority` is a literal rather than a computed value: narrative may be
 * edited by an Author, a maintainer, a bot or a GitHub App, and ADR 0012 fixes
 * that actor identity does not change its treatment. There is no actor field to
 * omit, because the schema has none.
 */
export interface NarrativeRecord {
    readonly surface: NarrativeSurface;
    readonly authority: "none";
    /** Absent input, as distinct from deliberately empty input. */
    readonly present: boolean;
    readonly content: string;
    readonly originalUtf8Bytes: number;
    readonly truncated: boolean;
}
/** The narrative as GitHub reported it, before any bound is applied. */
export interface NarrativeInput {
    readonly title: string;
    /** `null` where GitHub reported no description at all. */
    readonly description: string | null;
}
/**
 * The exact bytes a Sandbox is asked to hold, and the digest over them.
 *
 * The digest is an internal integrity aid, retained in execution metadata. It
 * gains no protocol or persistence identity merely because it exists.
 */
export interface ProtectedFile {
    readonly path: typeof NARRATIVE_PATH;
    readonly bytes: string;
    readonly digest: string;
}
/**
 * The one way encoding fails.
 *
 * A missing title violates GitHub's own required input, so there is nothing
 * truthful to encode and nothing to degrade to. Truncation is not here:
 * narrative is optional review context and the truncation is explicit in the
 * data.
 */
export type NarrativeRefusal = "narrative_title_missing";
export type NarrativeOutcome = {
    readonly file: ProtectedFile;
    readonly refusal: null;
} | {
    readonly file: null;
    readonly refusal: NarrativeRefusal;
};
/**
 * Bounds, validates and encodes the narrative into the closed file contract.
 *
 * @param input The title and description as GitHub reported them.
 * @returns The exact bytes to materialize, or the Refusal that replaced them.
 */
export declare const encodeNarrative: (input: NarrativeInput) => NarrativeOutcome;
```

## dist/outcome.d.ts

```ts
/**
 * The three outcomes protocol v1 admits, and no fourth.
 *
 * ```text
 * Result    a normalized payload, complete or partial, schema-validated here
 * Refusal   a decision not to execute, made before execution began
 * Failure   execution began and produced no acceptable Result
 * ```
 *
 * The split between the last two is where the defect was found, not how bad it
 * was. `CONTEXT.md` reserves **Refusal** for a decision made before execution
 * begins and **Failure** for a Pass that began executing and could not produce
 * an acceptable Result, so a hard-boundary defect found before the Adapter is
 * invoked crosses the boundary as a Refusal, and a repair or teardown defect
 * found afterwards does not cross at all.
 *
 * **A Failure carries no protocol payload, deliberately.** Protocol v1 has a
 * `Refusal` schema and a `Result` schema and nothing else, and inventing a
 * third wire shape here would put a message on the boundary that no control
 * plane parses and no ADR settled. The caller - a Worker lifecycle - sees this
 * type and reports the Failure through the mechanism its placement already has:
 * `reportHostedFailure` for a hosted Worker, and the self-hosted Failure path
 * for the other. What must never happen is a Failure serialized as a Refusal,
 * because that would claim nothing executed when something did.
 */
import type { Refusal, Result } from "@reprove/protocol/v1";
/**
 * Why an execution that began produced no acceptable Result.
 *
 * Every member is post-execution by construction. `sandbox_teardown_incomplete`
 * is the one ADR 0015 names explicitly, recorded there as a specific reason
 * that must never be collapsed into `worker_lost`.
 */
export type FailureReason = "pass_failed" | "result_invalid" | "evidence_unsupported" | "model_substituted" | "sandbox_teardown_incomplete";
/**
 * Where in the post-execution sequence the defect was found.
 *
 * `conformance` rather than acceptance: `CONTEXT.md` reserves Acceptance for
 * the control plane's decision to absorb a Result into its Run and says
 * outright that it happens only there, distinguishing it by name from the
 * validation a Worker performs on its own output.
 */
export type FailurePhase = "execution" | "conformance" | "teardown";
/**
 * A Failure, internal to Worker core.
 *
 * Structured rather than an `Error` because the lifecycle above has to report
 * the reason without parsing a message, and because a caught exception with a
 * stack is exactly the unbounded Worker-originated data ADR 0006 keeps off the
 * wire.
 */
export interface InternalFailure {
    readonly reason: FailureReason;
    readonly phase: FailurePhase;
    readonly detail: string;
}
export type WorkerOutcome = {
    readonly kind: "result";
    readonly result: Result;
} | {
    readonly kind: "refusal";
    readonly refusal: Refusal;
} | {
    readonly kind: "failure";
    readonly failure: InternalFailure;
};
/**
 * The whole set, as values.
 *
 * Exported so "and no fourth" is assertable rather than merely intended. The
 * `satisfies` closes one direction - a member listed here that the union does
 * not admit is a compile error - and `run.test.ts` closes the other against a
 * `Record` keyed by the union, because a union that grew a member is invisible
 * to a list that did not.
 */
export declare const WORKER_OUTCOME_KINDS: readonly ["result", "refusal", "failure"];
export type WorkerOutcomeKind = (typeof WORKER_OUTCOME_KINDS)[number];
```

## dist/result.d.ts

```ts
import type { Finding, Result, RunSpec } from "@reprove/protocol/v1";
import type { ConformanceComplaint, AdapterPassOutput } from "./adapter.js";
export interface ResultInput {
    readonly spec: RunSpec;
    readonly pass: AdapterPassOutput;
    /** What survived the Evidence cross-check, in the order it was made. */
    readonly findings: readonly Finding[];
    readonly passId: string;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly workerBuildVersion: string;
}
export type ComposedResult = {
    readonly result: Result;
    readonly complaint: null;
} | {
    readonly result: null;
    readonly complaint: ConformanceComplaint;
};
/**
 * Composes a Result and validates it against the authoritative schema.
 *
 * Validation is not a formality here. The schema carries the cross-field rules
 * that no construction step can be trusted to have honoured - `stoppedBy`
 * required exactly when the Result is partial, no Evidence and no `verified`,
 * a reasoned-only Finding carrying no Evidence, and the strict size bound that
 * makes "no bulk data crosses" enforceable at the edge rather than resting on
 * good behaviour.
 *
 * @param input The bundle, the Findings that survived the cross-check, and the
 *   Run it belongs to.
 * @returns A validated Result, or the complaint a repair turn may answer.
 */
export declare const composeResult: (input: ResultInput) => ComposedResult;
```

## dist/run.d.ts

```ts
import type { Exposure, RunSpec } from "@reprove/protocol/v1";
import type { Sandbox, SandboxProvider } from "@reprove/sandbox-container";
import type { Adapter } from "./adapter.js";
import type { ConventionSource } from "./instructions.js";
import type { NarrativeInput, ProtectedFile } from "./narrative.js";
import type { WorkerOutcome } from "./outcome.js";
import type { SandboxProfile } from "./sandbox.js";
/**
 * Materializes the exact encoded bytes inside the Sandbox, under an identity
 * the Reviewer can read but cannot chmod, unlink, rename or replace.
 *
 * A port rather than a call, because `@reprove/sandbox-container` exposes no
 * write primitive yet and the alternative would be shelling the bytes through
 * an argument vector - which ADR 0012 forbids by name, since the path,
 * filename, arguments and environment must contain no Author-controlled value.
 * Throwing is the Refusal: failure to establish the protected representation is
 * not a degraded Run.
 */
export type Materialize = (sandbox: Sandbox, file: ProtectedFile) => Promise<void>;
export interface WorkerCoreOptions {
    readonly adapter: Adapter;
    readonly sandboxes: SandboxProvider;
    readonly materialize: Materialize;
    readonly workerBuildVersion: string;
    readonly profile?: SandboxProfile;
    readonly clock?: () => number;
    readonly newId?: () => string;
}
/**
 * One Run as Worker core receives it.
 *
 * `exposure` arrives resolved, because ADR 0004 resolves it from the credential
 * at dispatch and the credential itself never enters Worker core. `conventions`
 * arrive as candidates carrying the ref each was read from, so the trusted and
 * untrusted channels are distinguishable here rather than assumed upstream.
 */
export interface RunInput {
    readonly spec: RunSpec;
    readonly narrative: NarrativeInput;
    readonly conventions: readonly ConventionSource[];
    readonly exposure: Exposure;
    readonly signal?: AbortSignal;
}
export interface WorkerCore {
    readonly execute: (input: RunInput) => Promise<WorkerOutcome>;
}
export declare const createWorkerCore: (options: WorkerCoreOptions) => WorkerCore;
```

## dist/sandbox.d.ts

```ts
/**
 * The Sandbox Worker core asks for, stated whole.
 *
 * `@reprove/sandbox-container` deliberately gives no field a default: a field a
 * caller forgot is a field a reviewer cannot see, and a default is a security
 * decision made by whoever wrote it rather than by whoever is running the Run.
 * So the values live here, in one named profile, for the same reason ADR 0016
 * put `livenessFor` in `Phase0RunProfile` rather than inline in the claim path:
 * a Phase 0 fixture that lands in the middle of a code path silently becomes
 * product policy that a later phase inherits unexamined.
 *
 * The environment is the load-bearing part. ADR 0009 found that instruction
 * suppression is a **Sandbox-provisioning concern** rather than an Adapter one,
 * because a per-command environment merges *over* the Sandbox's own: a
 * suppression flag set per command can be shadowed by repository-controlled
 * configuration, and one set here cannot.
 */
import type { Harness } from "@reprove/protocol/v1";
import type { EnvironmentEntry, ResourceLimits, SandboxRequest } from "@reprove/sandbox-container";
/** Everything about a Sandbox that is a fixture rather than a decision. */
export interface SandboxProfile {
    readonly image: string;
    /** What holds the instance open while the Adapter execs the Harness into it. */
    readonly command: readonly string[];
    readonly workspacePath: string;
    readonly workspaceSizeBytes: number;
    readonly limits: ResourceLimits;
    /** Writable scratch, which a read-only root filesystem otherwise denies. */
    readonly scratchPath: string;
    readonly scratchSizeBytes: number;
}
export declare const PHASE0_SANDBOX_PROFILE: SandboxProfile;
/**
 * ADR 0009's suppression levers, per Harness, as the Sandbox's own environment.
 *
 * Two details are measured rather than assumed. OpenCode needs **three**
 * variables: `OPENCODE_DISABLE_PROJECT_CONFIG` alone leaves repo-local
 * `.claude/skills/` and `.agents/skills/` fully loaded. And Codex has no
 * environment lever at all - its levers are the config keys
 * `project_doc_max_bytes=0` and `skills.include_instructions=false`, which the
 * Adapter owns and which ADR 0009 exempts from "unknown or raw configuration is
 * rejected, not forwarded". An empty list for Codex is therefore correct and
 * not an omission; what proves Codex's boundary is
 * `canEnforceRepoInstructionBoundary`, which is a hard dispatch gate.
 *
 * Suppression leaves the Workspace byte-identical to the pull request. Files
 * stay where the Author put them and the Reviewer can still read them as
 * ordinary files; what changes is that the Harness no longer ingests them as
 * configuration.
 */
export declare const suppressionEnvironment: (harness: Harness) => readonly EnvironmentEntry[];
/**
 * The request for one Pass's Sandbox.
 *
 * Nothing credential-shaped is constructible from here: the environment is
 * exactly the suppression set, and the Harness credential reaches the Sandbox
 * through the Route rather than through a request field this function could
 * populate. The provider refuses a credential-shaped entry by name anyway,
 * which is the point of a standalone primitive that assumes nothing about who
 * called it.
 *
 * @param harness The pinned Harness, which decides the suppression levers.
 * @param profile The fixture the Sandbox's shape comes from.
 * @returns One Sandbox, stated whole, for the provider to refuse or launch.
 */
export declare const sandboxRequestFor: (harness: Harness, profile: SandboxProfile) => SandboxRequest;
```
