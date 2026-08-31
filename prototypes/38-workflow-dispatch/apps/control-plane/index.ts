// apps/control-plane - route wiring, environment parsing and composition.
// Nothing else. It is the only place the two halves meet.
import { createServer, type Server } from 'node:http';
import {
  createControlPlane,
  submitResult,
  submitRefusal,
  notifyLifecycle,
  type GitHubPort,
  type Phase0RunProfile,
} from '@proto38/control-plane';
import { createHostedDispatcher } from '@proto38/worker-hosted';
import type { FaultProfile } from '@proto38/worker-core';

export const PHASE_0_PROFILE: Phase0RunProfile = {
  // Phase 0 fixture values. Not product defaults - Phase 1 owns selection policy.
  harness: 'codex',
  model: 'gpt-5-codex',
  strategy: 'standard',
  autonomy: 'verify',
  placement: 'hosted',
  allowHostedFallback: false,
  resolvedConfig: { schemaVersion: 1, thresholdSeverity: 'medium', ignore: ['dist/**'] },
  // #38's Phase 0 value. See README: short enough that an unscheduled Run is a
  // fast, visible answer rather than a silent hang, long enough that a cold
  // hosted dispatch or a self-hosted Worker on a slow poll is not raced out.
  claimableFor: '30m',
};

/**
 * The one ingest path, shared by both placements. A hosted Worker POSTs here
 * from its own durable run; a self-hosted Worker will POST here over HTTPS.
 * The route handler holds no substance: it parses, and calls Acceptance.
 */
export function startIngestServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const m = /^\/v1\/runs\/([^/]+)\/(result|refusal)$/.exec(req.url ?? '');
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const ownerHeader = Number(req.headers['x-reprove-owner'] ?? NaN);
    if (!m || !auth) {
      res.writeHead(404).end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const env = {
      // In production the tenant comes from resolving the credential, never
      // from a field the Worker sent. Here the header stands in for that, and
      // the scenarios forge it deliberately to prove Acceptance still refuses.
      ownerId: ownerHeader,
      runId: m[1],
      leaseToken: auth[1],
      protocolVersion: Number(req.headers['x-reprove-protocol-version'] ?? 0),
      rawBody: Buffer.concat(chunks).toString('utf8'),
    };
    const outcome =
      m[2] === 'result' ? await submitResult(env) : await submitRefusal(env);
    res.writeHead(outcome.accepted ? 202 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(outcome));
    // The durable run is resumed after the response, never inside it.
    void notifyLifecycle(outcome);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${a.port}` });
    }),
  );
}

/** The hosted-capable deployment: control-plane + worker-hosted. */
export function composeHosted(opts: {
  github: GitHubPort;
  ingestBaseUrl: string;
  fault?: FaultProfile;
}) {
  return createControlPlane({
    profile: PHASE_0_PROFILE,
    github: opts.github,
    ingestBaseUrl: opts.ingestBaseUrl,
    hosted: createHostedDispatcher({ fault: opts.fault }),
  });
}

/** The self-hosted deployment: worker-hosted is simply absent. */
export function composeSelfHostedOnly(opts: { github: GitHubPort; ingestBaseUrl: string }) {
  return createControlPlane({
    profile: { ...PHASE_0_PROFILE, placement: 'self-hosted' },
    github: opts.github,
    ingestBaseUrl: opts.ingestBaseUrl,
  });
}
