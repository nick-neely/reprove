/**
 * The Sandbox contract, run whole against both dialects.
 *
 * Nothing here touches a container runtime, a clock, a filesystem or a random
 * source: the runtime is injected, and so are the clock and the identifier
 * source, so every rendered name and every timestamp is fixed. What that buys
 * is the only kind of security test worth having in a unit suite - one that
 * asserts on the exact argument vector the runtime was handed, for a launch
 * that was refused before it happened as readily as for one that succeeded.
 *
 * ADR 0004's ladder is the reason this is one suite rather than two: the same
 * contract has to hold for Docker and Podman, and `describe.each` is what makes
 * "the same" a fact rather than a claim.
 */
import { describe, expect, it } from "vitest";

import { createCapabilityCache } from "./capability.js";
import { DOCKER_DIALECT, PODMAN_DIALECT } from "./dialect.js";
import type { RuntimeDialect } from "./dialect.js";
import { createPodmanProvider, createSandboxProvider } from "./provider.js";
import type { Sandbox, SandboxProvider } from "./provider.js";
import { SandboxRefusalError } from "./refusal.js";
import type { SandboxRequest } from "./request.js";
import { SandboxTeardownError } from "./residue.js";
import {
  createRecordingRuntime,
  dockerInfoStdout,
  inspectStdout,
  podmanInfoStdout,
} from "./runtime.test-support.js";
import type {
  HostFacts,
  InstanceFacts,
  RecordingRuntime,
  Survivors,
} from "./runtime.test-support.js";

const ID = "probe";
const INSTANCE_NAME = `reprove-sbx-${ID}`;
const WORKSPACE_VOLUME = `reprove-ws-${ID}`;
const NETWORK_NAME = `reprove-net-${ID}`;
const SANDBOX_LABEL = "io.reprove.sandbox=1";

/**
 * A clock that moves.
 *
 * A constant one would satisfy "the capability was established once" for a
 * capability re-established on every launch, so every reading is distinct and
 * `establishedAt` names which reading it was.
 */
const CLOCK_START = 1_700_000_000_000;
const CLOCK_TICK = 1000;

const REQUEST: SandboxRequest = {
  image: "alpine:3.20",
  command: ["/bin/sh", "-c", "true"],
  workspace: { path: "/reprove/workspace", sizeBytes: 1_073_741_824 },
  limits: { cpus: 0.5, memoryBytes: 268_435_456, processes: 64 },
  seccomp: { kind: "runtime-default" },
  egress: { kind: "none" },
  environment: [{ name: "CLAUDE_CODE_SAFE_MODE", value: "1" }],
  mounts: [{ kind: "ephemeral", path: "/tmp", sizeBytes: 67_108_864 }],
};

interface Arrangement {
  readonly provider: SandboxProvider;
  readonly runtime: RecordingRuntime;
  /**
   * A second provider on the same host, sharing this one's cache and runtime.
   *
   * A quarantine is a fact about the host rather than about the object that
   * raised it, so "it stuck" is only proven by something that was not there
   * when it was raised.
   */
  readonly another: () => SandboxProvider;
  /** What the next `info` invocation answers with. */
  readonly setHost: (facts: Partial<HostFacts>) => void;
  /** What the next `inspect` invocation answers with. */
  readonly setInstance: (facts: Partial<InstanceFacts>) => void;
  /** What the teardown re-list still finds. */
  readonly setSurvivors: (survivors: Partial<Survivors>) => void;
}

const arrange = (
  dialect: RuntimeDialect,
  infoStdout: (overrides?: Partial<HostFacts>) => string
): Arrangement => {
  let host: Partial<HostFacts> = {};
  let instance: Partial<InstanceFacts> = {};
  let survivors: Survivors = { instances: [], volumes: [], networks: [] };
  let now = CLOCK_START;
  const runtime = createRecordingRuntime(dialect.name, {
    info: () => ({ exitCode: 0, stdout: infoStdout(host), stderr: "" }),
    inspect: () => ({
      exitCode: 0,
      stdout: inspectStdout({ workspaceVolume: WORKSPACE_VOLUME, ...instance }),
      stderr: "",
    }),
    survivors: () => survivors,
  });
  const cache = createCapabilityCache();
  const build = (): SandboxProvider =>
    createSandboxProvider({
      runtime,
      dialect,
      cache,
      clock: () => {
        now += CLOCK_TICK;
        return now;
      },
      newId: () => ID,
    });

  return {
    runtime,
    provider: build(),
    another: build,
    setHost: (facts) => {
      host = facts;
    },
    setInstance: (facts) => {
      instance = facts;
    },
    setSurvivors: (next) => {
      survivors = { ...survivors, ...next };
    },
  };
};

const refusalFrom = async (launch: Promise<Sandbox>): Promise<string[]> => {
  try {
    await launch;
  } catch (error) {
    if (error instanceof SandboxRefusalError) {
      return [...error.failed];
    }
    throw error;
  }
  throw new Error("the launch was authorized and should have been refused");
};

/** What a launch that failed rather than refused said. */
const messageFrom = async (launch: Promise<Sandbox>): Promise<string> => {
  try {
    await launch;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the launch was authorized and should have failed");
};

/** The index of the first invocation leading with a given argument, or -1. */
const firstIndexOf = (runtime: RecordingRuntime, first: string): number =>
  runtime.invocations.findIndex((argv) => argv[0] === first);

const DIALECTS = [
  { dialect: DOCKER_DIALECT, infoStdout: dockerInfoStdout },
  { dialect: PODMAN_DIALECT, infoStdout: podmanInfoStdout },
] as const;

describe.each(DIALECTS)(
  "a $dialect.name Sandbox provider",
  ({ dialect, infoStdout }) => {
    describe("a launch that is authorized", () => {
      it("renders every hard requirement as an argument, and nothing else", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        await provider.launch(REQUEST);
        const create = runtime.invocations.find((argv) => argv[0] === "create");

        expect(create).toStrictEqual([
          "create",
          "--name",
          INSTANCE_NAME,
          "--label",
          "io.reprove.sandbox=1",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "64",
          "--memory",
          "268435456",
          "--cpus",
          "0.5",
          "--read-only",
          "--volume",
          `${WORKSPACE_VOLUME}:/reprove/workspace`,
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,noexec,size=67108864",
          "--env",
          "CLAUDE_CODE_SAFE_MODE=1",
          "--",
          "alpine:3.20",
          "/bin/sh",
          "-c",
          "true",
        ]);
      });

      it("puts an image that reads as a flag past the flag terminator", async () => {
        // Measured against Docker 29.1.3, not reasoned about: with no `--`, an
        // image of `--privileged` and a command whose first token is the real
        // image produces a privileged instance from a request that never asked
        // for one. Everything after the terminator is positional to both
        // runtimes.
        const { provider, runtime, setInstance } = arrange(dialect, infoStdout);
        setInstance({ privileged: true });
        await refusalFrom(
          provider.launch({
            ...REQUEST,
            image: "--privileged",
            command: ["alpine:3.20", "sh"],
          })
        );
        const create = runtime.invocations.find((argv) => argv[0] === "create");
        const terminator = create?.indexOf("--") ?? -1;

        expect(terminator).toBeGreaterThan(0);
        expect(create?.slice(terminator)).toStrictEqual([
          "--",
          "--privileged",
          "alpine:3.20",
          "sh",
        ]);
      });

      it("never hands the runtime an argument that widens the boundary", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        await sandbox.teardown();
        const everything = runtime.everyArgument();

        // Flattened across the whole life of a Sandbox, not only the create:
        // the point is that no invocation anywhere widens it.
        expect(everything).not.toContain("--privileged");
        expect(everything).not.toContain("--cap-add");
        expect(everything).not.toContain("host");
        expect(everything).not.toContain("seccomp=unconfined");
      });

      it("creates the Workspace as a volume of its own and mounts that", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);

        expect(runtime.invocations).toContainEqual([
          "volume",
          "create",
          "--label",
          SANDBOX_LABEL,
          WORKSPACE_VOLUME,
        ]);
        expect(sandbox.workspace).toStrictEqual({
          id: WORKSPACE_VOLUME,
          path: "/reprove/workspace",
          ephemeral: true,
        });
      });

      it("starts the instance only after it has attested, never before", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);

        // `create` then `inspect` then `start`, in that order and no other. A
        // single `run` would have started the instance before anything could be
        // read back from it, which is why the two are split.
        expect(firstIndexOf(runtime, "create")).toBeLessThan(
          firstIndexOf(runtime, "inspect")
        );
        expect(firstIndexOf(runtime, "inspect")).toBeLessThan(
          firstIndexOf(runtime, "start")
        );
        expect(sandbox.attestation.authorized).toBeTruthy();
      });

      it("carries the Isolation the host was measured at", async () => {
        const { provider, setHost } = arrange(dialect, infoStdout);
        setHost({ rootless: true });

        const sandbox = await provider.launch(REQUEST);

        expect(sandbox.isolation).toBe("container-rootless");
      });

      it("execs inside the instance it launched", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        await sandbox.exec(["id", "-u"]);

        expect(runtime.invocations).toContainEqual([
          "exec",
          "--",
          sandbox.id,
          "id",
          "-u",
        ]);
      });
    });

    describe("a launch refused before the runtime is touched at all", () => {
      it.each([
        {
          why: "a runtime socket was asked for",
          request: {
            ...REQUEST,
            mounts: [
              {
                kind: "host" as const,
                hostPath: "/var/run/docker.sock",
                path: "/var/run/docker.sock",
              },
            ],
          },
          requirements: ["no-host-bind-mount", "no-runtime-socket"],
        },
        {
          why: "a host directory was asked for",
          request: {
            ...REQUEST,
            mounts: [
              {
                kind: "host" as const,
                hostPath: "/home/runner/work",
                path: "/work",
              },
            ],
          },
          requirements: ["no-host-bind-mount"],
        },
        {
          why: "there is no CPU limit",
          request: { ...REQUEST, limits: { ...REQUEST.limits, cpus: 0 } },
          requirements: ["cpu-limit"],
        },
        {
          why: "there is no memory limit",
          request: {
            ...REQUEST,
            limits: { ...REQUEST.limits, memoryBytes: 0 },
          },
          requirements: ["memory-limit"],
        },
        {
          why: "there is no process limit",
          request: { ...REQUEST, limits: { ...REQUEST.limits, processes: 0 } },
          requirements: ["process-limit"],
        },
        {
          why: "a real credential was handed to a brokered Sandbox",
          request: {
            ...REQUEST,
            environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-live" }],
          },
          requirements: ["no-credential-in-brokered-sandbox"],
        },
        {
          why: "the environment names the container runtime's socket",
          request: {
            ...REQUEST,
            environment: [
              { name: "DOCKER_HOST", value: "unix:///var/run/docker.sock" },
            ],
          },
          requirements: ["no-runtime-socket"],
        },
      ])(
        "refuses because $why, having invoked nothing",
        async ({ request, requirements }) => {
          const { provider, runtime } = arrange(dialect, infoStdout);

          await expect(
            refusalFrom(provider.launch(request))
          ).resolves.toStrictEqual(requirements);
          expect(runtime.invocations).toStrictEqual([]);
        }
      );
    });

    describe("a launch refused by the host", () => {
      it.each([
        { drift: { seccomp: false }, requirement: "seccomp-enabled" },
        { drift: { cpu: false }, requirement: "cpu-limit" },
        { drift: { memory: false }, requirement: "memory-limit" },
        { drift: { pids: false }, requirement: "process-limit" },
      ])(
        "refuses a host that cannot enforce $requirement",
        async ({ drift, requirement }) => {
          const { provider, runtime, setHost } = arrange(dialect, infoStdout);
          setHost(drift);

          await expect(
            refusalFrom(provider.launch(REQUEST))
          ).resolves.toStrictEqual([requirement]);
          expect(runtime.countOf("create")).toBe(0);
        }
      );
    });

    describe("a launch refused by the vector it rendered", () => {
      it("refuses a Workspace path that smuggles a second mount target", async () => {
        // The request layer sees an absolute path and a positive size and has
        // nothing to object to. The vector it renders is
        // `--volume reprove-ws-probe:/w:/var/run/docker.sock`, which is a
        // second target the request never named - and the audit reads the
        // vector rather than the intent, which is the whole reason it is a
        // separate layer.
        const { provider, runtime } = arrange(dialect, infoStdout);

        await expect(
          refusalFrom(
            provider.launch({
              ...REQUEST,
              workspace: {
                path: "/w:/var/run/docker.sock",
                sizeBytes: 1_073_741_824,
              },
            })
          )
        ).resolves.toStrictEqual(["no-runtime-socket"]);
        expect(runtime.countOf("create")).toBe(0);
        expect(runtime.countOf("volume")).toBe(0);
      });
    });

    describe("a launch refused by the instance it created", () => {
      it("removes an instance that came up privileged, and never starts it", async () => {
        const { provider, runtime, setInstance } = arrange(dialect, infoStdout);
        setInstance({ privileged: true });

        await expect(
          refusalFrom(provider.launch(REQUEST))
        ).resolves.toStrictEqual(["not-privileged"]);
        expect(runtime.countOf("start")).toBe(0);
        expect(runtime.invocations).toContainEqual([
          "rm",
          "--force",
          "--volumes",
          INSTANCE_NAME,
        ]);
      });

      it("quarantines when it cannot prove it cleaned up after a Refusal", async () => {
        // The Refusal is the error the caller gets, so residue on this path has
        // no exception of its own to travel in - which is exactly why it has to
        // stick. Otherwise a `create` that succeeded, an Attestation that
        // refused and an `rm` that then failed leave an instance nobody hears
        // about.
        const { provider, setInstance, setSurvivors } = arrange(
          dialect,
          infoStdout
        );
        setInstance({ privileged: true });
        setSurvivors({ instances: [INSTANCE_NAME] });
        await refusalFrom(provider.launch(REQUEST));

        await expect(
          refusalFrom(provider.launch(REQUEST))
        ).resolves.toStrictEqual(["local-capability-not-quarantined"]);
      });

      it("keeps the Refusal, and quarantines, when the cleanup fails too", async () => {
        // Two things have to survive one path: the caller still has to be told
        // which requirement failed, and the host still has to be marked. A
        // cleanup error thrown over the Refusal would lose the first, and a
        // cleanup error that skipped the quarantine would lose the second.
        const { provider, runtime, setInstance, another } = arrange(
          dialect,
          infoStdout
        );
        setInstance({ privileged: true });
        runtime.reject("rm");

        await expect(
          refusalFrom(provider.launch(REQUEST))
        ).resolves.toStrictEqual(["not-privileged"]);
        await expect(
          refusalFrom(another().launch(REQUEST))
        ).resolves.toStrictEqual(["local-capability-not-quarantined"]);
      });

      it("keeps environment values out of the error it raises", async () => {
        // An invocation that failed prints its argument vector, and the vector
        // holds every `--env NAME=value` the request asked for. The name is
        // what makes the message useful; the value is what makes it a leak.
        const { provider, runtime } = arrange(dialect, infoStdout);
        runtime.refuse("create");
        const message = await messageFrom(
          provider.launch({
            ...REQUEST,
            environment: [{ name: "NPM_CONFIG_REGISTRY", value: "s3cr3t" }],
          })
        );

        expect(message).toContain("NPM_CONFIG_REGISTRY=<redacted>");
        expect(message).not.toContain("s3cr3t");
        // Redacted where it is printed, not where it is sent: the instance
        // still gets the value it asked for.
        expect(runtime.everyArgument()).toContain("NPM_CONFIG_REGISTRY=s3cr3t");
      });

      it.each(["create", "inspect", "start"])(
        "releases the Workspace volume when the runtime rejects the %s",
        async (rejected) => {
          // A launch that owns resources owns them however it leaves. Measured
          // against Docker 29.1.3: an image the runtime refuses leaves the
          // volume behind, and a volume outlives the process that made it.
          const { provider, runtime } = arrange(dialect, infoStdout);
          runtime.refuse(rejected);

          await expect(provider.launch(REQUEST)).rejects.toThrow(Error);
          expect(runtime.invocations).toContainEqual([
            "volume",
            "rm",
            WORKSPACE_VOLUME,
          ]);
        }
      );

      it.each([
        {
          why: "seccomp was turned off underneath it",
          drift: {
            securityOpt: ["no-new-privileges", "seccomp=unconfined"],
          },
          requirement: "seccomp-enabled",
        },
        {
          why: "it joined the host's network",
          drift: { networkMode: "host" },
          requirement: "own-network-namespace",
        },
        {
          why: "it joined the host's PID namespace",
          drift: { pidMode: "host" },
          requirement: "own-pid-namespace",
        },
        {
          why: "its process limit went missing",
          drift: { pidsLimit: 0 },
          requirement: "process-limit",
        },
        {
          why: "its Workspace is somebody else's volume",
          drift: { workspaceVolume: "not-ours" },
          requirement: "ephemeral-workspace",
        },
      ])("refuses because $why", async ({ drift, requirement }) => {
        const { provider, runtime, setInstance } = arrange(dialect, infoStdout);
        setInstance(drift);

        await expect(refusalFrom(provider.launch(REQUEST))).resolves.toContain(
          requirement
        );
        expect(runtime.countOf("start")).toBe(0);
      });
    });

    describe("the cached capability and the fresh Attestation", () => {
      it("establishes a capability once and attests every instance", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const first = await provider.launch(REQUEST);
        await first.teardown();
        await provider.launch(REQUEST);

        // The acceptance criterion, as arithmetic. The host is re-read on every
        // launch because a stale fingerprint is a refusal rather than an
        // assumption - but it is only *reduced to a capability* once, and every
        // instance is inspected and attested on its own.
        expect(runtime.countOf("info")).toBe(2);
        expect(runtime.countOf("inspect")).toBe(2);
        const established = await provider.capability();

        // The clock moves on every reading, so this is the *first* one: a
        // capability re-established on the second launch would carry a later
        // timestamp, and against a constant clock it could not.
        expect(established.establishedAt).toBe(CLOCK_START + CLOCK_TICK);
      });

      it("refuses the instance that would have used a host that drifted", async () => {
        const { provider, runtime, setHost } = arrange(dialect, infoStdout);
        await provider.launch(REQUEST);
        setHost({ kernelVersion: "6.13.0" });

        await expect(
          refusalFrom(provider.launch(REQUEST))
        ).resolves.toStrictEqual(["host-fingerprint-unchanged"]);
        expect(runtime.countOf("create")).toBe(1);
      });

      it("re-establishes the capability honestly after drift evicted it", async () => {
        const { provider, setHost } = arrange(dialect, infoStdout);
        await provider.launch(REQUEST);
        setHost({ kernelVersion: "6.13.0" });
        await refusalFrom(provider.launch(REQUEST));

        // Drift evicts rather than quarantines: the host changed, so measure it
        // again. The launch after the refusal is allowed to succeed.
        const third = await provider.launch(REQUEST);

        expect(third.attestation.authorized).toBeTruthy();
      });
    });

    describe("teardown", () => {
      it("destroys the instance and its Workspace, and says so", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        const receipt = await sandbox.teardown();

        expect(receipt.residue).toStrictEqual([]);
        expect(runtime.invocations).toContainEqual([
          "volume",
          "rm",
          WORKSPACE_VOLUME,
        ]);
      });

      it("re-lists rather than trusting the exit code of the removal", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        await sandbox.teardown();

        expect(runtime.countOf("ps")).toBe(1);
        expect(
          runtime.invocations.filter(
            (argv) => argv[0] === "volume" && argv[1] === "ls"
          )
        ).toHaveLength(1);
      });

      it("quarantines the local capability when residue survives", async () => {
        const { provider, setSurvivors } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        setSurvivors({ volumes: [WORKSPACE_VOLUME] });

        await expect(sandbox.teardown()).rejects.toThrow(SandboxTeardownError);
        // Sticky, and it refuses the next Sandbox on this runtime rather than
        // being logged and forgotten.
        await expect(
          refusalFrom(provider.launch(REQUEST))
        ).resolves.toStrictEqual(["local-capability-not-quarantined"]);
      });

      it("quarantines when the re-list itself refuses", async () => {
        // Not knowing whether anything survived is the same posture as knowing
        // it did. A teardown whose re-list exits non-zero has proven nothing,
        // and a provider that returned a clean receipt there would hand the
        // next Run a host that may still be holding the last Sandbox.
        const { provider, runtime, another } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        runtime.refuse("ps");

        await expect(sandbox.teardown()).rejects.toThrow(SandboxTeardownError);
        await expect(
          refusalFrom(another().launch(REQUEST))
        ).resolves.toStrictEqual(["local-capability-not-quarantined"]);
      });

      it("quarantines when the removal never reaches the runtime", async () => {
        // A rejection is not a non-zero exit: there is no answer at all, so
        // nothing was removed and nothing was re-listed.
        const { provider, runtime, another } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        runtime.reject("rm");

        await expect(sandbox.teardown()).rejects.toThrow(SandboxTeardownError);
        await expect(
          refusalFrom(another().launch(REQUEST))
        ).resolves.toStrictEqual(["local-capability-not-quarantined"]);
      });

      it("names everything it could not account for when it could not ask", async () => {
        const { provider, runtime, setInstance } = arrange(dialect, infoStdout);
        setInstance({ networkMode: NETWORK_NAME });
        const sandbox = await provider.launch({
          ...REQUEST,
          egress: { kind: "proxy", endpoint: "http://proxy.reprove.internal" },
        });
        runtime.reject("rm");

        await expect(sandbox.teardown()).rejects.toMatchObject({
          reason: "sandbox_teardown_incomplete",
          residue: [
            { kind: "instance", id: INSTANCE_NAME },
            { kind: "workspace", id: WORKSPACE_VOLUME },
            { kind: "network", id: NETWORK_NAME },
          ],
        });
      });

      it("names what survived on the Failure it raises", async () => {
        const { provider, setSurvivors } = arrange(dialect, infoStdout);
        const sandbox = await provider.launch(REQUEST);
        setSurvivors({ instances: [INSTANCE_NAME] });

        await expect(sandbox.teardown()).rejects.toMatchObject({
          reason: "sandbox_teardown_incomplete",
          residue: [{ kind: "instance", id: INSTANCE_NAME }],
        });
      });
    });

    describe("egress", () => {
      it("puts a Sandbox that may not reach out on no network at all", async () => {
        const { provider, runtime } = arrange(dialect, infoStdout);
        await provider.launch(REQUEST);

        expect(runtime.countOf("network")).toBe(0);
        expect(runtime.everyArgument()).toContain("none");
      });

      it("gives a proxied Sandbox an internal network of its own", async () => {
        const { provider, runtime, setInstance } = arrange(dialect, infoStdout);
        setInstance({ networkMode: NETWORK_NAME });
        const sandbox = await provider.launch({
          ...REQUEST,
          egress: { kind: "proxy", endpoint: "http://proxy.reprove.internal" },
        });

        expect(runtime.invocations).toContainEqual([
          "network",
          "create",
          "--internal",
          "--label",
          SANDBOX_LABEL,
          NETWORK_NAME,
        ]);
        await sandbox.teardown();
        expect(runtime.invocations).toContainEqual([
          "network",
          "rm",
          NETWORK_NAME,
        ]);
      });
    });
  }
);

describe("two providers on one host", () => {
  it("share a quarantine when neither was given a cache of its own", async () => {
    // A quarantine is a fact about the *host*. A Worker that builds a provider
    // per Run would otherwise throw it away with the provider that raised it,
    // which is the whole of what the quarantine was for. Deliberately built
    // without a `cache`, unlike every other case in this file.
    let survivors: Survivors = { instances: [], volumes: [], networks: [] };
    const runtime = createRecordingRuntime("podman", {
      info: () => ({ exitCode: 0, stdout: podmanInfoStdout(), stderr: "" }),
      inspect: () => ({
        exitCode: 0,
        stdout: inspectStdout({ workspaceVolume: WORKSPACE_VOLUME }),
        stderr: "",
      }),
      survivors: () => survivors,
    });
    const options = { runtime, clock: () => 1, newId: () => ID };
    const first = await createPodmanProvider(options).launch(REQUEST);
    survivors = { ...survivors, volumes: [WORKSPACE_VOLUME] };
    await expect(first.teardown()).rejects.toThrow(SandboxTeardownError);

    await expect(
      refusalFrom(createPodmanProvider(options).launch(REQUEST))
    ).resolves.toStrictEqual(["local-capability-not-quarantined"]);
  });
});

describe("a provider whose dialect does not match its runtime", () => {
  it("refuses to exist rather than driving the wrong executable", () => {
    const runtime = createRecordingRuntime("docker", {
      info: () => ({ exitCode: 0, stdout: dockerInfoStdout(), stderr: "" }),
      inspect: () => ({ exitCode: 0, stdout: inspectStdout(), stderr: "" }),
    });

    expect(() =>
      createSandboxProvider({ runtime, dialect: PODMAN_DIALECT })
    ).toThrow(TypeError);
  });
});
