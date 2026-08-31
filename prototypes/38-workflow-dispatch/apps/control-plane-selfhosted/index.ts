// The self-hosted deployment, as a SEPARATE app package.
//
// The first attempt at this proved nothing: it declared and imported
// worker-hosted and merely skipped calling it, so it demonstrated a runtime
// flag rather than the dependency-graph property ADR 0010 actually claims -
// "a control plane that dispatches only to self-hosted Workers installs no
// harness code at all", verifiable with `pnpm why`.
//
// This package declares @proto38/control-plane and nothing else. tools/boundary.ts
// walks the resolved dependency closure and asserts that neither worker-core,
// worker-hosted nor the harness stub is reachable from here at all.
import { createControlPlane, type GitHubPort, type Phase0RunProfile } from '@proto38/control-plane';

export const PHASE_0_PROFILE: Phase0RunProfile = {
  harness: 'codex',
  model: 'gpt-5-codex',
  strategy: 'standard',
  autonomy: 'verify',
  placement: 'self-hosted',
  allowHostedFallback: false,
  resolvedConfig: { schemaVersion: 1, thresholdSeverity: 'medium', ignore: ['dist/**'] },
  claimableFor: '30m',
};

export function composeSelfHosted(opts: { github: GitHubPort; ingestBaseUrl: string }) {
  return createControlPlane({
    profile: PHASE_0_PROFILE,
    github: opts.github,
    ingestBaseUrl: opts.ingestBaseUrl,
    // No `hosted`. There is no dispatcher to pass, because this deployment
    // does not have the package that would provide one.
  });
}
