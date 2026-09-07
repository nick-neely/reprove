/**
 * The one property this module exists for: Acceptance's predicate and the
 * liveness transition's predicate are the **same window**, and no edit can move
 * one without moving the other.
 *
 * [ADR 0015](../../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
 * requires the window be "defined once and shared, never restated", because a
 * detector scoped more narrowly than Acceptance leaves the guarantee holed. That
 * is a claim about two SQL fragments rather than about the database, so this
 * file needs no stack: it renders both through the pinned dialect and compares.
 *
 * A test that merely called both functions and checked they returned something
 * would pass under exactly the divergence this exists to catch.
 */
import { and, eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "../db/schema.js";
import { resultEligible, resultEligibleWindow } from "./eligibility.js";

const DIALECT = new PgDialect();

const ACME = 1001;
const RUN = "11111111-1111-4111-8111-111111111111";
const TOKEN_HASH = "sha256:0123456789abcdef";

const render = (predicate: ReturnType<typeof resultEligibleWindow>) => {
  if (predicate === undefined) {
    throw new Error("the window rendered to nothing at all");
  }
  const query = DIALECT.sqlToQuery(predicate);
  return { sql: query.sql, params: [...query.params] };
};

describe("ADR 0015's Result-eligibility window", () => {
  it("is Acceptance's predicate exactly, plus the execution identity", () => {
    // The whole guarantee, as one comparison: Acceptance's predicate is the
    // shared window with the token conjunct on it, and nothing else. If a
    // future edit adds a conjunct to one and not the other, this fails.
    expect(render(resultEligible(ACME, RUN, TOKEN_HASH))).toStrictEqual(
      render(
        and(
          resultEligibleWindow(ACME, RUN),
          eq(schema.run.executionTokenHash, TOKEN_HASH)
        )
      )
    );
  });

  it("carries the Owner, the Run, the two live statuses and an unaccepted Result", () => {
    const window = render(resultEligibleWindow(ACME, RUN));

    // `ownerId` is in the predicate as well as in the tenant context, which is
    // ADR 0008 rule 1: application scoping **plus** RLS, "not either alone".
    expect(window.sql).toContain('"owner_id"');
    expect(window.sql).toContain('"id"');
    expect(window.sql).toContain('"status" in');
    expect(window.sql).toContain('"accepted_at" is null');
    expect(window.params).toStrictEqual([ACME, RUN, "claimed", "executing"]);
  });

  it("names no execution token, because the watchdog holds none", () => {
    // The half that makes #56 possible at all. A window that insisted on a
    // token could not be shared with a detector whose whole evidence is that
    // the execution stopped answering.
    expect(render(resultEligibleWindow(ACME, RUN)).sql).not.toContain(
      "execution_token_hash"
    );
    expect(render(resultEligible(ACME, RUN, TOKEN_HASH)).sql).toContain(
      "execution_token_hash"
    );
  });
});
