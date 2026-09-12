/**
 * What a dispatch concludes once its own `record` matched nothing:
 * `concludeDispatch`, beside the step that calls it.
 *
 * The decision is a pure function of two ids - the lifecycle this dispatch
 * started, and the one the Run names now - so it needs neither a durable
 * runtime nor a database, and enumerating the three answers is the whole of
 * what there is to say about it.
 *
 * **It is tested here because the real path cannot be reached from a test.**
 * The branch runs only where `record` lost a race the shipped ordering wins in
 * one round trip: `dispatchLifecycle` records milliseconds after `start()`,
 * and the only other writer is a lifecycle that has been past its own deadline
 * for the whole ten-second grace. Reaching that interleaving would need a
 * test-only branch inside shipped orchestration, and
 * [#87](https://github.com/nick-neely/reprove/issues/87) has just removed the
 * last one, as
 * [ADR 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md) records.
 * The ordering this sits in - start, record, then keep or cancel - is
 * `spine.test.ts`'s, against the real World.
 */
import { describe, expect, it } from "vitest";

import { concludeDispatch } from "./ingress.js";

const MINE = "wrun_dispatched";

describe("what a dispatch concludes when its record matched nothing", () => {
  it("keeps the durable run it started where the Run already names it", () => {
    // The lifecycle recorded itself, which it does only after its deadline and
    // the grace have both passed with the column still null. Cancelling here
    // would kill the lifecycle the Run records and leave both windows with no
    // deadline that can close them, which is worse than the state it fixed.
    expect(concludeDispatch(MINE, MINE)).toStrictEqual({
      cancelledLifecycle: null,
      workflowRunId: MINE,
    });
  });

  it("cancels the durable run it started where the Run names another lifecycle", () => {
    // ADR 0014's orphan, made inert on the spot rather than at its deadline:
    // the row arbitrates, and the loser is whoever it does not name.
    expect(concludeDispatch(MINE, "wrun_recorded_first")).toStrictEqual({
      cancelledLifecycle: MINE,
      workflowRunId: null,
    });
  });

  it("cancels the durable run it started where the Run names nothing at all", () => {
    // The Run is not this Owner's, or it is gone. Either way nothing here may
    // report itself as the recorded lifecycle, and a durable run that will
    // never be recorded must not be left sleeping toward a deadline.
    expect(concludeDispatch(MINE, null)).toStrictEqual({
      cancelledLifecycle: MINE,
      workflowRunId: null,
    });
  });
});
