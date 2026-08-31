// ADR 0013's Run-creation seam, reduced to what #38 needs: a disposition, a
// serialized critical section, and a Run whose immutable spec is complete at
// creation from an injected Phase0RunProfile.
import { randomUUID } from 'node:crypto';
import { RunSpecSchema, PROTOCOL_VERSION, type RunSpec } from '@proto38/protocol/v1';
import { withOwner } from './db.ts';

export type Disposition =
  | 'created'
  | 'noop'
  | 'superseded'
  | 'cancelled'
  | 'discarded'
  | 'contended'
  | 'transient'
  | 'unauthorized';

export type CanonicalPullRequest = {
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  draft: boolean;
  provenance: 'internal' | 'external';
};

/** ADR 0013: Phase 0 fixture values, named as such so they never become product defaults. */
export type Phase0RunProfile = {
  harness: RunSpec['harness'];
  model: string;
  strategy: 'standard';
  autonomy: RunSpec['autonomy'];
  placement: RunSpec['placement'];
  allowHostedFallback: boolean;
  resolvedConfig: RunSpec['resolvedConfig'];
  /** #38's decision: how long a Run stays claimable before `unscheduled`. */
  claimableFor: string;
};

export type GitHubPort = {
  /** Called *inside* the critical section, exactly as ADR 0013 requires. */
  getPullRequest(repositoryId: number, number: number): Promise<CanonicalPullRequest | 'transient'>;
};

export function digestOf(config: RunSpec['resolvedConfig']): string {
  // A real digest over the normalized config, not a placeholder (ADR 0013).
  const canonical = JSON.stringify(config, Object.keys(config).sort());
  let h = 0n;
  for (const ch of canonical) h = (h * 131n + BigInt(ch.charCodeAt(0))) % (1n << 64n);
  return `cfg1-${h.toString(16).padStart(16, '0')}`;
}

export function claimableUntilFrom(now: Date, spec: string): Date {
  const m = /^(\d+)(s|m|h)$/.exec(spec);
  if (!m) throw new Error(`bad claimableFor: ${spec}`);
  const mult = { s: 1_000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
  return new Date(now.getTime() + Number(m[1]) * mult);
}

export async function createRunForDelivery(
  deliveryId: number,
  ownerId: number,
  profile: Phase0RunProfile,
  github: GitHubPort,
): Promise<{
  disposition: Disposition;
  runId?: string;
  claimableUntil?: string;
  supersededRunIds?: string[];
}> {
  return withOwner(ownerId, async (c) => {
    const led = await c.query(
      `select * from ingress_delivery where id = $1 and owner_id = $2`,
      [deliveryId, ownerId],
    );
    if (led.rowCount === 0) return { disposition: 'discarded' as const };
    const d = led.rows[0];
    await c.query(`update ingress_delivery set attempt_count = attempt_count + 1 where id = $1`, [
      deliveryId,
    ]);

    // ADR 0013: ordering is the advisory lock, not delivery order. Everything
    // below - including the GitHub call - happens inside it.
    const lock = await c.query(
      `select pg_try_advisory_xact_lock(hashtext($1), $2) as got`,
      [String(d.repository_id), d.pull_request_number],
    );
    if (!lock.rows[0].got) return { disposition: 'contended' as const };

    const canonical = await github.getPullRequest(
      Number(d.repository_id),
      d.pull_request_number,
    );
    if (canonical === 'transient') return { disposition: 'transient' as const };
    if (canonical.state === 'closed') {
      await c.query(
        `update run set status = 'cancelled', failure_reason = 'pull_request_closed'
          where repository_id = $1 and pull_request_number = $2
            and status in ('queued','claimed','executing')`,
        [d.repository_id, d.pull_request_number],
      );
      return { disposition: 'cancelled' as const };
    }
    if (canonical.draft) return { disposition: 'discarded' as const };

    // An automatic trigger at a head a Run already exists for is a no-op in
    // ANY status. No allowlist: retry policy does not live in ingress.
    const already = await c.query(
      `select id from run where repository_id = $1 and pull_request_number = $2 and head_sha = $3`,
      [d.repository_id, d.pull_request_number, canonical.headSha],
    );
    if (already.rowCount! > 0) return { disposition: 'noop' as const };

    const superseded = await c.query(
      `update run set status = 'superseded'
        where repository_id = $1 and pull_request_number = $2
          and status in ('queued','claimed','executing')
        returning id, workflow_run_id`,
      [d.repository_id, d.pull_request_number],
    );

    const runId = `run_${randomUUID().slice(0, 12)}`;
    const claimableUntil = claimableUntilFrom(new Date(), profile.claimableFor);
    const spec: RunSpec = RunSpecSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      runId,
      ownerId,
      repositoryId: Number(d.repository_id),
      pullRequestNumber: d.pull_request_number,
      baseSha: canonical.baseSha,
      headSha: canonical.headSha,
      provenance: canonical.provenance,
      harness: profile.harness,
      model: profile.model,
      strategy: profile.strategy,
      autonomy: profile.autonomy,
      placement: profile.placement,
      resolvedConfig: profile.resolvedConfig,
      configDigest: digestOf(profile.resolvedConfig),
      claimableUntil: claimableUntil.toISOString(),
    } satisfies RunSpec);

    await c.query(
      `insert into run (id, owner_id, repository_id, pull_request_number, spec, head_sha,
                        claimable_until, placement, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'queued')`,
      [
        runId,
        ownerId,
        d.repository_id,
        d.pull_request_number,
        JSON.stringify(spec),
        canonical.headSha,
        claimableUntil.toISOString(),
        spec.placement,
      ],
    );

    return {
      disposition: (superseded.rowCount! > 0 ? 'superseded' : 'created') as Disposition,
      runId,
      claimableUntil: claimableUntil.toISOString(),
      supersededRunIds: superseded.rows.map((r) => r.id as string),
    };
  });
}
