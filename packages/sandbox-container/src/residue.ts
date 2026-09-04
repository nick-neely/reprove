/**
 * What teardown left behind, and what a provider throws when it did.
 *
 * A Failure rather than a Refusal: execution had already begun, and
 * `CONTEXT.md` reserves Refusal for a decision made before it. ADR 0015 gives
 * the identifier `sandbox_teardown_incomplete` and says it is never collapsed
 * into `worker_lost` - a Worker that is alive and cannot destroy what it
 * created is a different problem from a Worker nobody can reach.
 */
import { outcome } from "./requirements.js";
import type { RequirementOutcome } from "./requirements.js";

/** One thing that should not still exist. */
export interface Residue {
  readonly kind: "instance" | "workspace";
  readonly id: string;
}

const describe = (residue: readonly Residue[]): string =>
  residue.map((each) => `${each.kind} ${each.id}`).join(", ");

/**
 * Teardown's own outcome, measured by re-listing each resource through the
 * runtime rather than by trusting the exit code of the command that removed it.
 *
 * @param residue What the re-list still found.
 * @returns The outcome a Failure is raised from.
 */
export const checkResidue = (residue: readonly Residue[]): RequirementOutcome =>
  outcome(
    "teardown-leaves-no-residue",
    residue.length === 0,
    residue.length === 0
      ? "the instance and its Workspace are both gone"
      : `teardown left ${describe(residue)} behind`
  );

/**
 * A teardown that could not prove it destroyed what it created.
 *
 * Throwing is not the whole response: the provider also quarantines the local
 * capability, because a host that cannot prove it destroyed the last Sandbox
 * cannot be trusted with the next one.
 */
export class SandboxTeardownError extends Error {
  /** ADR 0015's reserved failure identifier. */
  readonly reason = "sandbox_teardown_incomplete";
  readonly residue: readonly Residue[];

  constructor(residue: readonly Residue[]) {
    super(
      `sandbox_teardown_incomplete: teardown left ${describe(residue)} behind`
    );
    this.name = "SandboxTeardownError";
    this.residue = residue;
  }
}
