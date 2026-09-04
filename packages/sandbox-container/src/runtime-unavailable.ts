/**
 * What a runtime that produced no outcome at all raises.
 *
 * Its own module because the house rule is one class per file, and its own
 * class because "the daemon said no" and "there was no answer from the daemon"
 * need opposite fixes. A bare `ENOENT` names neither the runtime nor the
 * executable, and a Worker reading it has to guess which of the two it was
 * driving.
 *
 * It covers both ways an invocation ends without an exit status: an executable
 * that could not be run, and one that was killed before it finished. The second
 * is the one worth stating out loud - a killed child has no exit code, and
 * anything that reads a missing code as zero turns a timeout into a success
 * carrying whatever output had arrived by then.
 */
import type { RuntimeName } from "./request.js";

/** The container runtime produced no exit status: it did not run, or it was killed. */
export class RuntimeUnavailableError extends Error {
  readonly runtime: RuntimeName;
  readonly executable: string;

  /**
   * @param runtime Which runtime was being driven.
   * @param executable The command that produced nothing.
   * @param what The whole predicate, so a kill does not read as a failed spawn.
   */
  constructor(runtime: RuntimeName, executable: string, what: string) {
    super(`the ${runtime} runtime is unavailable: ${executable} ${what}`);
    this.name = "RuntimeUnavailableError";
    this.runtime = runtime;
    this.executable = executable;
  }
}
