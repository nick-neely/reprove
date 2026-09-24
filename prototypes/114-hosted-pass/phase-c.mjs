// PROTOTYPE for #114. Throwaway, never merged.
// Phase C: ADR 0027 egress through a Reprove proxy behind forwardURL, measured from a real Sandbox.
import pg from "pg";
import { Sandbox } from "@vercel/sandbox";
import { fixtureToken, ledger, log, vercelCredentials } from "./lib.mjs";

const creds = vercelCredentials();
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace("sslmode=require", "sslmode=verify-full") });
await db.connect();
const EGRESS = "https://reprove-proto-114.vercel.app/api/egress";
const HOSTS = ["registry.npmjs.org", "github.com", "codeload.github.com", "pypi.org", "files.pythonhosted.org"];
const forwarded = (extra = {}) => ({ allow: { ...Object.fromEntries(HOSTS.map((h) => [h, [{ forwardURL: EGRESS }]])), ...extra } });
const direct = { allow: Object.fromEntries(HOSTS.map((h) => [h, []])) };
const name = `p114-egress-${Date.now().toString(36)}`;

const sandbox = await Sandbox.create({ ...creds, name, persistent: false, timeout: 20 * 60_000, networkPolicy: forwarded() });
ledger({ kind: "sandbox", name, phase: "c" });
const sid = sandbox.currentSession().sessionId;
await db.query("insert into egress_auth (name, sandbox_id) values ($1, $2)", [name, sid]);
const sh = async (label, command, opts = {}) => {
  const t0 = Date.now();
  const r = await sandbox.runCommand({ cmd: "sh", args: ["-c", command], ...opts });
  const out = (await r.output("both")).trim();
  const res = { ms: Date.now() - t0, exitCode: r.exitCode, out: out.length > 1200 ? `${out.slice(0, 400)}\n...\n${out.slice(-700)}` : out };
  log(label, res);
  return res;
};
const since = async (t0) => (await db.query(
  "select verdict, count(*)::int n, sum(resp_bytes)::bigint bytes, max(ms) max_ms, round(avg(ms)) avg_ms from egress_log where name = $1 and at >= $2 group by verdict", [name, t0])).rows;
const mark = async () => (await db.query("select now() t")).rows[0].t;

try {
  let t = await mark();
  await sh("npm view through the egress route", "npm view is-number version");
  log("egress log", await since(t));

  t = await mark();
  const install = "mkdir -p /tmp/a && cd /tmp/a && npm init -y >/dev/null && npm install --no-audit --no-fund --ignore-scripts --cache /tmp/cache-a typescript@5 eslint@9 vitest@3 2>&1 | tail -3";
  const viaProxy = await sh("npm install (typescript, eslint, vitest) via egress route", install);
  log("egress log for the install", await since(t));
  log("upstream statuses and redirects", (await db.query("select status, count(*)::int n, min(location) sample_location from egress_log where name = $1 and at >= $2 group by status", [name, t])).rows);

  await sandbox.update({ networkPolicy: direct });
  const baseline = await sh("same install, domains allowed directly (baseline)", install.replaceAll("/tmp/a", "/tmp/b").replace("cache-a", "cache-b"));
  log("install comparison", { viaProxyMs: viaProxy.ms, directMs: baseline.ms, ratio: +(viaProxy.ms / baseline.ms).toFixed(2) });
  await sandbox.update({ networkPolicy: forwarded() });

  t = await mark();
  await sh("git clone public repo through egress (upload-pack)", "cd /tmp && GIT_TERMINAL_PROMPT=0 git clone -q https://github.com/octocat/Hello-World hw && git -C hw log --oneline -1");
  await sh("git fetch a fork head by SHA through egress", "cd /tmp/hw && sha=$(git ls-remote origin 'refs/pull/1/head' | cut -f1) && git fetch -q origin $sha && git cat-file -t $sha");
  log("git requests seen", (await db.query("select method, path, verdict, status, req_bytes, resp_bytes, ms from egress_log where name = $1 and at >= $2 order by id", [name, t])).rows);

  t = await mark();
  await sh("archive download: redirect to codeload, not followed by the proxy", "curl -s -o /dev/null -w 'first=%{http_code} redirect=%{redirect_url}\\n' https://github.com/octocat/Hello-World/archive/refs/heads/master.tar.gz; curl -sL -o /dev/null -w 'followed=%{http_code} final=%{url_effective}\\n' https://github.com/octocat/Hello-World/archive/refs/heads/master.tar.gz");
  await sh("pip download through egress (pypi.org -> files.pythonhosted.org)", "python3 -m pip --version 2>&1 | head -1; python3 -m pip download --no-deps -q -d /tmp/pip requests 2>&1 | tail -2; ls /tmp/pip");
  log("redirect/registry requests", (await db.query("select host, method, left(path, 80) path, status, location from egress_log where name = $1 and at >= $2 order by id", [name, t])).rows);

  t = await mark();
  await sh("Host header differing from the name", "curl -s -o /dev/null -w '%{http_code}\\n' https://registry.npmjs.org/is-number -H 'Host: evil.example'");
  await sh("POST to the registry (method denial)", "curl -s -o /dev/null -w '%{http_code}\\n' -X POST https://registry.npmjs.org/-/v1/login -d '{}'");
  await sh("a host not in the policy", "curl -s -m 10 -o /dev/null -w '%{http_code}\\n' https://example.com; echo exit=$?");
  log("what the route saw", (await db.query("select host, method, path, verdict, status, host_header, fwd_headers from egress_log where name = $1 and at >= $2 order by id", [name, t])).rows);

  // A transform and a forwardURL on the same domain: does the forwarded request carry the injected header?
  const { token } = await fixtureToken();
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  t = await mark();
  await sandbox.update({ networkPolicy: forwarded({ "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }, { forwardURL: EGRESS }] }) });
  await sh("github.com with [transform, forwardURL]", "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/octocat/Hello-World HEAD 2>&1 | head -2");
  await sandbox.update({ networkPolicy: forwarded({ "github.com": [{ forwardURL: EGRESS }, { transform: [{ headers: { authorization: `Basic ${basic}` } }] }] }) });
  await sh("github.com with [forwardURL, transform]", "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/octocat/Hello-World HEAD 2>&1 | head -2");
  log("transform+forward composition", (await db.query("select path, verdict, status, fwd_headers from egress_log where name = $1 and at >= $2 order by id", [name, t])).rows);

  // Unreachable and failing forwardURLs: fail closed or open?
  for (const [label, target] of [
    ["non-resolving host", "https://p114-no-such-host-3e9c1.vercel.app/x"],
    ["route that 404s", "https://reprove-proto-114.vercel.app/api/does-not-exist"],
  ]) {
    try {
      await sandbox.update({ networkPolicy: { allow: { "registry.npmjs.org": [{ forwardURL: target }] } } });
      await sh(`forwardURL = ${label}`, "curl -s -m 20 -o /tmp/o -w 'status=%{http_code}\\n' https://registry.npmjs.org/is-number; echo exit=$?; head -c 200 /tmp/o; echo");
    } catch (e) { log(`forwardURL = ${label}: policy rejected`, e.message); }
  }
} finally {
  await db.query("update egress_auth set revoked = true where name = $1", [name]);
  await sandbox.stop().catch(() => {});
  await db.end();
}
