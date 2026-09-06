import type { SandboxConnection } from "./connection.js";
import type { CodexReasoningEffort } from "./reasoning.js";

type Autonomy = "inspect" | "verify" | "fix";
type Severity = "critical" | "high" | "medium" | "low";
type Verification = "verified" | "inconclusive" | "static";
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}
interface TrustedInstructions {
  readonly policy: string;
  readonly conventions: readonly {
    readonly path: string;
    readonly scope: string;
    readonly content: string;
  }[];
  readonly narrativePath: string;
}
interface Sandbox {
  readonly id: string;
  readonly workspace: { readonly path: string };
  readonly access?: SandboxConnection;
}

export interface ResolvedCapability {
  /** Resolved from the credential; callers cannot lower this Exposure. */
  readonly exposure?: "none" | "scoped" | "account";
  readonly supportedAutonomy: readonly Autonomy[];
  readonly canEnforceRepoInstructionBoundary: boolean;
  readonly reportsResolvedModel: boolean;
  readonly probeFingerprint: string;
  readonly probedAt: number;
}

export interface ClaimedEvidence {
  readonly command: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly output: string;
}

export interface CandidateLocation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

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

export interface ObservedToolCall {
  readonly command: string;
  readonly exitCode: number | null;
}

export type PassOutcome = "completed" | "partial" | "failed";

export interface AdapterPassOutput {
  readonly outcome: PassOutcome;
  readonly stoppedBy: "budget_exhausted" | "cancelled" | "superseded" | null;
  readonly summary: string;
  readonly disprovedHypothesisCount: number;
  readonly findings: readonly CandidateFinding[];
  readonly observed: readonly ObservedToolCall[];
  readonly usage: Usage;
  readonly resolvedModel: string | null;
  readonly repairTurnUsed: boolean;
  readonly failureReason: string | null;
}

export interface ConformanceComplaint {
  readonly reason: "result_invalid" | "evidence_unsupported";
  readonly detail: string;
}

/** Live, untrusted progress metadata. Observer exceptions fail the Pass. */
export type PassProgress =
  | { readonly type: "started" | "repair-started" }
  | {
      readonly type: "tool-completed";
      readonly tool: {
        readonly kind: "command";
        readonly exitCode: number | null;
      };
    }
  | { readonly type: "usage"; readonly usage: Usage }
  | {
      readonly type: "finished";
      readonly outcome: PassOutcome;
      readonly failureReason: string | null;
    };

export interface PassRequest {
  readonly reasoningEffort?: CodexReasoningEffort;
  /** Synchronous subscription; events arrive while the Pass is running. */
  readonly onProgress?: (event: PassProgress) => void;
  readonly runId: string;
  readonly passId: string;
  readonly model: string;
  readonly autonomy: Autonomy;
  readonly instructions: TrustedInstructions;
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal;
  readonly check: (output: AdapterPassOutput) => ConformanceComplaint | null;
}

export interface Adapter {
  readonly harness: "codex";
  readonly capability: (
    request?: Pick<
      PassRequest,
      "sandbox" | "model" | "signal" | "reasoningEffort"
    >
  ) => Promise<ResolvedCapability>;
  readonly pass: (request: PassRequest) => Promise<AdapterPassOutput>;
}
