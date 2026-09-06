import { packageName as adapters } from "@reprove/adapters";
import { protocolVersion } from "@reprove/protocol/v1";
import { packageName as sandboxContainer } from "@reprove/sandbox-container";

export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";

export const packageName = "@reprove/worker-core" as const;

/**
 * Shell. Exercising all three permitted edges through their package exports
 * makes ADR 0010's matrix row a compiled fact rather than a declaration.
 */
export const composedFrom = {
  adapters,
  protocolVersion,
  sandboxContainer,
} as const;

export type {
  ConformanceComplaint,
  Adapter,
  AdapterPassOutput,
  Autonomy,
  CandidateFinding,
  CandidateLocation,
  ClaimedEvidence,
  Harness,
  ObservedToolCall,
  PassOutcome,
  PassRequest,
  ResolvedCapability,
} from "./adapter.js";
export {
  checkDispatch,
  permittedProvenance,
  PROBE_MAX_AGE_MS,
} from "./dispatch.js";
export type {
  DispatchInput,
  IsolationLevel,
  RefusalCause,
  RefusalReason,
} from "./dispatch.js";
export { crossCheckEvidence } from "./evidence.js";
export type { CrossCheck, CrossCheckInput } from "./evidence.js";
export {
  admitConventions,
  composeInstructions,
  renderInstructions,
} from "./instructions.js";
export type {
  AdmissionPolicy,
  AdmittedConvention,
  ConventionChannel,
  ConventionOrigin,
  ConventionRejection,
  ConventionSource,
  InstructionRequest,
  RejectedConvention,
  TrustedInstructions,
} from "./instructions.js";
export {
  encodeNarrative,
  NARRATIVE_LIMITS,
  NARRATIVE_PATH,
} from "./narrative.js";
export type {
  NarrativeInput,
  NarrativeOutcome,
  NarrativeRecord,
  NarrativeRefusal,
  NarrativeSurface,
  ProtectedFile,
} from "./narrative.js";
export { WORKER_OUTCOME_KINDS } from "./outcome.js";
export type {
  FailurePhase,
  FailureReason,
  InternalFailure,
  WorkerOutcome,
  WorkerOutcomeKind,
} from "./outcome.js";
export { composeResult } from "./result.js";
export type { ComposedResult, ResultInput } from "./result.js";
export { createWorkerCore } from "./run.js";
export type {
  Materialize,
  RunInput,
  WorkerCore,
  WorkerCoreOptions,
} from "./run.js";
export {
  PHASE0_SANDBOX_PROFILE,
  sandboxRequestFor,
  suppressionEnvironment,
} from "./sandbox.js";
export type { SandboxProfile } from "./sandbox.js";
