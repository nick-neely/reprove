/**
 * The fixed evaluation budget, planned and executed.
 *
 * #34 fixes the budget at every condition six times per arm, forbids adaptive
 * rerunning, and requires candidate and baseline trials to be randomized and
 * interleaved within one batch in separate fresh Sandboxes. The plan is
 * therefore a shuffled list drawn from a seed the evaluation's identity
 * determines, so the same identity always yields the same interleaving, and
 * the runner walks that list once, allowing exactly the one retry #34 permits
 * and recording both attempts when it does.
 */
import { corpusCells } from "./corpus.mjs";
import { classifyTrial, RETRYABLE_FAULTS } from "./evaluate.mjs";
import { seededRandom, shuffle } from "./random.mjs";
import { SCORING_POLICY } from "./scoring.mjs";

/** @typedef {import("./scoring.mjs").Arm} Arm */
/** @typedef {import("./evaluate.mjs").Verdict} Verdict */

/**
 * One cell of the budget: an arm, a condition and which repetition it is.
 *
 * @typedef {object} PlannedTrial
 * @property {string} id The trial's identity, which a transcript is matched by.
 * @property {Arm} arm Which revision runs it.
 * @property {string} familyId The scenario family.
 * @property {string} conditionId Which of the four paired conditions.
 * @property {number} repetition Which of the six repetitions, from zero.
 * @property {readonly string[]} axes The axes this cell can speak to.
 */

/**
 * One execution of a trial, kept whether or not it was the last.
 *
 * @typedef {object} Attempt
 * @property {number} attempt Which attempt this was, from one.
 * @property {string} startedAt When it began.
 * @property {string} endedAt When it finished.
 * @property {Verdict} verdict What it amounted to.
 * @property {string | null} resolvedModel The Model the Provider actually served.
 */

/**
 * A finished trial, with every attempt #34 allowed it.
 *
 * @typedef {object} TrialRecord
 * @property {PlannedTrial} trial The cell that was run.
 * @property {readonly Attempt[]} attempts Every attempt, in order.
 * @property {Verdict} verdict The final attempt's verdict.
 */

/**
 * Plan one batch.
 *
 * @param {object} input What the batch covers.
 * @param {import("./corpus.mjs").Corpus} input.corpus The corpus to draw cells from.
 * @param {readonly Arm[]} input.arms `["candidate"]` for a first qualification.
 * @param {string} input.seed The evaluation identity.
 * @param {number} [input.repetitions] Defaults to the policy's six.
 * @returns {{ seed: string, repetitions: number, trials: PlannedTrial[] }} The seeded interleaving.
 */
export const planBatch = ({ corpus, arms, seed, repetitions }) => {
  const count = repetitions ?? SCORING_POLICY.repetitions;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("repetitions must be a positive integer");
  }
  /** @type {PlannedTrial[]} */
  const trials = [];
  for (const arm of arms) {
    for (const cell of corpusCells(corpus)) {
      for (let repetition = 0; repetition < count; repetition += 1) {
        trials.push({
          id: `${arm}/${cell.familyId}/${cell.conditionId}/${repetition}`,
          arm,
          familyId: cell.familyId,
          conditionId: cell.conditionId,
          repetition,
          axes: cell.axes,
        });
      }
    }
  }
  return {
    seed,
    repetitions: count,
    trials: shuffle(trials, seededRandom(`${seed} batch`)),
  };
};

/**
 * Walk the plan once.
 *
 * `runTrial` executes one trial and returns Worker core's outcome plus the
 * resolved-Model metadata; whatever it throws is classified rather than
 * propagated, because a batch that dies on its 200th trial has spent the
 * budget without recording it. The retry rule is the whole of #34's: one
 * more attempt, only for a retryable fault, both attempts kept.
 *
 * @param {object} input What to run and how.
 * @param {{ trials: readonly PlannedTrial[] }} input.plan The planned batch.
 * @param {import("./corpus.mjs").Corpus} input.corpus The corpus the trials are cells of.
 * @param {(trial: PlannedTrial, signal: AbortSignal | undefined) => Promise<{ outcome: Parameters<typeof classifyTrial>[0]["outcome"], resolvedModel: string | null }>} input.runTrial Executes one trial.
 * @param {(record: TrialRecord, index: number, total: number) => void} [input.onTrial] Progress, per finished trial.
 * @param {() => number} [input.clock] The clock, for tests that need a fixed one.
 * @param {AbortSignal} [input.signal] Stops the walk between attempts.
 * @returns {Promise<TrialRecord[]>} One record per planned trial, in plan order.
 */
export const runBatch = async ({
  plan,
  corpus,
  runTrial,
  onTrial,
  clock = Date.now,
  signal,
}) => {
  /** @type {TrialRecord[]} */
  const records = [];
  for (const [index, trial] of plan.trials.entries()) {
    const family = corpus.families.find(
      (candidate) => candidate.id === trial.familyId
    );
    const condition = family?.conditions.find(
      (candidate) => candidate.id === trial.conditionId
    );
    if (!family || !condition) {
      throw new Error(`${trial.id} names a cell outside the corpus`);
    }
    /** @type {Attempt[]} */
    const attempts = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      signal?.throwIfAborted();
      const startedAt = new Date(clock()).toISOString();
      /** @type {Awaited<ReturnType<typeof runTrial>> | null} */
      let ran = null;
      /** @type {Error | null} */
      let thrown = null;
      try {
        /*
         * Strictly one trial at a time. Both arms share one container runtime
         * and one Provider budget, and #34 requires each trial to run in its
         * own fresh Sandbox; overlapping them would have two Sandboxes and two
         * Provider turns contend, which is exactly what the interleaving is
         * designed to keep apart.
         */
        // oxlint-disable-next-line no-await-in-loop -- sequential by design; see above.
        ran = await runTrial(trial, signal);
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }
      const verdict = classifyTrial({
        outcome: ran?.outcome ?? null,
        thrown,
        locations: family.locations,
        expectation: condition.expect,
      });
      attempts.push({
        attempt,
        startedAt,
        endedAt: new Date(clock()).toISOString(),
        verdict,
        resolvedModel: ran?.resolvedModel ?? null,
      });
      if (
        verdict.status !== "invalid" ||
        !verdict.retryable ||
        !RETRYABLE_FAULTS.includes(verdict.fault)
      ) {
        break;
      }
    }
    const last = attempts.at(-1);
    if (!last) {
      throw new Error("a trial recorded no attempt");
    }
    const record = { trial, attempts, verdict: last.verdict };
    records.push(record);
    onTrial?.(record, index, plan.trials.length);
  }
  return records;
};

/**
 * Whether the batch can be scored at all.
 *
 * A contract failure anywhere produces no behavioral score, and a remaining
 * invalid trial makes the whole evaluation INVALID; both are reported with
 * the trials that caused them, because "INVALID" alone tells nobody what to
 * restore.
 *
 * @param {readonly TrialRecord[]} records Every finished trial.
 * @returns {{ status: "valid" } | { status: "INVALID" | "CONTRACT_FAIL", trials: string[] }} The verdict on the batch, with the trials that caused it.
 */
export const batchValidity = (records) => {
  const contract = records.filter(
    (record) => record.verdict.status === "contract_failed"
  );
  if (contract.length > 0) {
    return {
      status: "CONTRACT_FAIL",
      trials: contract.map((record) => record.trial.id),
    };
  }
  const invalid = records.filter(
    (record) => record.verdict.status === "invalid"
  );
  if (invalid.length > 0) {
    return {
      status: "INVALID",
      trials: invalid.map((record) => record.trial.id),
    };
  }
  return { status: "valid" };
};

/**
 * The scored view of a valid batch, as `scoreEvaluation` wants it.
 *
 * @param {readonly TrialRecord[]} records Every finished trial.
 * @returns {import("./scoring.mjs").ScoredTrial[]} Only the trials that were scored.
 */
export const scoredTrials = (records) =>
  records.flatMap((record) =>
    record.verdict.status === "scored"
      ? [
          {
            arm: record.trial.arm,
            familyId: record.trial.familyId,
            conditionId: record.trial.conditionId,
            repetition: record.trial.repetition,
            axes: record.trial.axes,
            passed: record.verdict.passed,
          },
        ]
      : []
  );
