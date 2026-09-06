/**
 * One trial through the real evaluation path.
 *
 * ```text
 * fixed RunSpec -> Worker core -> real Adapter -> real Sandbox
 *   -> instruction boundary -> narrative materialization
 *   -> real Harness and Model -> Result validation -> Evidence cross-check
 *   -> normalized Result -> evaluator
 * ```
 *
 * Everything from Worker core down is the revision's own code, loaded from
 * its build; this module only supplies what a Worker's composition root
 * would: the Sandbox provider, the fixture Workspace, the credential, and a
 * fresh instruction probe. GitHub ingress, persistence, Acceptance,
 * Reconciliation and publication are all absent, as #34 requires.
 *
 * The probe deserves a note. Capability evidence expires after five minutes
 * and a batch runs for hours, so the probe is re-taken on demand in a
 * separate disposable Sandbox whenever the cached measurement is too old.
 * Each probe spends a Provider turn; that is the price of never dispatching
 * on stale evidence, and it is the same price the Worker pays.
 */
import { createHash } from "node:crypto";

import { TrialFaultError } from "./evaluate.mjs";
import { PHASE0_LINEAGE } from "./report.mjs";

/** Re-probe before the Worker would call the evidence stale. */
const PROBE_REFRESH_MS = 4 * 60 * 1000;

/**
 * Runs as root inside the Sandbox and writes the fixture tree read-only.
 * Files arrive base64-encoded on stdin so no Workspace byte is an argument.
 */
const SEED_SCRIPT =
  "const fs=require('node:fs'),path=require('node:path');let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{const files=JSON.parse(Buffer.from(data,'base64').toString('utf8'));for(const [p,v] of Object.entries(files)){if(p.startsWith('/')||p.split('/').includes('..'))throw Error('bad path');const target=path.join('/reprove/workspace',p);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});fs.writeFileSync(target,v,{mode:0o444})}})";

/** @typedef {import("./batch.mjs").PlannedTrial} PlannedTrial */
/** @typedef {import("./corpus.mjs").Corpus} Corpus */
/** @typedef {import("./revision.mjs").LoadedRevision} LoadedRevision */

/**
 * Everything a runner needs to put one revision through the evaluation path.
 *
 * @typedef {object} TrialRunnerOptions
 * @property {LoadedRevision} loaded The revision under evaluation.
 * @property {import("./report.mjs").Revision} revision Its identity.
 * @property {import("@reprove/worker-core").SandboxProfile} profile Its built image.
 * @property {Corpus} corpus The corpus the trials are cells of.
 * @property {{ kind: "api-key", provider: "openai" | "gateway", key: string }} authentication The Provider credential.
 * @property {import("@reprove/sandbox-container").ContainerRuntime} runtime The container CLI to seed through.
 * @property {import("@reprove/sandbox-container").SandboxProvider} sandboxes Where Sandboxes come from.
 * @property {"low" | "medium" | "high" | "xhigh" | "max"} [reasoningEffort] The effort the cell runs at.
 * @property {number} [timeoutMs] The Pass budget.
 * @property {(request: Request) => Promise<Response>} [fetch] Substitutable only at the Provider HTTP boundary.
 * @property {() => number} [clock] The clock, for tests that need a fixed one.
 * @property {(line: string) => void} [log] Progress lines, if wanted.
 */

/**
 * Write a fixture Workspace into an attested Sandbox as root, read-only.
 *
 * @param {import("@reprove/sandbox-container").ContainerRuntime} runtime The container CLI to seed through.
 * @param {{ id: string }} sandbox The attested Sandbox to write into.
 * @param {ReadonlyMap<string, string>} files The fixture tree, by relative path.
 * @returns {Promise<void>} Nothing; it throws when seeding did not exit clean.
 */
export const seedWorkspace = async (runtime, sandbox, files) => {
  const outcome = await runtime.invoke({
    arguments: [
      "exec",
      "--interactive",
      "--user",
      "0:0",
      "--",
      sandbox.id,
      "node",
      "-e",
      SEED_SCRIPT,
    ],
    stdin: Buffer.from(JSON.stringify(Object.fromEntries(files))).toString(
      "base64"
    ),
  });
  if (outcome.exitCode !== 0) {
    throw new TrialFaultError(
      "sandbox_provisioning_transient",
      `Workspace seeding exited ${outcome.exitCode}: ${outcome.stderr.slice(0, 200)}`
    );
  }
};

/**
 * The fixed RunSpec every trial runs under. Only the ids vary, and those are
 * derived from the trial so a transcript can be matched to its cell.
 *
 * @param {PlannedTrial} trial The cell being run, which the ids derive from.
 * @param {import("./report.mjs").Lineage} lineage The qualification cell.
 * @param {string} reasoningEffort The effort the cell runs at.
 * @param {string} createdAt When the Run claims to have been created.
 * @returns {object} The RunSpec Worker core executes.
 */
export const runSpecFor = (trial, lineage, reasoningEffort, createdAt) => {
  const digest = createHash("sha256").update(trial.id).digest("hex");
  const resolvedConfig = {
    schemaVersion: 1,
    review: {
      enabled: true,
      strategy: lineage.strategy,
      event: "COMMENT",
      threshold: { severity: "medium", verification: "any" },
      ignore: [],
      baseConventions: false,
      harnessOptions: { codex: { reasoningEffort } },
      overrides: [],
    },
    security: {
      maxExposure: "none",
      allowExternalProvenance: false,
      installScripts: "deny",
      allowHostedFallback: false,
      egress: [],
    },
  };
  return {
    runId: `gate_${digest.slice(0, 26)}`,
    ownerId: "gate_owner",
    repositoryId: "gate_repository",
    installationId: "gate_installation",
    pullRequestNumber: 1,
    baseSha: digest.slice(0, 40),
    headSha: digest.slice(24, 64),
    provenance: "internal",
    provenanceBasis: {
      ruleVersion: 1,
      baseRepositoryId: 1,
      headRepositoryId: 1,
      authorAssociation: "OWNER",
      authorId: 1,
      matchedSameRepository: true,
      matchedAssociation: true,
    },
    trigger: "manual",
    placement: "self_hosted",
    allowHostedFallback: false,
    harness: lineage.harness,
    model: lineage.model,
    strategy: lineage.strategy,
    autonomy: lineage.autonomy,
    resolvedConfig,
    configDigest: `sha256:${createHash("sha256").update(JSON.stringify(resolvedConfig)).digest("hex")}`,
    claimableUntil: createdAt,
    createdAt,
  };
};

/**
 * A runner for one revision. Returns `runTrial` as `runBatch` wants it.
 *
 * @param {TrialRunnerOptions} options What the runner runs against.
 * @returns {{ runTrial: (trial: PlannedTrial, signal: AbortSignal | undefined) => Promise<object>, freshProof: (signal: AbortSignal | undefined) => Promise<import("@reprove/adapters").InstructionProbe> }} The runner.
 */
export const createTrialRunner = (options) => {
  const {
    loaded,
    revision,
    profile,
    corpus,
    authentication,
    runtime,
    sandboxes,
    fetch,
    log,
  } = options;
  const clock = options.clock ?? Date.now;
  const reasoningEffort = options.reasoningEffort ?? "medium";
  const lineage = revision.lineage ?? PHASE0_LINEAGE;

  /** @type {{ proof: import("@reprove/adapters").InstructionProbe, at: number } | null} */
  let cached = null;
  /** @type {Promise<import("@reprove/adapters").InstructionProbe> | null} */
  let probing = null;

  const probe = async (signal) => {
    const sandbox = await sandboxes.launch(
      loaded.workerCore.sandboxRequestFor("codex", profile)
    );
    try {
      await seedWorkspace(
        runtime,
        sandbox,
        new Map(
          loaded.adapters.CODEX_PROBE_FILES.map((file) => [
            file.path,
            file.content,
          ])
        )
      );
      if (!sandbox.access?.streaming) {
        throw new TrialFaultError(
          "sandbox_provisioning_transient",
          "no protected I/O"
        );
      }
      await sandbox.access.protect(
        loaded.workerCore.NARRATIVE_PATH,
        new TextEncoder().encode('{"authority":"none","title":"probe"}')
      );
      log?.("probing instruction suppression");
      return await loaded.adapters.probeCodexInstructions({
        model: lineage.model,
        reasoningEffort,
        authentication,
        sandbox,
        signal,
        fetch,
      });
    } finally {
      await sandbox.teardown();
    }
  };

  /** Fresh-enough evidence, taken at most once at a time. */
  const freshProof = async (signal) => {
    if (cached !== null && clock() - cached.at < PROBE_REFRESH_MS) {
      return cached.proof;
    }
    if (probing === null) {
      probing = (async () => {
        try {
          return await probe(signal);
        } finally {
          probing = null;
        }
      })();
    }
    const proof = await probing;
    cached = { proof, at: proof.probedAt };
    return proof;
  };

  const adapter = loaded.adapters.createCodexAdapter({
    model: lineage.model,
    reasoningEffort,
    authentication,
    timeoutMs: options.timeoutMs,
    instructionProbe: freshProof,
    fetch,
  });

  /** @type {Map<string, ReadonlyMap<string, string>>} */
  const pending = new Map();

  const core = loaded.workerCore.createWorkerCore({
    adapter,
    sandboxes,
    profile,
    workerBuildVersion: revision.workerBuildVersion,
    clock,
    materialize: async (sandbox, file) => {
      const files = pending.get(sandbox.id) ?? pending.get("*");
      if (!files) {
        throw new Error("no fixture Workspace pending for this Sandbox");
      }
      await seedWorkspace(runtime, sandbox, files);
      await loaded.workerCore.materializeNarrative(sandbox, file);
    },
  });

  /**
   * Run one cell of the corpus through the whole evaluation path.
   *
   * @param {PlannedTrial} trial The cell to run.
   * @param {AbortSignal | undefined} signal Cancels the Pass, if given.
   * @returns {Promise<{ outcome: object, resolvedModel: string | null }>} What Worker core returned.
   */
  const runTrial = async (trial, signal) => {
    const family = corpus.families.find(
      (candidate) => candidate.id === trial.familyId
    );
    const condition = family?.conditions.find(
      (candidate) => candidate.id === trial.conditionId
    );
    if (!family || !condition) {
      throw new Error(`${trial.id} names a cell outside the corpus`);
    }
    // Worker core launches the Sandbox itself, so the fixture is parked under
    // a wildcard until the materialize port sees which instance came up. Trials
    // in one runner execute sequentially, which is what makes this safe.
    // Warm the evidence before Worker core asks for it: its capability
    // resolution has a 30-second deadline, and a probe launches a Sandbox and
    // spends a Provider turn, which does not fit. The Adapter then sees a
    // measurement younger than four minutes for the whole dispatch.
    await freshProof(signal ?? AbortSignal.timeout(180_000));
    pending.set("*", condition.files);
    try {
      const outcome = await core.execute({
        spec: runSpecFor(
          trial,
          lineage,
          reasoningEffort,
          new Date(clock()).toISOString()
        ),
        narrative: condition.narrative,
        conventions: [],
        exposure: "none",
        signal,
      });
      const resolvedModel =
        outcome.kind === "result"
          ? (outcome.result.passes[0]?.resolvedModel ?? null)
          : null;
      return { outcome, resolvedModel };
    } finally {
      pending.delete("*");
    }
  };

  return { runTrial, freshProof };
};
