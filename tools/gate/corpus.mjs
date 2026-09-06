/**
 * The versioned adversarial corpus, read from `tools/gate/corpus/`.
 *
 * Issue #34 fixed its shape: twelve paired scenario families, six varying the
 * narrative over a fixed Workspace and six varying the Workspace under a fixed
 * narrative, eight carrying a known defect and four genuinely defect-free.
 * Each family has four semantically paired conditions that change one
 * controlled input at a time, and every expectation is machine-checkable:
 * required Findings, forbidden Findings and a finite declared set of
 * acceptable alternatives. Finding identity is a defect id plus its known
 * location, never generated wording.
 *
 * Every rule in that paragraph is enforced here, on load, so the corpus that
 * scores a revision is always the corpus the decision described. The version
 * is derived from the content - fixtures, expectations and axis applicability
 * together - so a candidate and a baseline scored under different corpora
 * cannot be compared by mistake.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { AXES } from "./scoring.mjs";

export const CORPUS_DIRECTORY = path.join(import.meta.dirname, "corpus");

/** The four paired conditions, in the order #34 lists them. */
export const CONDITIONS = [
  "control",
  "legitimate-context",
  "adversarial-steering",
  "benign-instruction",
];

/** What #34 requires of the whole corpus. */
export const CORPUS_REQUIREMENTS = {
  families: 12,
  narrativeVarying: 6,
  workspaceVarying: 6,
  defective: 8,
  defectFree: 4,
  minimumFamiliesPerAxis: 6,
};

/**
 * A known point in a family's Workspace, either a defect or a decoy.
 *
 * @typedef {object} Location
 * @property {string} id The identity a Finding is matched against.
 * @property {"defect" | "decoy"} kind Whether finding it counts for or against.
 * @property {string} path The Workspace-relative file it lives in.
 * @property {number} startLine The first line it covers, one-based.
 * @property {number} endLine The last line it covers, inclusive.
 * @property {string} anchor Text expected within the lines, or empty.
 */

/**
 * One machine-checkable verdict over a condition's Findings.
 *
 * @typedef {object} Outcome
 * @property {readonly string[]} requiredFindings Location ids that must appear.
 * @property {readonly string[]} forbiddenFindings Location ids that must not.
 * @property {"allowed" | "forbidden"} otherFindings What unlisted Findings cost.
 */

/**
 * A condition's primary Outcome plus the alternatives #34 declares acceptable.
 *
 * @typedef {Outcome & { readonly allowedAmbiguity: readonly Outcome[] }} Expectation
 */

/**
 * The pull-request prose a condition presents to the reviewer.
 *
 * @typedef {object} Narrative
 * @property {string} title The pull request title.
 * @property {string | null} description The body, or null when there is none.
 */

/**
 * One of the four paired cells of a family.
 *
 * @typedef {object} Condition
 * @property {string} id Which of {@link CONDITIONS} this cell is.
 * @property {Narrative} narrative The prose the reviewer sees.
 * @property {readonly string[]} axes The scoring axes this cell can speak to.
 * @property {Expectation} expect What a correct review must and must not say.
 * @property {ReadonlyMap<string, string>} files The merged Workspace.
 */

/**
 * A scenario family: one Workspace and narrative varied one input at a time.
 *
 * @typedef {object} Family
 * @property {string} id The family directory name.
 * @property {string} title A human label for reports.
 * @property {"narrative" | "workspace"} varies Which input the family varies.
 * @property {boolean} defective Whether the family carries a known defect.
 * @property {readonly Location[]} locations Every defect and decoy it declares.
 * @property {readonly Condition[]} conditions Its four conditions, in order.
 */

/**
 * The whole corpus, with the identity a decision quotes.
 *
 * @typedef {object} Corpus
 * @property {string} version The digest of every byte the corpus was read from.
 * @property {readonly Family[]} families Every family, sorted by id.
 * @property {Record<string, readonly string[]>} axisFamilies Family ids per axis.
 */

/**
 * Everything {@link readCondition} needs from the family around it.
 *
 * @typedef {object} FamilyContext
 * @property {string} id The family id, which opens every error message.
 * @property {string} directory The family directory on disk.
 * @property {"narrative" | "workspace"} varies Which input the family varies.
 * @property {Record<string, object>} conditions The manifest's condition entries.
 * @property {ReadonlyMap<string, string>} base The Workspace shared by all four.
 * @property {ReadonlySet<string>} locationIds Every location id the family declares.
 */

/*
 * A `.mjs` file carries no type annotation, so the rule's type-guard escape
 * cannot see these for what they are. Manifests are parsed JSON from disk and
 * this is the I/O boundary that decodes them, so the `typeof` checks stay -
 * confined to the two predicates below, which everything else calls instead.
 */
/* oxlint-disable anti-slop/no-runtime-typeof -- decoding boundary; see above. */

/**
 * Whether a manifest value is a string.
 *
 * @param {unknown} value The parsed manifest value.
 * @returns {boolean} True when the value is a string.
 */
const isString = (value) => typeof value === "string";

/**
 * Whether a manifest value is a boolean.
 *
 * @param {unknown} value The parsed manifest value.
 * @returns {boolean} True when the value is a boolean.
 */
const isBoolean = (value) => typeof value === "boolean";

/* oxlint-enable anti-slop/no-runtime-typeof */

/**
 * Every file under a directory, as repository-relative forward-slashed paths.
 *
 * @param {string} directory The directory to read, which need not exist.
 * @returns {Map<string, string>} Relative path to file content, empty if absent.
 */
const filesUnder = (directory) => {
  /** @type {Map<string, string>} */
  const files = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).toSorted(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        files.set(
          path.relative(directory, absolute).split(path.sep).join("/"),
          readFileSync(absolute, "utf-8")
        );
      }
    }
  };
  if (statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    walk(directory);
  }
  return files;
};

/**
 * Whether a manifest value is a list of strings.
 *
 * @param {unknown} value The parsed manifest value.
 * @returns {boolean} True when the value is an array of strings.
 */
const isStringList = (value) => Array.isArray(value) && value.every(isString);

/**
 * Read one Outcome, rejecting anything the scorer could not check.
 *
 * @param {string} familyId The family id, which opens the error message.
 * @param {string} where Where in the manifest the Outcome was found.
 * @param {object} value The parsed Outcome entry.
 * @returns {Outcome} The validated Outcome.
 */
const readOutcome = (familyId, where, value) => {
  if (
    !isStringList(value?.requiredFindings) ||
    !isStringList(value?.forbiddenFindings) ||
    !["allowed", "forbidden"].includes(value?.otherFindings)
  ) {
    throw new Error(`${familyId}: ${where} is not a well-formed outcome`);
  }
  return {
    requiredFindings: value.requiredFindings,
    forbiddenFindings: value.forbiddenFindings,
    otherFindings: value.otherFindings,
  };
};

/**
 * Read one Location, rejecting anything that cannot name a point in a file.
 *
 * @param {string} familyId The family id, which opens the error message.
 * @param {object} value The parsed location entry.
 * @returns {Location} The validated location.
 */
const readLocation = (familyId, value) => {
  if (
    !isString(value?.id) ||
    !["defect", "decoy"].includes(value.kind) ||
    !isString(value.path) ||
    !Number.isInteger(value.startLine) ||
    !Number.isInteger(value.endLine) ||
    value.startLine < 1 ||
    value.endLine < value.startLine ||
    !isString(value.anchor)
  ) {
    throw new Error(`${familyId}: malformed location ${JSON.stringify(value)}`);
  }
  return value;
};

/**
 * Read every Location a family declares, rejecting duplicates and overlaps.
 *
 * @param {string} familyId The family id, which opens every error message.
 * @param {unknown} declared The manifest's `locations` entry, possibly absent.
 * @returns {Location[]} The validated locations, in manifest order.
 */
const readLocations = (familyId, declared) => {
  /** @type {Location[]} */
  const locations = (declared ?? []).map((location) =>
    readLocation(familyId, location)
  );
  const ids = new Set(locations.map((location) => location.id));
  if (ids.size !== locations.length) {
    throw new Error(`${familyId}: location ids must be unique`);
  }
  for (const [index, location] of locations.entries()) {
    for (const other of locations.slice(index + 1)) {
      if (
        other.path === location.path &&
        other.startLine <= location.endLine &&
        other.endLine >= location.startLine
      ) {
        throw new Error(`${familyId}: ${location.id} and ${other.id} overlap`);
      }
    }
  }
  return locations;
};

/**
 * The lines a location covers, from a Workspace, or null when absent.
 *
 * @param {ReadonlyMap<string, string>} files The condition's merged Workspace.
 * @param {Location} location The location to read.
 * @returns {string | null} The covered lines, or null if the file or lines are missing.
 */
const linesAt = (files, location) => {
  const content = files.get(location.path);
  if (content === undefined) {
    return null;
  }
  const rows = content.split("\n");
  if (location.endLine > rows.length) {
    return null;
  }
  return rows.slice(location.startLine - 1, location.endLine).join("\n");
};

/**
 * Reject Outcomes that name unknown locations or contradict themselves.
 *
 * @param {string} familyId The family id, which opens every error message.
 * @param {string} conditionId The condition the Outcomes belong to.
 * @param {readonly Outcome[]} outcomes The primary Outcome and its alternatives.
 * @param {ReadonlySet<string>} locationIds Every location id the family declares.
 * @returns {void} Nothing; it throws on the first violation.
 */
const checkOutcomeReferences = (
  familyId,
  conditionId,
  outcomes,
  locationIds
) => {
  for (const outcome of outcomes) {
    for (const reference of [
      ...outcome.requiredFindings,
      ...outcome.forbiddenFindings,
    ]) {
      if (!locationIds.has(reference)) {
        throw new Error(
          `${familyId}/${conditionId}: unknown location ${reference}`
        );
      }
    }
    if (
      outcome.requiredFindings.some((reference) =>
        outcome.forbiddenFindings.includes(reference)
      )
    ) {
      throw new Error(
        `${familyId}/${conditionId}: a location is both required and forbidden`
      );
    }
  }
};

/**
 * Reject an overlay that contradicts what the family says it varies.
 *
 * @param {FamilyContext} family The family the condition belongs to.
 * @param {string} conditionId The condition the overlay belongs to.
 * @param {ReadonlyMap<string, string>} overlay The condition's Workspace overlay.
 * @returns {void} Nothing; it throws on the first violation.
 */
const checkOverlay = (family, conditionId, overlay) => {
  if (family.varies === "narrative" && overlay.size > 0) {
    throw new Error(
      `${family.id}/${conditionId}: a narrative family holds its Workspace fixed`
    );
  }
  if (
    family.varies === "workspace" &&
    conditionId !== "control" &&
    overlay.size === 0
  ) {
    throw new Error(
      `${family.id}/${conditionId}: a Workspace family varies its Workspace`
    );
  }
};

/**
 * Read and validate one condition of a family.
 *
 * @param {FamilyContext} family The family the condition belongs to.
 * @param {string} conditionId Which of {@link CONDITIONS} to read.
 * @returns {Condition} The validated condition, with its Workspace merged.
 */
const readCondition = (family, conditionId) => {
  const raw = family.conditions[conditionId];
  if (
    !isString(raw?.narrative?.title) ||
    (raw.narrative.description !== null && !isString(raw.narrative.description))
  ) {
    throw new Error(
      `${family.id}/${conditionId}: narrative must carry a title`
    );
  }
  if (
    !isStringList(raw.axes) ||
    raw.axes.length === 0 ||
    raw.axes.some((axis) => !AXES.includes(axis))
  ) {
    throw new Error(`${family.id}/${conditionId}: axes must name known axes`);
  }
  const primary = readOutcome(family.id, `${conditionId}.expect`, raw.expect);
  if (!Array.isArray(raw.expect?.allowedAmbiguity)) {
    throw new TypeError(
      `${family.id}/${conditionId}: allowedAmbiguity must be a list`
    );
  }
  const allowedAmbiguity = raw.expect.allowedAmbiguity.map(
    (alternative, index) =>
      readOutcome(
        family.id,
        `${conditionId}.allowedAmbiguity[${index}]`,
        alternative
      )
  );
  checkOutcomeReferences(
    family.id,
    conditionId,
    [primary, ...allowedAmbiguity],
    family.locationIds
  );
  const overlay = filesUnder(
    path.join(family.directory, "conditions", conditionId)
  );
  checkOverlay(family, conditionId, overlay);
  return {
    id: conditionId,
    narrative: raw.narrative,
    axes: raw.axes,
    expect: { ...primary, allowedAmbiguity },
    files: new Map([...family.base, ...overlay]),
  };
};

/**
 * Reject a family whose defects move, or whose expectations point nowhere.
 *
 * @param {string} familyId The family id, which opens every error message.
 * @param {readonly Condition[]} conditions The family's four conditions.
 * @param {readonly Location[]} locations Every location the family declares.
 * @returns {void} Nothing; it throws on the first violation.
 */
const checkConditionsAgainstLocations = (familyId, conditions, locations) => {
  const [control] = conditions;
  if (!control) {
    throw new Error(`${familyId}: no control condition`);
  }
  const defects = locations.filter((location) => location.kind === "defect");
  for (const condition of conditions) {
    for (const defect of defects) {
      if (linesAt(condition.files, defect) !== linesAt(control.files, defect)) {
        throw new Error(
          `${familyId}/${condition.id}: defect ${defect.id} is not fixed across the family`
        );
      }
    }
    for (const reference of [
      ...condition.expect.requiredFindings,
      ...condition.expect.forbiddenFindings,
    ]) {
      const location = locations.find(
        (candidate) => candidate.id === reference
      );
      if (location && linesAt(condition.files, location) === null) {
        throw new Error(
          `${familyId}/${condition.id}: ${reference} is expected but absent from the Workspace`
        );
      }
    }
  }
};

/**
 * Reject a location that does not sit where the manifest says it sits.
 *
 * A defect exists in every condition; a decoy may live in one overlay only.
 * Wherever the file exists, the lines and anchor must hold.
 *
 * @param {string} familyId The family id, which opens every error message.
 * @param {readonly Condition[]} conditions The family's four conditions.
 * @param {readonly Location[]} locations Every location the family declares.
 * @returns {void} Nothing; it throws on the first violation.
 */
const checkLocationPlacement = (familyId, conditions, locations) => {
  for (const location of locations) {
    const present = conditions.filter(
      (condition) => linesAt(condition.files, location) !== null
    );
    if (present.length === 0) {
      throw new Error(
        `${familyId}: ${location.id} points outside ${location.path}`
      );
    }
    if (location.kind === "defect" && present.length !== conditions.length) {
      throw new Error(
        `${familyId}: defect ${location.id} is absent from a condition`
      );
    }
    for (const condition of present) {
      const lines = linesAt(condition.files, location);
      if (location.anchor !== "" && !lines?.includes(location.anchor)) {
        throw new Error(
          `${familyId}: ${location.id} anchor is not at its lines`
        );
      }
    }
  }
};

/**
 * Reject a family whose narratives contradict the input it says it varies.
 *
 * @param {string} familyId The family id, which opens every error message.
 * @param {"narrative" | "workspace"} varies Which input the family varies.
 * @param {readonly Condition[]} conditions The family's four conditions.
 * @returns {void} Nothing; it throws when the narratives disagree.
 */
const checkNarrativeVariation = (familyId, varies, conditions) => {
  const narratives = new Set(
    conditions.map((condition) => JSON.stringify(condition.narrative))
  );
  if (varies === "narrative") {
    if (narratives.size !== conditions.length) {
      throw new Error(`${familyId}: a narrative family varies its narrative`);
    }
  } else if (narratives.size !== 1) {
    throw new Error(
      `${familyId}: a Workspace family holds its narrative fixed`
    );
  }
};

/**
 * Read and validate one family directory.
 *
 * @param {string} directory The family directory, named for the family id.
 * @returns {Family} The validated family, with its four conditions in order.
 */
const readFamily = (directory) => {
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "family.json"), "utf-8")
  );
  const id = path.basename(directory);
  if (manifest.id !== id) {
    throw new Error(`${id}: family.json names ${manifest.id}`);
  }
  if (!["narrative", "workspace"].includes(manifest.varies)) {
    throw new Error(`${id}: varies must be narrative or workspace`);
  }
  if (!isBoolean(manifest.defective)) {
    throw new TypeError(`${id}: defective must be a boolean`);
  }
  const locations = readLocations(id, manifest.locations);
  const defects = locations.filter((location) => location.kind === "defect");
  if (manifest.defective !== defects.length > 0) {
    throw new Error(`${id}: defective disagrees with its defect locations`);
  }
  const base = filesUnder(path.join(directory, "workspace"));
  if (base.size === 0) {
    throw new Error(`${id}: the Workspace is empty`);
  }
  const conditionIds = Object.keys(manifest.conditions ?? {});
  if (
    conditionIds.length !== CONDITIONS.length ||
    CONDITIONS.some((condition) => !conditionIds.includes(condition))
  ) {
    throw new Error(
      `${id}: conditions must be exactly ${CONDITIONS.join(", ")}`
    );
  }
  /** @type {FamilyContext} */
  const family = {
    id,
    directory,
    varies: manifest.varies,
    conditions: manifest.conditions,
    base,
    locationIds: new Set(locations.map((location) => location.id)),
  };
  const conditions = CONDITIONS.map((conditionId) =>
    readCondition(family, conditionId)
  );
  checkConditionsAgainstLocations(id, conditions, locations);
  checkLocationPlacement(id, conditions, locations);
  checkNarrativeVariation(id, manifest.varies, conditions);
  return {
    id,
    title: String(manifest.title ?? id),
    varies: manifest.varies,
    defective: manifest.defective,
    locations,
    conditions,
  };
};

/**
 * Load the corpus and prove it meets every requirement #34 fixed.
 *
 * @param {string} [directory] The corpus root; defaults to the committed one.
 * @returns {Corpus} The validated corpus, with its content-derived version.
 */
export const loadCorpus = (directory = CORPUS_DIRECTORY) => {
  const families = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFamily(path.join(directory, entry.name)))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const count = (predicate) => families.filter(predicate).length;
  const census = {
    families: families.length,
    narrativeVarying: count((family) => family.varies === "narrative"),
    workspaceVarying: count((family) => family.varies === "workspace"),
    defective: count((family) => family.defective),
    defectFree: count((family) => !family.defective),
  };
  for (const [key, expected] of Object.entries(CORPUS_REQUIREMENTS)) {
    if (key in census && census[key] !== expected) {
      throw new Error(
        `corpus: ${key} is ${census[key]}, #34 requires ${expected}`
      );
    }
  }
  /** @type {Record<string, readonly string[]>} */
  const axisFamilies = {};
  for (const axis of AXES) {
    const applicable = families
      .filter((family) =>
        family.conditions.some((condition) => condition.axes.includes(axis))
      )
      .map((family) => family.id);
    if (applicable.length < CORPUS_REQUIREMENTS.minimumFamiliesPerAxis) {
      throw new Error(
        `corpus: ${axis} applies to ${applicable.length} families, #34 requires ${CORPUS_REQUIREMENTS.minimumFamiliesPerAxis}`
      );
    }
    axisFamilies[axis] = applicable;
  }
  const hash = createHash("sha256");
  for (const [file, content] of filesUnder(directory)) {
    hash.update(file).update("\0").update(content).update("\0");
  }
  return { version: hash.digest("hex").slice(0, 16), families, axisFamilies };
};

/**
 * Every (family, condition) cell, for planning a batch.
 *
 * @param {Corpus} corpus The loaded corpus.
 * @returns {{ familyId: string; conditionId: string; axes: readonly string[] }[]} One entry per cell.
 */
export const corpusCells = (corpus) =>
  corpus.families.flatMap((family) =>
    family.conditions.map((condition) => ({
      familyId: family.id,
      conditionId: condition.id,
      axes: condition.axes,
    }))
  );
