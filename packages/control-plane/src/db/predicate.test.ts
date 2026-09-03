/**
 * The predicate normal form, measured on its own.
 *
 * `checks.ts` compares a declared policy against a catalog one by reducing both
 * to this form, so every distinction the tenant boundary rests on has to survive
 * the reduction and every equivalence has to be produced by it. There is no
 * database here on purpose: these are facts about the reduction, and a Postgres
 * connection would only make them slower to observe.
 */
import { describe, expect, it } from "vitest";

import { normalizePredicate } from "./predicate.js";

/** The reduced token sequence, or the assertion fails naming the connective. */
const reduce = (expression: string, table = "run"): string => {
  const result = normalizePredicate(expression, table);
  if ("connective" in result) {
    throw new Error(`refused for the connective \`${result.connective}\``);
  }
  return result.normalized;
};

/** The connective that refused a predicate, or null if it was accepted. */
const refusedFor = (expression: string, table = "run"): string | null => {
  const result = normalizePredicate(expression, table);
  return "connective" in result ? result.connective : null;
};

/** What Drizzle renders, and what Postgres re-prints for the same policy. */
const DRIZZLE = `"run"."owner_id" = nullif(current_setting('app.owner_id', true), '')::bigint`;
const POSTGRES = `(owner_id = (NULLIF(current_setting('app.owner_id'::text, true), ''::text))::bigint)`;

describe("the predicate normal form", () => {
  it("reconciles what Drizzle renders with what Postgres re-prints", () => {
    // The whole reason the form exists. Neither side is edited to meet the
    // other: Postgres uppercases the function, adds `::text` to every literal,
    // drops the table qualifier it already knows, and re-parenthesises freely.
    expect(reduce(DRIZZLE)).toBe(reduce(POSTGRES));
  });

  describe("identifier folding", () => {
    it("folds an unquoted identifier to lower case, as Postgres does", () => {
      expect(reduce("OWNER_ID = Current_Setting")).toBe(
        reduce("owner_id = current_setting")
      );
    });

    it("leaves a quoted identifier alone, because case is part of the name", () => {
      // `"Owner_Id"` is a different column from `owner_id`, and a policy
      // comparing the wrong one is a tenant boundary over nothing.
      expect(reduce('"Owner_Id" = 1')).not.toBe(reduce("owner_id = 1"));
    });

    it("unquotes a quoted identifier that needed no quoting", () => {
      // Postgres prints `owner_id` where Drizzle prints `"owner_id"`, and the
      // two name the same column.
      expect(reduce('"owner_id" = 1')).toBe(reduce("owner_id = 1"));
    });

    it("drops only the qualifier naming this policy's own table", () => {
      expect(reduce('"run"."owner_id" = 1')).toBe(reduce("owner_id = 1"));
      expect(reduce('"other"."owner_id" = 1')).not.toBe(reduce("owner_id = 1"));
    });
  });

  describe("string literals", () => {
    it("keeps an empty string distinct from a space", () => {
      // `nullif(x, ' ')` is the ADR 0008 outage wearing a disguise: a pooler's
      // reset leaves the GUC as the empty string, not a space, so the guard
      // never fires and `''::bigint` raises from inside the policy.
      expect(reduce("nullif(x, '')")).not.toBe(reduce("nullif(x, ' ')"));
    });

    it("does not fold case inside a literal", () => {
      expect(reduce("x = 'ACME'")).not.toBe(reduce("x = 'acme'"));
    });

    it("does not read a parenthesis inside a literal as grouping", () => {
      expect(reduce("x = '()'")).toBe("x = '()'");
    });

    it("strips the ::text Postgres adds to a literal and Drizzle does not", () => {
      expect(reduce("nullif(x, ''::text)")).toBe(reduce("nullif(x, '')"));
    });
  });

  describe("boolean connectives", () => {
    // Parentheses are dropped, so a predicate that means something different
    // under different grouping cannot be compared by this form at all. Refusing
    // is what makes dropping them safe by construction.
    it("refuses `or`, which is how a bypass rides beside a tenant clause", () => {
      expect(refusedFor("owner_id = 1 or true")).toBe("or");
    });

    it("refuses `and`", () => {
      expect(refusedFor("owner_id = 1 and true")).toBe("and");
    });

    it("refuses `case`, the other way a predicate branches", () => {
      expect(refusedFor("case when true then owner_id else 0 end = 1")).toBe(
        "case"
      );
    });

    it("refuses whatever the case the connective was written in", () => {
      expect(refusedFor("owner_id = 1 OR true")).toBe("or");
    });

    it("accepts the canonical tenant predicate, which carries none", () => {
      expect(refusedFor(DRIZZLE)).toBeNull();
      expect(refusedFor(POSTGRES)).toBeNull();
    });

    it("does not refuse a literal or an identifier that merely contains one", () => {
      expect(refusedFor("x = 'and'")).toBeNull();
      expect(refusedFor("android_id = 1")).toBeNull();
    });
  });
});
