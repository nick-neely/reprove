import { Client } from 'pg';
const c = new Client({ connectionString: 'postgres://world:world@localhost:55438/reprove' });
await c.connect();
await c.query(`insert into owner values (6161,'nextcheck') on conflict do nothing`);
await c.query(`insert into repository values (88001,6161,'acme/nextcheck') on conflict do nothing`);
const spec = {
  protocolVersion: 1, runId: 'run_next_1', ownerId: 6161, repositoryId: 88001,
  pullRequestNumber: 42, baseSha: 'b1', headSha: 'a1', provenance: 'external',
  harness: 'codex', model: 'gpt-5-codex', strategy: 'standard', autonomy: 'verify',
  placement: 'hosted',
  resolvedConfig: { schemaVersion: 1, thresholdSeverity: 'medium', ignore: [] },
  configDigest: 'cfg1-0000000000000000',
  claimableUntil: new Date(Date.now() + 30 * 60000).toISOString(),
};
await c.query(`delete from run where id = 'run_next_1'`);
await c.query(
  `insert into run (id, owner_id, repository_id, pull_request_number, spec, head_sha,
                    claimable_until, placement, status, lease_token)
   values ($1,6161,88001,42,$2,'a1',$3,'hosted','executing','lease_next')`,
  ['run_next_1', JSON.stringify(spec), spec.claimableUntil],
);
console.log(JSON.stringify({ spec }));
await c.end();
