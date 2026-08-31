// The app-layer adapter owns step configuration. All of it.
//
// This is the layer ADR 0010 means when it says "the app parses
// deployment-specific configuration": @proto38/control-plane reads no
// environment variables, and this package is what makes that true rather than
// aspirational. Every step in this package calls `stepConfig()` first, so the
// configuration is present whether or not the step shares a module instance
// with whatever composed the deployment.
import { configureDb } from '@proto38/control-plane/db';
import type { CanonicalPullRequest, GitHubPort } from '@proto38/control-plane';
import { readFileSync, writeFileSync } from 'node:fs';

export const ADAPTER_ENV = {
  databaseUrl: 'PROTO38_REPROVE_URL',
  githubFixture: 'PROTO38_GITHUB_FIXTURE',
} as const;

let configured = false;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required by @proto38/control-plane-workflow.`);
  return v;
}

/** Idempotent, and safe to call at the top of every step. */
export function stepConfig(): { github: GitHubPort } {
  if (!configured) {
    configureDb(required(ADAPTER_ENV.databaseUrl));
    configured = true;
  }
  const fixture = required(ADAPTER_ENV.githubFixture);
  return {
    github: {
      async getPullRequest(): Promise<CanonicalPullRequest | 'transient'> {
        const f = JSON.parse(readFileSync(fixture, 'utf8'));
        if (f.transientOnce) {
          f.transientOnce = false;
          writeFileSync(fixture, JSON.stringify(f));
          return 'transient';
        }
        return f.canonical as CanonicalPullRequest;
      },
    },
  };
}
