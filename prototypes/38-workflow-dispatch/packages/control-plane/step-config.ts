// What a 'use step' function can actually see.
//
// A step is compiled into its own bundle with its own module instance, so
// nothing the app passed to createControlPlane() reaches it. Configuration a
// step needs must therefore arrive one of exactly two ways:
//
//   1. as a JSON step argument, or
//   2. resolved by the step's own module graph, from the environment.
//
// ADR 0010's "the package reads no environment variables" cannot hold for a
// package that owns workflow steps. What can hold is the property the ADR was
// actually protecting: no Reprove Cloud default exists anywhere, and every
// value is required with no fallback.
import { readFileSync, writeFileSync } from 'node:fs';
import type { CanonicalPullRequest, GitHubPort } from './ingress.ts';

export const STEP_ENV = {
  /** In production this is the App id + private key. Here, a fixture file. */
  githubFixture: 'PROTO38_GITHUB_FIXTURE',
} as const;

function required(name: string): string {
  const v = process.env[name];
  if (!v)
    throw new Error(
      `${name} is required. A workflow step cannot be handed configuration by ` +
        `the composition root; it must resolve its own.`,
    );
  return v;
}

export function resolveGitHubPort(): GitHubPort {
  const path = required(STEP_ENV.githubFixture);
  return {
    async getPullRequest(): Promise<CanonicalPullRequest | 'transient'> {
      const fixture = JSON.parse(readFileSync(path, 'utf8'));
      if (fixture.transientOnce) {
        fixture.transientOnce = false;
        writeFileSync(path, JSON.stringify(fixture));
        return 'transient';
      }
      return fixture.canonical as CanonicalPullRequest;
    },
  };
}
