/**
 * What a provider throws instead of returning a Sandbox.
 *
 * `CONTEXT.md`'s noun is **Refusal**: a decision not to execute, made before
 * execution begins, because a requirement was not met. The `Error` suffix is
 * the JavaScript convention for a throwable and is not a second domain word.
 *
 * There is no flag that turns this into a warning and no path to a `Sandbox`
 * that skipped it. ADR 0004 puts it plainly: a missing hard requirement is a
 * refusal, and a warning in a Worker log is silent to the person whose pull
 * request is being reviewed.
 */
import { failedNames } from "./requirements.js";
import type { RequirementOutcome } from "./requirements.js";

/**
 * A Refusal carrying every outcome that produced it.
 *
 * The whole set is carried rather than only the failures, because the Worker's
 * structured isolation report is built from it and "which requirements were
 * even measured" is half of what makes a refusal explicable. There is no
 * `required`/`actual` pair here: those belong to a comparison against a
 * demanded Isolation, which is a Worker's decision to make from `outcomes` and
 * `isolation`, not this package's.
 */
export class SandboxRefusalError extends Error {
  readonly outcomes: readonly RequirementOutcome[];

  constructor(outcomes: readonly RequirementOutcome[]) {
    const failed = outcomes.filter((each) => !each.satisfied);
    super(
      [
        `refusing to launch a Sandbox: ${failed.length} of ${outcomes.length} hard requirements failed`,
        ...failed.map((each) => `  x ${each.name}: ${each.detail}`),
      ].join("\n")
    );
    this.name = "SandboxRefusalError";
    this.outcomes = outcomes;
  }

  /** The requirements that failed, in the order they were measured. */
  get failed(): readonly string[] {
    return failedNames(this.outcomes);
  }
}
