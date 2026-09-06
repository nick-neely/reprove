/**
 * Author-controlled narrative, bounded and encoded before anything can read it.
 *
 * [ADR 0012](../../../docs/adr/0012-author-controlled-narrative-input.md) makes
 * the pull request title and description a **protected data file**, never
 * prompt interpolation: raw bytes reach neither the framework-level
 * `instructions` channel nor the initial prompt, and the path, filename,
 * arguments and environment carry no Author-controlled value. The only thing
 * that varies with what an Author wrote is the file's contents.
 *
 * Everything here is pure. Materializing the bytes inside the Sandbox under an
 * identity the Reviewer cannot replace is the caller's half of the contract, and
 * failing at it is a Refusal rather than a degraded Run.
 */
import { createHash } from "node:crypto";

/** The one path. Fixed, and deliberately not derived from anything. */
export const NARRATIVE_PATH = "/reprove/input/narrative.json" as const;

/**
 * ADR 0012's byte-level contract.
 *
 * GitHub publishes neither a maximum length nor Unicode-counting semantics for
 * either field, so Reprove owns the bound rather than inheriting undocumented
 * platform behaviour. `encodedBytes` is derived rather than chosen: the worst
 * JSON escape expands one input byte to six, so the two content limits total
 * 399,360 encoded bytes and the remainder is headroom for the fixed schema and
 * the bounded metadata.
 */
export const NARRATIVE_LIMITS = {
  titleBytes: 1024,
  descriptionBytes: 64 * 1024,
  encodedBytes: 400 * 1024,
} as const;

/** The two surfaces Reprove supplies, in the order the file carries them. */
export type NarrativeSurface =
  | "pull_request.title"
  | "pull_request.description";

/**
 * One record, exactly as it is encoded.
 *
 * `authority` is a literal rather than a computed value: narrative may be
 * edited by an Author, a maintainer, a bot or a GitHub App, and ADR 0012 fixes
 * that actor identity does not change its treatment. There is no actor field to
 * omit, because the schema has none.
 */
export interface NarrativeRecord {
  readonly surface: NarrativeSurface;
  readonly authority: "none";
  /** Absent input, as distinct from deliberately empty input. */
  readonly present: boolean;
  readonly content: string;
  readonly originalUtf8Bytes: number;
  readonly truncated: boolean;
}

/** The narrative as GitHub reported it, before any bound is applied. */
export interface NarrativeInput {
  readonly title: string;
  /** `null` where GitHub reported no description at all. */
  readonly description: string | null;
}

/**
 * The exact bytes a Sandbox is asked to hold, and the digest over them.
 *
 * The digest is an internal integrity aid, retained in execution metadata. It
 * gains no protocol or persistence identity merely because it exists.
 */
export interface ProtectedFile {
  readonly path: typeof NARRATIVE_PATH;
  readonly bytes: string;
  readonly digest: string;
}

/**
 * The one way encoding fails.
 *
 * A missing title violates GitHub's own required input, so there is nothing
 * truthful to encode and nothing to degrade to. Truncation is not here:
 * narrative is optional review context and the truncation is explicit in the
 * data.
 */
export type NarrativeRefusal = "narrative_title_missing";

export type NarrativeOutcome =
  | { readonly file: ProtectedFile; readonly refusal: null }
  | { readonly file: null; readonly refusal: NarrativeRefusal };

/**
 * A UTF-8 continuation byte, which is never the start of a code point.
 *
 * Recognised by range rather than by masking the top two bits, which is the
 * same set stated without a bitwise operator: every byte from `0x80` to `0xBF`
 * continues a sequence, and every other byte begins one or stands alone.
 */
const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 0x80 && byte <= 0xbf;

/** One field's content, once the bound has been applied to it. */
interface BoundedContent {
  readonly content: string;
  readonly originalUtf8Bytes: number;
  readonly truncated: boolean;
}

/**
 * The content, bounded to a byte count, cut only where a code point ends.
 *
 * A naive byte slice would emit a replacement character, which is content the
 * Author never wrote - so the cut walks back over continuation bytes until it
 * lands on a boundary. No marker is appended for the same reason:
 * `originalUtf8Bytes` and `truncated` carry the fact instead of mutating the
 * value they describe.
 */
const bound = (content: string, maximumBytes: number): BoundedContent => {
  const buffer = Buffer.from(content, "utf-8");
  if (buffer.byteLength <= maximumBytes) {
    return {
      content,
      originalUtf8Bytes: buffer.byteLength,
      truncated: false,
    };
  }

  let end = maximumBytes;
  while (end > 0 && isContinuation(buffer[end])) {
    end -= 1;
  }

  return {
    content: buffer.subarray(0, end).toString("utf-8"),
    originalUtf8Bytes: buffer.byteLength,
    truncated: true,
  };
};

const record = (
  surface: NarrativeSurface,
  value: string | null,
  maximumBytes: number
): NarrativeRecord => {
  if (value === null) {
    return {
      surface,
      authority: "none",
      present: false,
      content: "",
      originalUtf8Bytes: 0,
      truncated: false,
    };
  }
  return {
    surface,
    authority: "none",
    present: true,
    ...bound(value, maximumBytes),
  };
};

/**
 * Bounds, validates and encodes the narrative into the closed file contract.
 *
 * @param input The title and description as GitHub reported them.
 * @returns The exact bytes to materialize, or the Refusal that replaced them.
 */
export const encodeNarrative = (input: NarrativeInput): NarrativeOutcome => {
  if (input.title === "") {
    return { file: null, refusal: "narrative_title_missing" };
  }

  const bytes = JSON.stringify({
    schemaVersion: 1,
    records: [
      record("pull_request.title", input.title, NARRATIVE_LIMITS.titleBytes),
      record(
        "pull_request.description",
        input.description,
        NARRATIVE_LIMITS.descriptionBytes
      ),
    ],
  });

  return {
    file: {
      path: NARRATIVE_PATH,
      bytes,
      digest: createHash("sha256").update(bytes, "utf-8").digest("hex"),
    },
    refusal: null,
  };
};
