/**
 * The one read of a Run that decides nothing.
 *
 * Every other read in this package exists to be acted on: `readSchedule` is
 * what a lifecycle wakes to, and Acceptance's re-probe exists only to name a
 * rejection it has already decided. This one is for an **observer**, and
 * [ADR 0016](../../../../docs/adr/0016-phase-0-acceptance-scenario.md) is what
 * asks for it - the Phase 0 exit reads the `run` row back "through
 * `withOwner()` on the pooled runtime role", and none of what it reads back
 * was reachable from outside the package.
 *
 * **It is a separate module from `lifecycle.ts` because it is not a lifecycle
 * operation.** That module is "the Run row as the arbiter between lifecycles",
 * and every statement in it carries `workflow_run_id = <the writer>` for that
 * reason. Putting an unconditional read beside them would make that paragraph
 * untrue of one of its members, in a module whose whole discipline is that it
 * is true of all of them.
 *
 * The alternative ADR 0016 leaves open is reading the columns directly with
 * `psql`. That was rejected as the primary read: it reproduces neither the
 * restricted runtime role nor the transaction-local tenant context, so it would
 * not be the read the criterion names, and under a transaction-mode pooler a
 * `set_config` in one invocation is not there for the next one anyway (ADR 0008
 * rule 2). Going through the composed control plane gets both for free.
 *
 * Like the rest of this folder, nothing here is exported from `src/index.ts`:
 * the signature names a Drizzle transaction, and ADR 0010 forbids the only
 * consumer from depending on Drizzle. What the app reaches is
 * `ControlPlane.readRun`, which is this bound to a `withOwner` transaction.
 */
import { eq } from "drizzle-orm";

import type { TenantTransaction } from "../db/runtime.js";
import type {
  RunFailureReason,
  RunPlacement,
  RunStatus,
} from "../db/schema-values.js";
import * as schema from "../db/schema.js";
import type { ExecutionLostDetail, RunRecord } from "./record.js";

/**
 * One Run, as an observer sees it, or `null` where this Owner has no such Run.
 *
 * **`null` conflates two things deliberately.** A Run belonging to another
 * Owner is not merely absent from this result - it is invisible, because the
 * read runs inside `withOwner()` and RLS is what answers. ADR 0016 makes the
 * same conflation load-bearing when it removes `wrong_tenant` from Acceptance's
 * rejection set: "a cross-tenant submission and a nonsense Run id are now
 * indistinguishable, deliberately", and that is also the safer disclosure.
 *
 * @param tx A tenant transaction already scoped to the Owner asking.
 * @param runId The Run.
 * @returns The observable state of the Run, or `null`.
 */
export const readRun = async (
  tx: TenantTransaction,
  runId: string
): Promise<RunRecord | null> => {
  const [row] = await tx
    .select({
      acceptedAt: schema.run.acceptedAt,
      executionTokenHash: schema.run.executionTokenHash,
      failureDetail: schema.run.failureDetail,
      failureReason: schema.run.failureReason,
      hostedWorkflowRunId: schema.run.hostedWorkflowRunId,
      placement: schema.run.placement,
      resultSummary: schema.run.resultSummary,
      status: schema.run.status,
    })
    .from(schema.run)
    .where(eq(schema.run.id, runId))
    .limit(1);
  if (!row) {
    return null;
  }
  /*
   * The four assertions below are the ones `readSchedule` makes, for the same
   * reason and with the same limit. ADR 0008 keeps the state machine in the
   * application, so these columns are `text` and `jsonb` rather than enums;
   * every writer in this package spells them from the closed sets, and the
   * failure detail has exactly one writer - `terminateLostExecution`, which
   * builds all three of its fields in one `jsonb_build_object`. A value outside
   * those sets is a defect, and this read has no better answer for one than to
   * report it as it stands: refusing it would turn an observation into a second
   * opinion about what the row is allowed to say.
   */
  // SAFETY: written only by `terminateLostExecution`, in one statement.
  const failureDetail = row.failureDetail as ExecutionLostDetail | null;
  // SAFETY: `RUN_FAILURE_REASONS`, written beside the detail above.
  const failureReason = row.failureReason as RunFailureReason | null;
  // SAFETY: `RUN_PLACEMENTS`, written at creation from the injected profile.
  const placement = row.placement as RunPlacement;
  // SAFETY: `RUN_STATUSES`, written by every transition in this package.
  const status = row.status as RunStatus;
  return {
    acceptedAt: row.acceptedAt,
    executionTokenHash: row.executionTokenHash,
    failureDetail,
    failureReason,
    hostedWorkflowRunId: row.hostedWorkflowRunId,
    placement,
    resultSummary: row.resultSummary,
    status,
  };
};
