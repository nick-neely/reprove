/**
 * The process-spawning `ContainerRuntime`.
 *
 * `execFile`, never a shell. Everything security-relevant this package does is
 * expressed as an argument vector, and a shell is a second parser between that
 * vector and the runtime - one that reinterprets `;`, `$(...)`, a backtick, a
 * glob and a space, all of which are legal inside an image reference, a mount
 * path or an environment value. There is no configuration option here that
 * turns one on.
 */
import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { promisify } from "node:util";

import type { RuntimeName } from "./request.js";
import { RuntimeUnavailableError } from "./runtime-unavailable.js";
import type { ContainerRuntime, RuntimeOutcome } from "./runtime.js";

export interface CliRuntimeOptions {
  readonly name: RuntimeName;
  /** Defaults to the runtime's own name, resolved on `PATH`. */
  readonly executable?: string;
  /** Positive and finite. Defaults to ten minutes. */
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

/**
 * Long enough for an image pull on a slow link, short enough that a wedged
 * daemon does not hold a Worker open indefinitely.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/** An `inspect` of a large instance is tens of kilobytes; this is generous. */
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** What `execFile` rejects with, which carries the child's captured output. */
interface FailedInvocation extends ExecFileException {
  readonly stdout?: string;
  readonly stderr?: string;
}

const invokeFile = promisify(execFile);

export const createCliRuntime = (
  options: CliRuntimeOptions
): ContainerRuntime => {
  const executable = options.executable ?? options.name;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  // `execFile` arms its killer only when `timeout > 0`, so a zero, a negative
  // or a `NaN` is not "no timeout" but "wait for a wedged daemon forever" -
  // and holding a Worker open indefinitely is the one thing the timeout exists
  // to stop. A `RangeError` rather than a Refusal: no Sandbox has been asked
  // for yet, and this is a runtime nobody should be handed at all.
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError(
      `timeoutMs is ${timeout}, and a container-runtime invocation must have a positive finite timeout: anything else leaves a wedged ${options.name} holding a Worker open forever`
    );
  }

  return {
    name: options.name,
    invoke: async (invocation): Promise<RuntimeOutcome> => {
      const running = invokeFile(executable, [...invocation.arguments], {
        encoding: "utf-8",
        maxBuffer,
        timeout,
        windowsHide: true,
      });
      // Closed either way. A runtime subcommand that reads standard input and
      // never sees it close waits forever, and the timeout above is the only
      // thing that would end it.
      //
      // The listener is not optional. A child that exits before the write
      // flushes - which every fast-failing subcommand does - makes the pipe
      // emit `EPIPE`, and an `error` event with no listener is an uncaught
      // exception rather than a rejected promise: it takes the Worker down
      // rather than failing this one invocation. The child's own exit status
      // reports what happened, so the broken pipe is simply dropped.
      const { stdin } = running.child;
      stdin?.on("error", () => stdin.destroy());
      stdin?.end(invocation.stdin ?? "");

      try {
        const { stdout, stderr } = await running;
        return { exitCode: 0, stdout, stderr };
      } catch (error) {
        // SAFETY: `promisify(execFile)` rejects with the `ExecFileException`
        // its callback would have been handed, and with nothing else. Its
        // captured output is not on the published type but is always present,
        // so it is read as optional and defaulted rather than asserted.
        const failed = error as FailedInvocation;
        // A child killed by a signal has no exit status: Node reports
        // `code: null` and names the signal, and hands back whatever output had
        // arrived. `Number(null)` is `0`, so reading the code first would turn
        // a killed invocation into a successful one carrying truncated text -
        // and `teardown()` reads a truncated `ps` as "nothing survived".
        //
        // The signal is what is read, not `killed`, which Node sets only when
        // *this* process did the killing. An out-of-memory kill, an operator
        // or a supervisor produces `killed: false` and a signal, and is the
        // same fact. Measured against Node 24, not reasoned about.
        const signal = failed.signal ?? null;
        if (signal !== null) {
          throw new RuntimeUnavailableError(
            options.name,
            executable,
            `was killed by ${signal} without finishing, after at most ${timeout}ms`
          );
        }
        // `code` is the numeric exit status when the child ran, and a spawn
        // error name - `ENOENT`, `EACCES`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`
        // - when it did not. The two are told apart by whether it is a number
        // at all, which is a closed test where a list of error names would be
        // an open one.
        const exitCode = Number(failed.code);
        if (Number.isFinite(exitCode)) {
          return {
            exitCode,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? "",
          };
        }
        throw new RuntimeUnavailableError(
          options.name,
          executable,
          `produced no exit status (${String(failed.code ?? failed.message)})`
        );
      }
    },
  };
};
