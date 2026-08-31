// The app parses the environment. Exactly as ADR 0010 says it should.
//
// The difference from the first composition is *where this module sits in the
// import graph*: an app-owned step imports it statically, so the bundler pulls
// it into the step bundle. Nothing is injected at runtime, so nothing has to
// survive a module-instance boundary.
import { configureDb } from '@proto38/control-plane';
import type { CanonicalPullRequest, GitHubPort } from '@proto38/control-plane';
import { readFileSync, writeFileSync } from 'node:fs';

let ready = false;
export function appConfig() {
  const url = process.env.PROTO38_REPROVE_URL;
  const fixture = process.env.PROTO38_GITHUB_FIXTURE;
  if (!url || !fixture) throw new Error('PROTO38_REPROVE_URL and PROTO38_GITHUB_FIXTURE required');
  if (!ready) {
    configureDb(url);
    ready = true;
  }
  const github: GitHubPort = {
    async getPullRequest(): Promise<CanonicalPullRequest | 'transient'> {
      const f = JSON.parse(readFileSync(fixture, 'utf8'));
      if (f.transientOnce) {
        f.transientOnce = false;
        writeFileSync(fixture, JSON.stringify(f));
        return 'transient';
      }
      return f.canonical as CanonicalPullRequest;
    },
  };
  return { url, github };
}
