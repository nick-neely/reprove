// Acceptance: the control plane's decision to absorb a submitted Result into
// its Run. CONTEXT.md makes this the stale-result boundary, so nothing here
// may depend on a Worker behaving. It runs only in the control plane, it
// re-parses everything a Worker sent, and the "exactly one accepted Result"
// invariant is a conditional UPDATE rather than a read-then-write.
import { ResultSchema, RefusalSchema, MAX_RESULT_BYTES } from '@proto38/protocol/v1';
import { withOwner } from './db.ts';

/** ADR 0006: two integers, advertised, and the window is a real range. */
export const PROTOCOL_CURRENT = 1;
export const PROTOCOL_MINIMUM = 1;

export type AcceptanceOutcome =
  | { accepted: true; status: 'completed' | 'incomplete'; runId: string }
  | { accepted: false; rejection: Rejection; detail?: string };

export type Rejection =
  | 'oversized'
  | 'malformed'
  | 'upgrade_required'
  | 'unknown_run'
  | 'wrong_tenant'
  | 'not_eligible'
  | 'stale_lease';

type SubmissionEnvelope = {
  /** The tenant the *credential* resolved to, never a field the Worker sent. */
  ownerId: number;
  runId: string;
  leaseToken: string;
  protocolVersion: number;
  rawBody: string;
};

/**
 * Accept a Result. Returns a rejection rather than throwing, because every
 * rejection here is a normal outcome of an untrusted caller.
 */
export async function acceptResult(env: SubmissionEnvelope): Promise<AcceptanceOutcome> {
  // 1. Raw byte bound before semantic parsing (ADR 0006).
  if (Buffer.byteLength(env.rawBody, 'utf8') > MAX_RESULT_BYTES)
    return { accepted: false, rejection: 'oversized' };

  // 2. Compatibility, before anything is trusted about the payload.
  if (env.protocolVersion < PROTOCOL_MINIMUM || env.protocolVersion > PROTOCOL_CURRENT)
    return {
      accepted: false,
      rejection: 'upgrade_required',
      detail: `minimum=${PROTOCOL_MINIMUM} current=${PROTOCOL_CURRENT} actual=${env.protocolVersion}`,
    };

  // 3. The same authoritative schema the Worker used, applied again.
  const parsed = ResultSchema.safeParse(JSON.parse(env.rawBody));
  if (!parsed.success)
    return { accepted: false, rejection: 'malformed', detail: parsed.error.issues[0]?.message };
  const result = parsed.data;
  if (result.runId !== env.runId)
    return { accepted: false, rejection: 'malformed', detail: 'runId mismatch' };

  const terminal = result.completeness === 'complete' ? 'completed' : 'incomplete';

  return withOwner(env.ownerId, async (c) => {
    // 4. The eligibility window and the write are one statement. A Run that is
    //    terminal or superseded matches nothing, so a late Worker loses the
    //    race by construction rather than by cooperating with a cancel.
    const w = await c.query(
      `update run
          set status = $1, result = $2, accepted_at = now(),
              protocol_version = $3, worker_build_version = $4
        where id = $5
          and owner_id = $6
          and status in ('claimed','executing')
          and lease_token = $7
          and accepted_at is null
        returning id`,
      [
        terminal,
        JSON.stringify(result),
        env.protocolVersion,
        result.workerBuildVersion,
        env.runId,
        env.ownerId,
        env.leaseToken,
      ],
    );
    if (w.rowCount === 1) return { accepted: true as const, status: terminal, runId: env.runId };

    // Nothing was written. Say precisely why, because "rejected" is not enough
    // to tell a superseded Run from a forged tenant.
    const probe = await c.query(
      `select owner_id, status, lease_token, accepted_at from run where id = $1`,
      [env.runId],
    );
    if (probe.rowCount === 0) return { accepted: false as const, rejection: 'unknown_run' as const };
    const r = probe.rows[0];
    if (Number(r.owner_id) !== env.ownerId)
      return { accepted: false as const, rejection: 'wrong_tenant' as const };
    if (r.lease_token !== env.leaseToken)
      return { accepted: false as const, rejection: 'stale_lease' as const };
    return {
      accepted: false as const,
      rejection: 'not_eligible' as const,
      detail: r.accepted_at ? `already accepted, status=${r.status}` : `status=${r.status}`,
    };
  });
}

/** A Refusal is pre-execution, so it accumulates on the Run and never terminates it. */
export async function acceptRefusal(env: SubmissionEnvelope): Promise<AcceptanceOutcome> {
  const parsed = RefusalSchema.safeParse(JSON.parse(env.rawBody));
  if (!parsed.success) return { accepted: false, rejection: 'malformed' };
  return withOwner(env.ownerId, async (c) => {
    const w = await c.query(
      `update run set refusals = refusals || $1::jsonb, status = 'queued', lease_token = null
        where id = $2 and owner_id = $3 and status in ('claimed','executing')
        returning id`,
      [JSON.stringify([parsed.data]), env.runId, env.ownerId],
    );
    return w.rowCount === 1
      ? { accepted: true as const, status: 'incomplete' as const, runId: env.runId }
      : { accepted: false as const, rejection: 'not_eligible' as const };
  });
}

/**
 * A hosted Worker's internal Failure, absorbed by a conditional control-plane
 * transition.
 *
 * Three properties make this safe, and all three were requirements from the
 * adversarial review rather than conveniences:
 *
 *  - It is NOT a protocol v1 message. #35 settled that Failure has no wire
 *    form, and nothing here changes that: no schema, no route, no version.
 *  - It absorbs no Result, so Acceptance remains the only path by which a
 *    Result enters a Run. The stale-result boundary is untouched.
 *  - It is a conditional UPDATE with the same eligibility window Acceptance
 *    uses, so a Worker reporting a Failure for a Run that is terminal,
 *    superseded, or held under a different lease changes nothing. The Worker
 *    signals; the control plane decides.
 *
 * "Hosted-only" is structural rather than policy: this function is reachable
 * by static import from an app that composes worker-hosted, and there is no
 * endpoint that exposes it. A self-hosted Worker has no way to call it, which
 * is the point - it is exactly the party ADR 0006 declines to trust.
 */
export async function reportHostedFailure(env: {
  ownerId: number;
  runId: string;
  leaseToken: string;
  code: string;
}): Promise<{ recorded: boolean; reason?: string }> {
  return withOwner(env.ownerId, async (c) => {
    const w = await c.query(
      `update run set status = 'failed', failure_reason = $1
        where id = $2 and owner_id = $3
          and status in ('claimed','executing')
          and lease_token = $4
          and accepted_at is null
        returning id`,
      [env.code, env.runId, env.ownerId, env.leaseToken],
    );
    return w.rowCount === 1
      ? { recorded: true }
      : { recorded: false, reason: 'not_eligible' };
  });
}
