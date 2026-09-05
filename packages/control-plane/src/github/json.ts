/**
 * JSON at a boundary: the value type it arrives as, and the one parse every
 * reader of a GitHub response performs.
 *
 * Both halves exist because the same three-step shape - decode the bytes,
 * validate the result, say why not - was being written once per endpoint, and a
 * response reader that differs between two endpoints differs in what it accepts
 * as well as in how it reports. The [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * reason it matters is that both readers feed a Run's immutable spec: a field
 * that merely looked right at the property access that read it is a permanent
 * wrong answer, so the parse is the boundary rather than a convenience.
 *
 * The rejected alternative is a reader per endpoint holding its own `try` around
 * `JSON.parse`, which is what this replaced. It reads as harmless duplication
 * and is not: the two copies had already diverged on what they said about a body
 * that was not JSON at all.
 */
import type { z } from "zod";

/**
 * JSON, as a value rather than as `unknown`.
 *
 * A configuration is JSON before it is a `ResolvedConfig` - today from a
 * literal, and from `.reprove.yml` once
 * [#21](https://github.com/nick-neely/reprove/issues/21) reads one - so a parse
 * over one takes the shape it actually arrives in.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A parsed body, or the reason these bytes could not become one. */
export type ParsedBody<Value> =
  | { readonly kind: "parsed"; readonly value: Value }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Decodes one response body and validates it against a schema.
 *
 * @param body The raw response body.
 * @param schema The shape the caller requires of it.
 * @returns The parsed value, or why there is none.
 */
export const parseBody = <Schema extends z.ZodType>(
  body: string,
  schema: Schema
): ParsedBody<z.infer<Schema>> => {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `the response is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = schema.safeParse(json);
  return parsed.success
    ? { kind: "parsed", value: parsed.data }
    : {
        kind: "unreadable",
        reason: parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; "),
      };
};
