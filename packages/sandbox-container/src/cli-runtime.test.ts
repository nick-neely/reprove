/**
 * The one module in this package that spawns a process, measured against a
 * process it can spawn anywhere: Node itself.
 *
 * What has to be true is that the argument vector every other module in this
 * package spent its effort getting right survives the crossing unaltered. A
 * shell between the two would be a second parser with its own opinion about
 * `;`, `$(...)` and a space, so there is no shell - and the round trip below is
 * what says so rather than a comment claiming it.
 */
import { execPath } from "node:process";

import { describe, expect, it } from "vitest";

import { createCliRuntime } from "./cli-runtime.js";
import { RuntimeUnavailableError } from "./runtime-unavailable.js";

/** A Node one-liner, as the executable a `ContainerRuntime` drives. */
const nodeRuntime = createCliRuntime({ name: "docker", executable: execPath });

const ECHO_ARGV = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";

describe("the command-line runtime", () => {
  it("forwards every argument verbatim, with no shell in between", async () => {
    // Every one of these means something to a shell and nothing to a runtime.
    const hostile = ["a;b", "$(id)", "`id`", "x y", "*", "&& rm -rf /", ""];
    const invoked = await nodeRuntime.invoke({
      arguments: ["-e", ECHO_ARGV, ...hostile],
    });

    expect(JSON.parse(invoked.stdout)).toStrictEqual(hostile);
    expect(invoked.exitCode).toBe(0);
  });

  it("returns a non-zero exit as an outcome rather than throwing it", async () => {
    // `docker inspect` on an instance that does not exist is a fact about the
    // world, and the pipeline reads it as one. Throwing would make "no such
    // instance" indistinguishable from "no such daemon".
    const invoked = await nodeRuntime.invoke({
      arguments: [
        "-e",
        'process.stderr.write("no such thing");process.exit(7)',
      ],
    });

    expect(invoked.exitCode).toBe(7);
    expect(invoked.stderr).toBe("no such thing");
  });

  it("writes standard input and closes it", async () => {
    const invoked = await nodeRuntime.invoke({
      arguments: [
        "-e",
        "process.stdin.on('data', (d) => process.stdout.write(d))",
      ],
      stdin: "a seccomp profile, one day",
    });

    expect(invoked.stdout).toBe("a seccomp profile, one day");
  });

  it("refuses a timed-out invocation rather than reading it as a success", async () => {
    // The case a bare `Number(error.code)` gets wrong: Node reports no exit
    // code for a killed child, `Number(null)` is `0`, and the invocation would
    // hand back exit status zero and the output that had arrived before the
    // kill. A `start` that reads as successful and did not happen is worse than
    // any error.
    const impatient = createCliRuntime({
      name: "docker",
      executable: execPath,
      timeoutMs: 200,
    });

    await expect(
      impatient.invoke({
        arguments: [
          "-e",
          'process.stdout.write("partial");setTimeout(() => undefined, 10_000)',
        ],
      })
    ).rejects.toThrow(RuntimeUnavailableError);
  });

  it("refuses output too large to buffer rather than truncating it", async () => {
    const narrow = createCliRuntime({
      name: "docker",
      executable: execPath,
      maxBufferBytes: 64,
    });

    await expect(
      narrow.invoke({
        arguments: ["-e", 'process.stdout.write("x".repeat(10_000))'],
      })
    ).rejects.toThrow(RuntimeUnavailableError);
  });

  it("refuses a child killed by something other than the timeout", async () => {
    // Node sets `killed` only when *this* process did the killing, so an
    // out-of-memory kill, an operator or a supervisor produces `killed: false`,
    // `code: null` and a signal - and `Number(null)` is `0`. Reading the code
    // would hand back exit status zero and whatever output had arrived.
    await expect(
      nodeRuntime.invoke({
        arguments: [
          "-e",
          'process.stdout.write("partial");process.kill(process.pid, "SIGKILL")',
        ],
      })
    ).rejects.toThrow(RuntimeUnavailableError);
  });

  it("survives a child that closes standard input and exits underneath it", async () => {
    // `EPIPE` on the child's stdin arrives as an EventEmitter error, not a
    // rejected promise, so an unhandled one is an uncaught exception that takes
    // the whole Worker down rather than failing this invocation. Four megabytes
    // against a child that exits immediately reproduces it every time.
    const invoked = await nodeRuntime.invoke({
      arguments: ["-e", "process.exit(3)"],
      stdin: "x".repeat(4_000_000),
    });

    expect(invoked.exitCode).toBe(3);
  });

  it("names the executable it could not find rather than raising ENOENT", async () => {
    const absent = createCliRuntime({
      name: "podman",
      executable: "/nonexistent/podman",
    });

    await expect(absent.invoke({ arguments: ["info"] })).rejects.toThrow(
      RuntimeUnavailableError
    );
    await expect(absent.invoke({ arguments: ["info"] })).rejects.toThrow(
      "/nonexistent/podman"
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses to exist with a timeout of %o",
    (timeoutMs) => {
      // `execFile` arms its killer only when `timeout > 0`, so a zero is not
      // "no timeout" but "wait for a wedged daemon forever" - and the whole
      // point of the timeout is that a Worker is never held open by one. It is
      // refused where it is a configuration mistake rather than at the
      // invocation that never returns.
      expect(() =>
        createCliRuntime({ name: "docker", executable: execPath, timeoutMs })
      ).toThrow(RangeError);
    }
  );

  it("defaults its executable to the runtime's own name", () => {
    expect(createCliRuntime({ name: "podman" }).name).toBe("podman");
  });
});
