/**
 * The bound on Author-controlled narrative, and the shape it is allowed to
 * arrive in.
 *
 * ADR 0012 makes this a data file rather than prompt text, so the properties
 * under test are byte-level: what the bound is, where it cuts, what it records
 * about the cut, and that the encoded file never grows past the limit derived
 * from the two content limits.
 */
import { describe, expect, it } from "vitest";

import {
  encodeNarrative,
  NARRATIVE_LIMITS,
  NARRATIVE_PATH,
} from "./narrative.js";

interface DecodedFile {
  schemaVersion: number;
  records: {
    surface: string;
    authority: string;
    present: boolean;
    content: string;
    originalUtf8Bytes: number;
    truncated: boolean;
  }[];
}

/** The encoded file, or a failure naming the case that produced no file. */
const fileOf = (outcome: ReturnType<typeof encodeNarrative>) => {
  if (outcome.file === null) {
    throw new Error(`no narrative file: ${outcome.refusal}`);
  }
  return outcome.file;
};

// SAFETY: the encoder is the only writer of these bytes and the shape it
// writes is the closed file contract this suite exists to hold it to.
const decode = (outcome: ReturnType<typeof encodeNarrative>): DecodedFile =>
  JSON.parse(fileOf(outcome).bytes) as DecodedFile;

describe("the narrative file", () => {
  it("carries both surfaces in a fixed order at literal authority none", () => {
    const encoded = encodeNarrative({
      title: "Fix the pooled connection leak",
      description: "Closes #12.",
    });

    expect(fileOf(encoded).path).toBe(NARRATIVE_PATH);
    expect(decode(encoded)).toStrictEqual({
      schemaVersion: 1,
      records: [
        {
          surface: "pull_request.title",
          authority: "none",
          present: true,
          content: "Fix the pooled connection leak",
          originalUtf8Bytes: 30,
          truncated: false,
        },
        {
          surface: "pull_request.description",
          authority: "none",
          present: true,
          content: "Closes #12.",
          originalUtf8Bytes: 11,
          truncated: false,
        },
      ],
    });
  });

  it("separates an absent description from a deliberately empty one", () => {
    const absent = encodeNarrative({ title: "t", description: null });
    const empty = encodeNarrative({ title: "t", description: "" });

    expect(decode(absent).records[1]).toStrictEqual({
      surface: "pull_request.description",
      authority: "none",
      present: false,
      content: "",
      originalUtf8Bytes: 0,
      truncated: false,
    });
    expect(decode(empty).records[1]?.present).toBeTruthy();
  });

  it("refuses a missing title rather than inventing a record", () => {
    // GitHub requires a title, so its absence is a broken assumption rather
    // than optional context, and ADR 0012 makes it a Refusal.
    const encoded = encodeNarrative({ title: "", description: "body" });

    expect(encoded.refusal).toBe("narrative_title_missing");
    expect(encoded.file).toBeNull();
  });

  it("truncates past the bound rather than passing the content through", () => {
    const title = "a".repeat(NARRATIVE_LIMITS.titleBytes + 100);
    const [record] = decode(
      encodeNarrative({ title, description: null })
    ).records;

    expect(record?.content).toHaveLength(NARRATIVE_LIMITS.titleBytes);
    expect(record?.originalUtf8Bytes).toBe(NARRATIVE_LIMITS.titleBytes + 100);
    expect(record?.truncated).toBeTruthy();
  });

  it("appends no truncation marker, because that would mutate the content", () => {
    const description = "b".repeat(NARRATIVE_LIMITS.descriptionBytes + 1);
    const [, record] = decode(
      encodeNarrative({ title: "t", description })
    ).records;

    expect(record?.content).toBe("b".repeat(NARRATIVE_LIMITS.descriptionBytes));
  });

  it("cuts at a code-point boundary rather than mid-character", () => {
    // Four bytes per emoji, so a limit that is not a multiple of four lands
    // inside one. A naive byte slice would emit a replacement character, which
    // is content the Author never wrote.
    const emoji = "\u{1F600}";
    const title = emoji.repeat(NARRATIVE_LIMITS.titleBytes);
    const [record] = decode(
      encodeNarrative({ title, description: null })
    ).records;

    expect(record?.content).toBe(
      emoji.repeat(Math.floor(NARRATIVE_LIMITS.titleBytes / 4))
    );
    expect(record?.content).not.toContain("\uFFFD");
  });

  it("keeps the encoded file inside the limit derived from the two bounds", () => {
    // The worst JSON escape expands one input byte to six encoded bytes, which
    // is what the 400 KiB derivation in ADR 0012 is a budget for. A serializer
    // that cannot satisfy it has broken the closed file contract.
    const worst = "\u0001";
    const encoded = encodeNarrative({
      title: worst.repeat(NARRATIVE_LIMITS.titleBytes),
      description: worst.repeat(NARRATIVE_LIMITS.descriptionBytes),
    });

    expect(
      Buffer.byteLength(fileOf(encoded).bytes, "utf-8")
    ).toBeLessThanOrEqual(NARRATIVE_LIMITS.encodedBytes);
  });

  it("digests the exact encoded bytes", () => {
    const encoded = encodeNarrative({ title: "t", description: "d" });

    expect(fileOf(encoded).digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      fileOf(encodeNarrative({ title: "t", description: "d" })).digest
    ).toBe(fileOf(encoded).digest);
    expect(
      fileOf(encodeNarrative({ title: "u", description: "d" })).digest
    ).not.toBe(fileOf(encoded).digest);
  });

  it("holds no Author-controlled value in the path", () => {
    expect(NARRATIVE_PATH).toBe("/reprove/input/narrative.json");
  });
});
