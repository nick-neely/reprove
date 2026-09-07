import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONDITIONS,
  CORPUS_DIRECTORY,
  CORPUS_REQUIREMENTS,
  corpusScenarios,
  loadCorpus,
} from "./corpus.mjs";
import { AXES } from "./scoring.mjs";

const scratch: string[] = [];

/** Discard every corpus copy the finished test made. */
const discardScratch = () => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** A private copy of the corpus that one test may corrupt. */
const copyOfCorpus = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "reprove-corpus-"));
  scratch.push(directory);
  cpSync(CORPUS_DIRECTORY, directory, { recursive: true });
  return directory;
};

describe("the committed corpus", () => {
  afterEach(discardScratch);

  const corpus = loadCorpus();

  it("has the shape #34 fixed", () => {
    expect(corpus.families).toHaveLength(CORPUS_REQUIREMENTS.families);
    expect(
      corpus.families.filter((family) => family.varies === "narrative")
    ).toHaveLength(CORPUS_REQUIREMENTS.narrativeVarying);
    expect(
      corpus.families.filter((family) => family.varies === "workspace")
    ).toHaveLength(CORPUS_REQUIREMENTS.workspaceVarying);
    expect(corpus.families.filter((family) => family.defective)).toHaveLength(
      CORPUS_REQUIREMENTS.defective
    );
    expect(corpus.families.filter((family) => !family.defective)).toHaveLength(
      CORPUS_REQUIREMENTS.defectFree
    );
    for (const axis of AXES) {
      expect(corpus.axisFamilies[axis]?.length).toBeGreaterThanOrEqual(
        CORPUS_REQUIREMENTS.minimumFamiliesPerAxis
      );
    }
  });

  it("gives every family the four paired conditions with one controlled input", () => {
    for (const family of corpus.families) {
      expect(family.conditions.map((condition) => condition.id)).toStrictEqual(
        CONDITIONS
      );
      for (const condition of family.conditions) {
        expect(condition.axes.length).toBeGreaterThan(0);
        expect(condition.narrative.title.length).toBeGreaterThan(0);
        expect(condition.files.size).toBeGreaterThan(0);
      }
    }
  });

  it("yields 48 cells for a batch", () => {
    expect(corpusScenarios(corpus)).toHaveLength(48);
  });

  it("derives a content version", () => {
    expect(corpus.version).toMatch(/^[0-9a-f]{16}$/u);
    expect(loadCorpus().version).toBe(corpus.version);
  });

  it("changes version when an expectation changes", () => {
    const directory = copyOfCorpus();
    const manifestPath = path.join(
      directory,
      "pagination-last-item",
      "family.json"
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.conditions.control.expect.otherFindings = "forbidden";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(loadCorpus(directory).version).not.toBe(corpus.version);
  });
});

describe("corpus validation", () => {
  afterEach(discardScratch);

  it("rejects a defect that moved between conditions", () => {
    const directory = copyOfCorpus();
    // Shift the defect in a Workspace-varying family by prepending a line to
    // the defective file inside the steering overlay.
    const overlay = path.join(
      directory,
      "float-currency",
      "conditions",
      "adversarial-steering",
      "src",
      "total.js"
    );
    writeFileSync(overlay, `// moved\n${readFileSync(overlay, "utf-8")}`);
    expect(() => loadCorpus(directory)).toThrow(/not fixed across the family/u);
  });

  it("rejects an expectation naming an unknown location", () => {
    const directory = copyOfCorpus();
    const manifestPath = path.join(directory, "retry-helper", "family.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.conditions.control.expect.forbiddenFindings.push("nowhere");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => loadCorpus(directory)).toThrow(/unknown location nowhere/u);
  });

  it("rejects an anchor that is not at its declared lines", () => {
    const directory = copyOfCorpus();
    const manifestPath = path.join(directory, "timing-compare", "family.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    manifest.locations[0].startLine = 3;
    manifest.locations[0].endLine = 3;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => loadCorpus(directory)).toThrow(/anchor is not at its lines/u);
  });

  it("rejects a corpus that lost a family", () => {
    const directory = copyOfCorpus();
    rmSync(path.join(directory, "rename-refactor"), { recursive: true });
    expect(() => loadCorpus(directory)).toThrow(/families is 11/u);
  });

  it("rejects a narrative family whose Workspace varies", () => {
    const directory = copyOfCorpus();
    const overlay = path.join(
      directory,
      "swallowed-error",
      "conditions",
      "control"
    );
    mkdirSync(overlay, { recursive: true });
    writeFileSync(path.join(overlay, "EXTRA.md"), "extra\n");
    expect(() => loadCorpus(directory)).toThrow(/holds its Workspace fixed/u);
  });
});
