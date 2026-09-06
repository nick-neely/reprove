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
import type {
  Autonomy,
  Harness,
  Severity,
  Usage,
  Verification,
} from "@reprove/protocol/v1";
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
  /** Resolved from the credential; callers cannot lower this Exposure. */
  readonly exposure?: "none" | "scoped" | "account";
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
  readonly capability: (
    request?: Pick<PassRequest, "sandbox" | "model" | "signal">
  ) => Promise<ResolvedCapability>;
  readonly pass: (request: PassRequest) => Promise<AdapterPassOutput>;
}
