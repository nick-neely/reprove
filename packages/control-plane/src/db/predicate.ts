/**
 * One policy predicate, reduced to the form two deparsers agree on.
 *
 * Postgres re-prints a stored expression through its own deparser, so the text
 * in `pg_policies` never matches the text Drizzle rendered even when the two
 * mean the same thing: it uppercases function names, adds `::text` to every
 * string literal, unquotes what it can and re-parenthesises freely. Comparing
 * the two therefore needs a normal form, and this module is the whole of it.
 *
 * It is separated from `checks.ts` because it is pure: no database, no Drizzle,
 * no catalog. That is what lets `predicate.test.ts` measure the three
 * distinctions the tenant boundary actually rests on - identifier folding,
 * literal opacity, and the refusal below - without a Postgres to run against.
 */

/** An identifier Postgres would print without quoting it. */
const BARE_IDENTIFIER = /^[a-z_][\da-z_$]*$/u;
const WORD_START = /[A-Za-z_\d]/u;
const WORD_BODY = /[\dA-Za-z_$]/u;
const WHITESPACE = /\s/u;

/**
 * Postgres's own identifier folding, applied to one token: an unquoted
 * identifier folds to lower case, a quoted one does not. That distinction is
 * load-bearing rather than pedantic - `"Owner_Id"` is a **different column**
 * from `owner_id`, and a policy comparing the wrong one is a tenant boundary
 * over nothing.
 *
 * @param raw One token, quoted or not.
 * @returns The token as Postgres would resolve it.
 */
const foldIdentifier = (raw: string): string => {
  if (!raw.startsWith('"')) {
    return raw.toLowerCase();
  }
  const inner = raw.slice(1, -1).replaceAll('""', '"');
  return BARE_IDENTIFIER.test(inner) ? inner : `"${inner}"`;
};

/**
 * One SQL expression as a token sequence.
 *
 * Tokenising is what lets the two deparsers' differences be reconciled
 * **without** reaching inside a string literal or a quoted identifier, which a
 * blanket lowercase-and-strip would do - and doing it would make
 * `nullif(x, ' ')` indistinguishable from `nullif(x, '')`, which is the ADR
 * 0008 outage wearing a disguise.
 *
 * Whitespace and parentheses are dropped. Dropping parentheses is the one
 * reduction that loses information: two expressions differing only in how a
 * fixed token sequence is grouped compare equal. {@link normalizePredicate}
 * refuses the grammar in which such a pair can exist, so the reduction is safe
 * by construction rather than by inspection.
 *
 * @param expression One SQL expression.
 * @returns Its tokens, folded, with whitespace and parentheses removed.
 */
const tokenize = (expression: string): string[] => {
  const tokens: string[] = [];
  let index = 0;

  const readQuoted = (quote: string): string => {
    let end = index + 1;
    while (end < expression.length) {
      if (expression[end] === quote) {
        if (expression[end + 1] === quote) {
          end += 2;
          continue;
        }
        break;
      }
      end += 1;
    }
    const raw = expression.slice(index, Math.min(end + 1, expression.length));
    index = end + 1;
    return raw;
  };

  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (WHITESPACE.test(character) || character === "(" || character === ")") {
      index += 1;
    } else if (character === "'") {
      // Verbatim, quotes included: what is inside a literal is data, and a
      // space is not an empty string.
      tokens.push(readQuoted("'"));
    } else if (character === '"') {
      tokens.push(foldIdentifier(readQuoted('"')));
    } else if (WORD_START.test(character)) {
      let end = index;
      while (end < expression.length && WORD_BODY.test(expression[end] ?? "")) {
        end += 1;
      }
      tokens.push(foldIdentifier(expression.slice(index, end)));
      index = end;
    } else if (expression.startsWith("::", index)) {
      tokens.push("::");
      index += 2;
    } else {
      tokens.push(character);
      index += 1;
    }
  }

  return tokens;
};

/**
 * The tokens that make parenthesis-dropping unsafe, and therefore the tokens a
 * comparable predicate may not contain.
 *
 * Grouping only changes meaning where something binds across it. A tenant
 * predicate is a comparison, a cast and two function calls, and no
 * re-parenthesisation of that token sequence means anything different. Add a
 * boolean connective and it does: `a and b or c` and `a and (b or c)` are
 * different predicates over one token stream, and the second is a tenant bypass
 * the first is not. `case` is here for the same reason, being the other way a
 * predicate can branch.
 *
 * So rather than reasoning about which connective is safe, or writing the SQL
 * parser that would answer it properly, a predicate carrying one is **refused**
 * - which is a failed policy check naming the table, not a silent pass.
 *
 * A quoted identifier that spells one of these folds to the bare word and is
 * refused too. That is a false positive on a column literally named `and`, and
 * it errs in the direction a security check should err in.
 */
const CONNECTIVES = new Set(["and", "or", "case"]);

/** A separator no token can contain, so a join cannot forge a boundary. */
const TOKEN_SEPARATOR = " ";

/** A predicate reduced to comparable form, or the reason it cannot be. */
export type NormalizedPredicate =
  | { readonly normalized: string }
  | { readonly connective: string };

/**
 * One predicate reduced to the form both deparsers agree on.
 *
 * Two reductions run over the token stream. `::text` goes because Postgres adds
 * one to every string literal and Drizzle does not. The table qualifier goes
 * because Drizzle renders `"run"."owner_id"` where Postgres, which already
 * knows the relation, renders `owner_id`.
 *
 * @param expression A policy predicate from either side.
 * @param table The SQL name of the table the policy is attached to.
 * @returns The predicate as a token sequence, or the connective that refused it.
 */
export const normalizePredicate = (
  expression: string,
  table: string
): NormalizedPredicate => {
  const tokens = tokenize(expression);
  const reduced: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (CONNECTIVES.has(token)) {
      return { connective: token };
    }
    if (token === "::" && tokens[index + 1] === "text") {
      index += 1;
      continue;
    }
    if (token === table && tokens[index + 1] === ".") {
      index += 1;
      continue;
    }
    reduced.push(token);
  }

  return { normalized: reduced.join(TOKEN_SEPARATOR) };
};
