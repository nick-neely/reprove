/**
 * The doubles one Run is taken through the Worker boundary with, and the fixed
 * Run itself.
 *
 * **Unshipped, and structurally so.** `tsconfig.build.json` keeps
 * `*.test-support.ts` out of `dist` and `tools/verify-workspace.mjs` matches the
 * same pattern from the other direction, so nothing here reaches a published
 * artifact and nothing in `@reprove/worker` or `@reprove/worker-hosted` can
 * reach it. That matters more than usual for this file: an Adapter double that
 * shipped would be a Harness that answers without a Harness, sitting inside the
 * package that decides whether execution is authorized.
 *
 * The doubles are deliberately shallow. They answer from a script and record
 * what they were asked, because what is under test is Worker core's ordering
 * and its decisions - not a Harness, and not a container runtime.
 */
import type { RunSpec } from "@reprove/protocol/v1";
import { SandboxTeardownError } from "@reprove/sandbox-container";
import type {
  HostCapability,
  Isolation,
  Residue,
  Sandbox,
  SandboxProvider,
  SandboxRequest,
} from "@reprove/sandbox-container";

import type {
  ConformanceComplaint,
  Adapter,
  AdapterPassOutput,
  PassRequest,
  ResolvedCapability,
} from "./adapter.js";

/** The instant every case is measured at, so a probe age is a fixed number. */
export const NOW = Date.parse("2026-09-06T00:01:00.000Z");

/** A Run at fixed SHAs, with every field the wire schema requires. */
export const RUN_SPEC: RunSpec = {
  runId: "run_01JQ7Z0000000000000000",
  ownerId: "owner_1",
  repositoryId: "repository_1",
  installationId: "installation_1",
  pullRequestNumber: 128,
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  provenance: "internal",
  provenanceBasis: {
    ruleVersion: 1,
    baseRepositoryId: 4242,
    headRepositoryId: 4242,
    authorAssociation: "MEMBER",
    authorId: 99,
    matchedSameRepository: true,
    matchedAssociation: true,
  },
  trigger: "automatic",
  placement: "hosted",
  allowHostedFallback: false,
  harness: "codex",
  model: "gpt-5.5-codex",
  strategy: "standard",
  autonomy: "verify",
  resolvedConfig: {
    schemaVersion: 1,
    review: {
      enabled: true,
      strategy: "standard",
      event: "COMMENT",
      threshold: { severity: "medium", verification: "any" },
      ignore: [],
      baseConventions: true,
      harnessOptions: {},
      overrides: [],
    },
    security: {
      maxExposure: "account",
      allowExternalProvenance: false,
      installScripts: "deny",
      allowHostedFallback: false,
      egress: [],
    },
  },
  configDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb924",
  claimableUntil: "2026-09-06T00:05:00.000Z",
  createdAt: "2026-09-06T00:00:00.000Z",
};

/** A capability that holds every gate, which each case breaks in one way. */
export const RESOLVED_CAPABILITY: ResolvedCapability = {
  // ADR 0005: Codex throws on any permission mode other than allow-all, so
  // `inspect` is genuinely unavailable on it rather than merely unimplemented.
  supportedAutonomy: ["verify"],
  canEnforceRepoInstructionBoundary: true,
  // Codex does not report the model it resolved to; Claude Code and OpenCode
  // do, through `stream-start.modelId`.
  reportsResolvedModel: false,
  probeFingerprint: "codex-0.150.0/brokered/adapter-1/suppression-1",
  probedAt: NOW - 1000,
};

/** A clean Pass: two Findings, one of them verified against an observed run. */
export const CLEAN_PASS: AdapterPassOutput = {
  outcome: "completed",
  stoppedBy: null,
  summary: "Reviewed 4 changed files. Two Findings, one verified by execution.",
  disprovedHypothesisCount: 2,
  findings: [
    {
      title: "Pooled session state outlives the client that set it",
      body: "`SET app.owner` persists past the transaction on a pooled connection.",
      severity: "high",
      verification: "verified",
      location: { path: "src/db/pool.ts", startLine: 42, endLine: 44 },
      anchoredText: "await client.query('SET app.owner = ' + ownerId);",
      evidence: [
        {
          command: "pnpm vitest run src/db/pool.test.ts",
          exitCode: 1,
          durationMs: 4200,
          output: "FAIL  src/db/pool.test.ts > leaks owner across clients",
        },
      ],
    },
    {
      title: "The retry loop has no ceiling",
      body: "A transient failure retries until the process is killed.",
      severity: "medium",
      verification: "static",
      location: { path: "src/queue/retry.ts", startLine: 17, endLine: 23 },
      anchoredText: "while (true) { await attempt(); }",
      evidence: [],
    },
  ],
  observed: [
    { command: "pnpm vitest run src/db/pool.test.ts", exitCode: 1 },
    { command: "rg --files src/db", exitCode: 0 },
  ],
  usage: { inputTokens: 41_000, outputTokens: 2100 },
  resolvedModel: null,
  repairTurnUsed: false,
  failureReason: null,
};

/** How the Adapter double answers. Every field is an opt-in deviation. */
export interface CodexScript {
  readonly harness?: Adapter["harness"];
  readonly capability?: Partial<ResolvedCapability>;
  readonly capabilityThrows?: Error;
  readonly output?: AdapterPassOutput;
  /**
   * What the one bounded repair turn yields when Worker core complains. Absent
   * means the Adapter has no repair to offer, which is the Pass-failure half of
   * ADR 0005's rule.
   */
  readonly repaired?: AdapterPassOutput;
  /**
   * A bundle the Adapter resolves with without ever asking `check`, which is
   * what an Adapter with no repair mechanism does. It is the only way to hand
   * Worker core a bundle its own conformance step is the first thing to touch.
   */
  readonly unchecked?: AdapterPassOutput;
  readonly throws?: Error;
}

export interface CodexAdapterDouble extends Adapter {
  /** Every Pass request, so what was handed across the seam is assertable. */
  readonly requests: readonly PassRequest[];
  /** Every complaint Worker core made through the conformance callback. */
  readonly complaints: readonly ConformanceComplaint[];
}

/**
 * A Codex Adapter that answers from a script.
 *
 * It models the one behaviour a real Adapter owns that Worker core depends on:
 * the bounded repair turn. Worker core decides conformance and the Adapter
 * decides what to do about a complaint, so the double asks `check`, and offers
 * its repaired bundle only where the script gave it one.
 */
export const createCodexAdapterDouble = (
  script: CodexScript = {}
): CodexAdapterDouble => {
  const requests: PassRequest[] = [];
  const complaints: ConformanceComplaint[] = [];

  return {
    harness: script.harness ?? "codex",
    requests,
    complaints,
    capability: () => {
      if (script.capabilityThrows) {
        return Promise.reject(script.capabilityThrows);
      }
      return Promise.resolve({ ...RESOLVED_CAPABILITY, ...script.capability });
    },
    pass: (request) => {
      requests.push(request);
      if (script.throws) {
        return Promise.reject(script.throws);
      }
      if (script.unchecked !== undefined) {
        return Promise.resolve(script.unchecked);
      }
      const output = script.output ?? CLEAN_PASS;
      const complaint = request.check(output);
      if (complaint === null) {
        return Promise.resolve(output);
      }
      complaints.push(complaint);
      return Promise.resolve(
        script.repaired === undefined
          ? output
          : { ...script.repaired, repairTurnUsed: true }
      );
    },
  };
};

/** How the Sandbox provider double answers. */
export interface SandboxScript {
  readonly instanceIsolation?: Isolation;
  readonly isolation?: Isolation;
  /** A provider that refuses rather than returning a Sandbox. */
  readonly refuses?: Error;
  readonly capabilityThrows?: Error;
  /** What a teardown could not account for, which is never a receipt. */
  readonly residue?: readonly Residue[];
}

export interface SandboxProviderDouble extends SandboxProvider {
  readonly launched: readonly SandboxRequest[];
  readonly teardowns: () => number;
}

const CAPABILITY: HostCapability = {
  runtime: "docker",
  fingerprint: "docker/29.1.3/6.12.93/rootful",
  isolation: "container-rootless",
  outcomes: [],
  establishedAt: 0,
};

export const createSandboxProviderDouble = (
  script: SandboxScript = {}
): SandboxProviderDouble => {
  const launched: SandboxRequest[] = [];
  let teardowns = 0;

  return {
    runtime: "docker",
    launched,
    teardowns: () => teardowns,
    capability: () => {
      if (script.capabilityThrows) {
        return Promise.reject(script.capabilityThrows);
      }
      return Promise.resolve({
        ...CAPABILITY,
        isolation: script.isolation ?? CAPABILITY.isolation,
      });
    },
    launch: (request) => {
      launched.push(request);
      if (script.refuses) {
        return Promise.reject(script.refuses);
      }
      const isolation =
        script.instanceIsolation ?? script.isolation ?? CAPABILITY.isolation;
      const sandbox: Sandbox = {
        id: "reprove-sbx-double",
        isolation,
        attestation: { authorized: true, isolation, outcomes: [] },
        workspace: {
          id: "reprove-ws-double",
          path: request.workspace.path,
          ephemeral: true,
        },
        exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        teardown: () => {
          teardowns += 1;
          if (script.residue !== undefined) {
            return Promise.reject(new SandboxTeardownError(script.residue));
          }
          return Promise.resolve({ residue: [] });
        },
      };
      return Promise.resolve(sandbox);
    },
  };
};
