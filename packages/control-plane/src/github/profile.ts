/**
 * Everything in a Run's immutable spec that GitHub does not supply.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * splits Run creation in two and names the second half:
 *
 * ```text
 * canonical GitHub state + Phase0RunProfile + creation timestamp
 *   -> complete immutable Run.spec
 * ```
 *
 * > These are **Phase 0 fixture values, not Reprove product defaults.** A
 * > webhook handler containing `harness = codex` inline would silently convert
 * > prototype wiring into product selection policy, and Phase 1's configuration
 * > work would inherit a default it never agreed to.
 *
 * So the profile is a parameter of `createControlPlane()` with **no default**:
 * the composition root passes {@link PHASE_0_RUN_PROFILE} explicitly, and a
 * deployment that wants different values passes different ones. The rejected
 * alternative is the one ADR 0013 describes - literals at the point of use -
 * and the reason it is rejected is not tidiness but that it makes the values
 * unfindable when Phase 1 comes to choose them for real.
 *
 * `resolvedConfig` is "a real bounded normalized fixed config, and its
 * canonical digest", parsed here through `@reprove/protocol`'s own
 * `resolvedConfigSchema` rather than asserted to be one, "so the prototype
 * exercises the true Run shape". `claimableFor` is the claimable-deadline
 * policy ADR 0013 puts in the spec and [#38](https://github.com/nick-neely/reprove/issues/38)
 * fixes the Phase 0 duration of; ADR 0016's `livenessFor` is deliberately absent
 * because it bounds execution rather than creation, and belongs to whichever
 * change builds the claim path.
 */
import { createHash } from "node:crypto";

import type { ResolvedConfig, RunSpec } from "@reprove/protocol/v1";
import { resolvedConfigSchema } from "@reprove/protocol/v1";

import type { JsonValue } from "./json.js";

/** ADR 0014's Phase 0 unclaimed window, which ADR 0016 restates as a fixture. */
export const PHASE_0_CLAIMABLE_FOR_MS = 5 * 60 * 1000;

/**
 * The half of a Run's spec no pull request can influence.
 *
 * Every field is named from `RunSpec` rather than respelled, so a value this
 * profile can hold is exactly a value the Worker protocol accepts. There is no
 * second vocabulary for a harness or an autonomy level to drift against.
 */
export interface Phase0RunProfile {
  readonly harness: RunSpec["harness"];
  readonly model: string;
  readonly strategy: RunSpec["strategy"];
  readonly autonomy: RunSpec["autonomy"];
  readonly placement: RunSpec["placement"];
  readonly allowHostedFallback: boolean;
  /** A real bounded normalized config, not a placeholder. */
  readonly resolvedConfig: ResolvedConfig;
  /** How long a created Run stays claimable. Written into the spec. */
  readonly claimableForMs: number;
}

/**
 * A plain object, identified by its prototype rather than by `typeof`, which
 * calls an array and a null one too.
 */
const isRecord = (
  value: JsonValue
): value is { readonly [key: string]: JsonValue } =>
  value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * The canonical serialization the digest is taken over.
 *
 * Keys are sorted at every depth, because `JSON.stringify` preserves insertion
 * order and two configurations that differ only in the order zod's `default()`
 * filled them in are the same configuration. A digest that disagreed with that
 * would make `configDigest` an identifier for a serialization rather than for a
 * config, which is the one thing it must not be. Array order is preserved, for
 * the same reason inverted: an `ignore` list in a different order is a
 * different list.
 */
const canonicalize = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, held]) => held !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, held]) => `${JSON.stringify(key)}:${canonicalize(held)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * The digest of one resolved configuration.
 *
 * @param resolvedConfig The bounded normalized config that governs a Run.
 * @returns `sha256:` followed by the hex digest of its canonical form.
 */
export const configDigest = (resolvedConfig: ResolvedConfig): string =>
  `sha256:${createHash("sha256").update(canonicalize(resolvedConfig), "utf-8").digest("hex")}`;

/**
 * Parses a profile's configuration, so a profile carrying something the Worker
 * protocol would reject fails at composition rather than at the Run insert.
 *
 * @param resolvedConfig The configuration to normalize.
 * @returns The parsed configuration, with every default filled in.
 * @throws {TypeError} Naming what the configuration broke.
 */
export const normalizeResolvedConfig = (
  resolvedConfig: JsonValue
): ResolvedConfig => {
  const parsed = resolvedConfigSchema.safeParse(resolvedConfig);
  if (!parsed.success) {
    throw new TypeError(
      `Phase0RunProfile.resolvedConfig is not a resolved configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`
    );
  }
  return parsed.data;
};

/**
 * The Phase 0 fixture, as one named value.
 *
 * It is exported so `apps/control-plane` can inject it by name instead of
 * writing these literals into route wiring, and it is **not** a default: nothing
 * reaches for it unless a caller passes it.
 */
export const PHASE_0_RUN_PROFILE: Phase0RunProfile = {
  harness: "codex",
  model: "gpt-5",
  strategy: "standard",
  autonomy: "verify",
  placement: "hosted",
  allowHostedFallback: false,
  resolvedConfig: normalizeResolvedConfig({
    schemaVersion: 1,
    review: {},
    security: {},
  }),
  claimableForMs: PHASE_0_CLAIMABLE_FOR_MS,
};
