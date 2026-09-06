/**
 * One Run through the Worker boundary.
 *
 * ```text
 *  1 resolve the Adapter capability      fresh, per dispatch
 *  2 establish the host's Isolation      from the Sandbox provider
 *  3 the dispatch gates                  Refusal
 *  4 bound and encode the narrative      Refusal
 *  5 separate the instruction channels   head origin is never admitted
 *  6 launch the Sandbox                  Refusal
 *  7 materialize the protected file      Refusal
 *  -- execution is authorized here and nowhere earlier --
 *  8 the Pass                            Failure
 *  9 the pinned-Model check              Failure
 * 10 conform: cross-check, then validate Failure
 * 11 teardown                            Failure
 * ```
 *
 * The pinned-Model check precedes the conformance check for the reason ADR
 * 0016 gave Acceptance's re-probe its order: a substituted Model is a stronger
 * and clearer fact than a schema complaint, and no repair turn can un-substitute
 * one.
 *
 * The line at step 7 is the whole design. Everything above it can only refuse,
 * and a Refusal crosses the boundary as a protocol message naming the
 * requirement that failed. Everything below it is a Failure, which is internal:
 * execution began, so claiming nothing ran would be false, and protocol v1
 * carries no third payload to say otherwise.
 *
 * **Worker core is the only authorizer.** An Adapter reports a capability, a
 * Sandbox provider attests an instance, and each of those can only take
 * eligibility away. Neither authorizes itself, and neither is reached at all
 * until every gate above it has passed.
 */
import { addAbortListener } from "node:events";

import { protocolVersion, refusalSchema } from "@reprove/protocol/v1";
import type { Exposure, Refusal, RunSpec } from "@reprove/protocol/v1";
import {
  SandboxRefusalError,
  SandboxTeardownError,
} from "@reprove/sandbox-container";
import type { Sandbox, SandboxProvider } from "@reprove/sandbox-container";

import type {
  Adapter,
  ConformanceComplaint,
  AdapterPassOutput,
  ResolvedCapability,
  PassProgress,
} from "./adapter.js";
import { checkDispatch } from "./dispatch.js";
import type { IsolationLevel, RefusalCause } from "./dispatch.js";
import { crossCheckEvidence } from "./evidence.js";
import { admitConventions, composeInstructions } from "./instructions.js";
import type { ConventionSource, TrustedInstructions } from "./instructions.js";
import { encodeNarrative } from "./narrative.js";
import type { NarrativeInput, ProtectedFile } from "./narrative.js";
import type { InternalFailure, WorkerOutcome } from "./outcome.js";
import { composeResult } from "./result.js";
import { PHASE0_SANDBOX_PROFILE, sandboxRequestFor } from "./sandbox.js";
import type { SandboxProfile } from "./sandbox.js";

/**
 * Materializes the exact encoded bytes inside the Sandbox, under an identity
 * the Reviewer can read but cannot chmod, unlink, rename or replace.
 *
 * The composition root supplies Workspace materialization and can use the
 * production `materializeNarrative` helper for the protected representation.
 * Author bytes travel on stdin, never in argument vectors or environment.
 * Throwing is a Refusal, before any Reviewer executes.
 */
export type Materialize = (
  sandbox: Sandbox,
  file: ProtectedFile
) => Promise<void>;

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
  readonly onProgress?: (event: PassProgress) => void;
  readonly spec: RunSpec;
  readonly narrative: NarrativeInput;
  readonly conventions: readonly ConventionSource[];
  readonly exposure: Exposure;
  readonly signal?: AbortSignal;
}

export interface WorkerCore {
  readonly execute: (input: RunInput) => Promise<WorkerOutcome>;
}

/**
 * One side of a cause, as a field the schema will accept.
 *
 * `required` and `actual` are non-empty-or-absent on the wire, and half of the
 * causes here read `actual` off a caught value: `String(error)` over a thrown
 * empty string is `""`, which the schema rejects. Refusing to build the Refusal
 * would leave the Run with no outcome at all, which is the one thing this
 * boundary promises cannot happen, so an empty side says that it was empty.
 */
const stated = (side: string | null): string | null =>
  side === "" ? "reported with no detail" : side;

const refuse = (
  spec: RunSpec,
  cause: RefusalCause,
  workerBuildVersion: string
): WorkerOutcome => {
  // Validated on the way out for the same reason a Result is: a Refusal is a
  // protocol message, and Worker core does not ship one it has not checked.
  const refusal: Refusal = refusalSchema.parse({
    runId: spec.runId,
    reason: cause.reason,
    required: stated(cause.required),
    actual: stated(cause.actual),
    protocolVersion,
    workerBuildVersion,
  });
  return { kind: "refusal", refusal };
};

const fail = (failure: InternalFailure): WorkerOutcome => ({
  kind: "failure",
  failure,
});

const randomId = (): string =>
  globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16);

/**
 * The Isolation the provider's own host capability established.
 *
 * Widened to `CONTEXT.md`'s ladder rather than narrowed to the container
 * runtime's, because the dispatch matrix is stated over the ladder and a
 * provider that can one day produce a microvm should not need the matrix
 * rewritten.
 */
const isolationOf = async (
  sandboxes: SandboxProvider
): Promise<IsolationLevel> => {
  const host = await sandboxes.capability();
  return host.isolation;
};

const resolveWithinDeadline = async <T>(
  resolve: (signal: AbortSignal) => Promise<T>,
  caller?: AbortSignal
): Promise<T> => {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(caller ? [caller] : []),
  ]);
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const subscription = addAbortListener(signal, () =>
    cancelled.reject(signal.reason)
  );
  try {
    return await Promise.race([resolve(signal), cancelled.promise]);
  } finally {
    subscription[Symbol.dispose]();
  }
};

export const createWorkerCore = (options: WorkerCoreOptions): WorkerCore => {
  const profile = options.profile ?? PHASE0_SANDBOX_PROFILE;
  const clock = options.clock ?? Date.now;
  const newId = options.newId ?? randomId;
  const { adapter, materialize, sandboxes, workerBuildVersion } = options;

  /**
   * Worker core's conformance decision over one bundle: cross-check first, then
   * schema validation. The Adapter is handed this so its one bounded repair
   * turn answers the same question the final decision asks, rather than a
   * weaker one it invented.
   */
  const checkConformance = (
    spec: RunSpec,
    output: AdapterPassOutput,
    passId: string,
    startedAt: string
  ) => {
    const checked = crossCheckEvidence({
      findings: output.findings,
      observed: output.observed,
    });
    if (checked.complaint !== null) {
      return { result: null, complaint: checked.complaint } as const;
    }
    return composeResult({
      spec,
      pass: output,
      findings: checked.findings,
      passId,
      startedAt,
      endedAt: new Date(clock()).toISOString(),
      workerBuildVersion,
    });
  };

  /** Everything from the authorized Pass to the Result, or the Failure. */
  const execute = async (
    input: RunInput,
    sandbox: Sandbox,
    instructions: TrustedInstructions,
    capability: ResolvedCapability
  ): Promise<WorkerOutcome> => {
    const { spec } = input;
    const passId = newId();
    const startedAt = new Date(clock()).toISOString();

    let output: AdapterPassOutput;
    try {
      output = await adapter.pass({
        onProgress: input.onProgress,
        runId: spec.runId,
        passId,
        model: spec.model,
        autonomy: spec.autonomy,
        instructions,
        sandbox,
        signal: input.signal ?? new AbortController().signal,
        check: (candidate): ConformanceComplaint | null =>
          checkConformance(spec, candidate, passId, startedAt).complaint,
      });
    } catch (error) {
      return fail({
        reason: "pass_failed",
        phase: "execution",
        detail: `the Pass threw: ${String(error)}`,
      });
    }

    if (output.outcome === "failed") {
      // A failed Pass is never converted into an empty Result. Empty means the
      // review completed and found nothing.
      return fail({
        reason: "pass_failed",
        phase: "execution",
        detail: output.failureReason ?? "the Adapter reported a failed Pass",
      });
    }

    if (
      capability.reportsResolvedModel &&
      output.resolvedModel !== spec.model
    ) {
      // Not a complaint, because no repair turn can un-substitute a Model.
      // Silent substitution would destroy reproducibility and make
      // cross-harness comparison meaningless, which is the point of Reprove.
      return fail({
        reason: "model_substituted",
        phase: "conformance",
        detail: `the Run pinned ${spec.model} and the Harness resolved ${output.resolvedModel ?? "nothing it reported"}`,
      });
    }

    const conformed = checkConformance(spec, output, passId, startedAt);
    if (conformed.complaint !== null) {
      return fail({
        reason: conformed.complaint.reason,
        phase: "conformance",
        detail: conformed.complaint.detail,
      });
    }

    return { kind: "result", result: conformed.result };
  };

  return {
    execute: async (input) => {
      const { spec } = input;

      let capability: ResolvedCapability;
      let isolation: IsolationLevel;
      try {
        if (adapter.harness !== spec.harness) {
          throw new Error(
            "the selected Adapter does not match the pinned Harness"
          );
        }
        ({ capability, isolation } = await resolveWithinDeadline(
          async () => ({
            capability: await adapter.capability(),
            isolation: await isolationOf(sandboxes),
          }),
          input.signal
        ));
      } catch (error) {
        return refuse(
          spec,
          {
            reason: "capability_unresolved",
            required: "a resolved Adapter and Sandbox capability",
            actual: String(error),
          },
          workerBuildVersion
        );
      }

      const refused = checkDispatch({
        autonomy: spec.autonomy,
        provenance: spec.provenance,
        allowExternalProvenance:
          spec.resolvedConfig.security.allowExternalProvenance,
        exposure: capability.exposure ?? input.exposure,
        maximumExposure: spec.resolvedConfig.security.maxExposure,
        isolation,
        capability,
        now: clock(),
      });
      if (refused !== null) {
        return refuse(spec, refused, workerBuildVersion);
      }

      const narrative = encodeNarrative(input.narrative);
      if (narrative.file === null) {
        return refuse(
          spec,
          {
            reason: narrative.refusal,
            required: "a pull request title",
            actual: "none",
          },
          workerBuildVersion
        );
      }

      const instructions = composeInstructions({
        autonomy: spec.autonomy,
        conventions: admitConventions(input.conventions, {
          enabled: spec.resolvedConfig.review.baseConventions,
        }).admitted,
      });

      let sandbox: Sandbox;
      try {
        sandbox = await sandboxes.launch(
          sandboxRequestFor(spec.harness, profile)
        );
      } catch (error) {
        return refuse(
          spec,
          {
            reason: "sandbox_refused",
            required: "every hard Sandbox property",
            actual:
              error instanceof SandboxRefusalError
                ? error.failed.join(", ") || error.message
                : String(error),
          },
          workerBuildVersion
        );
      }

      try {
        await materialize(sandbox, narrative.file);
      } catch (error) {
        // Still pre-execution, so still a Refusal - and the Sandbox this Run
        // will never use is torn down on the way out. A teardown that then
        // fails quarantines the runtime through the provider; it does not
        // rewrite the requirement that failed here, which is the only thing
        // anyone reading this needs.
        await sandbox.teardown().catch(() => {
          // Swallowed on purpose. The provider has already quarantined the
          // runtime if it could not account for what it created, and reporting
          // a cleanup failure in place of the Refusal would hide which
          // requirement failed.
        });
        return refuse(
          spec,
          {
            reason: "narrative_not_protected",
            required: `${narrative.file.path} materialized and protected`,
            actual: String(error),
          },
          workerBuildVersion
        );
      }

      // Resolve again against the actual attested instance. Artifact or
      // Workspace mismatches are Refusals, before any Reviewer executes.
      let instanceRefusal: RefusalCause | null;
      try {
        capability = await resolveWithinDeadline(
          (signal) =>
            adapter.capability({ sandbox, model: spec.model, signal }),
          input.signal
        );
        instanceRefusal = checkDispatch({
          autonomy: spec.autonomy,
          provenance: spec.provenance,
          allowExternalProvenance:
            spec.resolvedConfig.security.allowExternalProvenance,
          exposure: capability.exposure ?? input.exposure,
          maximumExposure: spec.resolvedConfig.security.maxExposure,
          isolation: sandbox.isolation,
          capability,
          now: clock(),
        });
      } catch {
        instanceRefusal = {
          reason: "capability_unresolved",
          required: "a capability for the actual Sandbox",
          actual: "instance resolution failed",
        };
      }
      if (instanceRefusal) {
        try {
          await sandbox.teardown();
        } catch {
          /* Provider quarantines uncertain cleanup. */
        }
        return refuse(spec, instanceRefusal, workerBuildVersion);
      }

      // Nothing between here and teardown may throw past this point. The Pass
      // itself is caught inside `execute`, but the conformance step reads a
      // shape the Adapter supplied, and a Sandbox left running because a
      // malformed bundle threw on the way out is the one thing teardown exists
      // to prevent.
      let outcome: WorkerOutcome;
      try {
        outcome = await execute(input, sandbox, instructions, capability);
      } catch (error) {
        outcome = fail({
          reason: "pass_failed",
          phase: "execution",
          detail: `the Run threw after execution began: ${String(error)}`,
        });
      }

      try {
        await sandbox.teardown();
      } catch (error) {
        // Fail closed. A host that cannot prove it destroyed the last Sandbox
        // cannot be trusted with the next one, and a Result carried out of an
        // unprovable teardown would be a Run reported as clean by a Worker that
        // does not know what it left running.
        return fail({
          reason: "sandbox_teardown_incomplete",
          phase: "teardown",
          detail:
            error instanceof SandboxTeardownError
              ? error.message
              : `teardown could not be confirmed: ${String(error)}`,
        });
      }

      return outcome;
    },
  };
};
