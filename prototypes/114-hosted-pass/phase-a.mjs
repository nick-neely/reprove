// PROTOTYPE for #114. Throwaway, never merged.
// Phase A: Vercel Sandbox SDK semantics, driven from a local process.
// Usage: node phase-a.mjs <names|timeout|race|users|fetch|history|history-delete> [args]
// Every Sandbox is persistent: false and stopped in a finally, except `history`,
// which is left stopped for the dashboard check and removed by `history-delete`.
import { Sandbox } from "@vercel/sandbox";
import {
  describeError, fixtureToken, ledger, log, sandboxFacts, sleep, vercelCredentials,
} from "./lib.mjs";

const creds = vercelCredentials();
const stamp = Date.now().toString(36);
const base = { ...creds, persistent: false, timeout: 5 * 60_000, networkPolicy: "deny-all" };

async function attempt(label, fn) {
  const t0 = performance.now();
  try {
    const value = await fn();
    log(`${label} ok in ${Math.round(performance.now() - t0)}ms`, value ?? "(no value)");
    return value;
  } catch (error) {
    log(`${label} threw in ${Math.round(performance.now() - t0)}ms`, describeError(error));
    return undefined;
  }
}

async function run(sandbox, cmd, args = [], opts = {}) {
  const done = await sandbox.runCommand({ cmd, args, ...opts });
  return { cmdId: done.cmdId, exitCode: done.exitCode, stdout: await done.stdout(), stderr: await done.stderr() };
}

async function created(name, extra = {}) {
  const t0 = performance.now();
  const sandbox = await Sandbox.create({ ...base, name, ...extra });
  const ms = Math.round(performance.now() - t0);
  ledger({ kind: "sandbox", name, createMs: ms });
  log(`create ${name} in ${ms}ms`, sandboxFacts(sandbox));
  return sandbox;
}

async function stopQuietly(sandbox) {
  if (sandbox) await attempt(`stop ${sandbox.name}`, async () => {
    const r = await sandbox.stop();
    return { status: r.status, snapshot: r.snapshot ?? null };
  });
}

const probes = {
  // Name uniqueness, second create, get() by state, and exact-id verification.
  async names() {
    const name = `p114-names-${stamp}`;
    const a = await created(name);
    try {
      await attempt("second create under the same name", () => created(name));
      const got = await attempt("get(name) while running", async () => sandboxFacts(await Sandbox.get({ ...creds, name })));
      log("identity check: sessionId from create vs get", { create: a.currentSession().sessionId, get: got?.sessionId });
      await attempt("listSessions", () => a.listSessions());
      await stopQuietly(a);
      await attempt("get(name) after stop, resume:false", async () => sandboxFacts(await Sandbox.get({ ...creds, name })));
      await attempt("create again under the stopped name", async () => sandboxFacts(await Sandbox.create({ ...base, name })));
      await attempt("get(never-created name)", () => Sandbox.get({ ...creds, name: `p114-never-${stamp}` }));
    } finally {
      await stopQuietly(a);
      await attempt("delete", () => a.delete());
      await attempt("get(name) after delete", async () => sandboxFacts(await Sandbox.get({ ...creds, name })));
    }
  },

  // A non-persistent Sandbox past its platform timeout.
  async timeout() {
    const name = `p114-timeout-${stamp}`;
    const s = await created(name, { timeout: 60_000 });
    try {
      for (let i = 0; i < 12; i++) {
        await sleep(15_000);
        const facts = await attempt(`get(name) at +${(i + 1) * 15}s`, async () => sandboxFacts(await Sandbox.get({ ...creds, name })));
        if (facts && facts.status !== "running" && facts.status !== "pending") break;
      }
      await attempt("runCommand on the original handle after timeout", () => run(s, "true"));
    } finally {
      await stopQuietly(s);
    }
  },

  // Interrupted create racing a by-name lookup and stop().
  async race(abortAfterMs = "300") {
    const name = `p114-race-${stamp}`;
    const controller = new AbortController();
    const t0 = performance.now();
    setTimeout(() => controller.abort(), Number(abortAfterMs));
    await attempt(`create aborted at ${abortAfterMs}ms`, () => Sandbox.create({ ...base, name, signal: controller.signal }));
    let found;
    for (let i = 0; i < 20 && !found; i++) {
      try { found = await Sandbox.get({ ...creds, name }); } catch (e) { if (i === 0 || i === 19) log(`get(name) at +${Math.round(performance.now() - t0)}ms`, describeError(e).message); }
      if (!found) await sleep(1500);
    }
    if (found) log(`found at +${Math.round(performance.now() - t0)}ms`, "");
    if (found) {
      log("found after abort", sandboxFacts(found));
      await stopQuietly(found);
      await attempt("get(name) after stop", async () => sandboxFacts(await Sandbox.get({ ...creds, name })));
    }
  },

  // Default user, and the dedicated Reviewer user against ADR 0024 §7's checks.
  async users() {
    const s = await created(`p114-users-${stamp}`);
    try {
      log("default user", await run(s, "sh", ["-c", "id; echo HOME=$HOME; pwd; sudo -n true && echo SUDO_OK || echo SUDO_DENIED"]));
      log("image", await run(s, "sh", ["-c", "cat /etc/os-release | head -3; uname -r; node --version; git --version; which python3 getcap setpriv unshare || true"]));
      const reviewer = await s.createUser("reviewer");
      const checks = [
        "id",
        "sudo -n -l 2>&1 | head -20; sudo -n true && echo SUDO_OK || echo SUDO_DENIED",
        "getent group sudo wheel adm docker disk lxd 2>/dev/null",
        "find / -xdev \\( -perm -4000 -o -perm -2000 \\) -type f 2>/dev/null",
        "(command -v getcap >/dev/null && getcap -r / 2>/dev/null) || echo 'getcap unavailable'",
        "for d in / /usr /usr/bin /usr/local /usr/local/bin /etc /opt /home /tmp /vercel $HOME; do [ -e \"$d\" ] && printf '%s ' \"$d\" && stat -c '%U:%G %a' \"$d\"; done",
        "for d in /usr/local/bin /usr/bin /etc /opt /vercel; do [ -w \"$d\" ] && echo WRITABLE $d; done; echo done",
        "ls -la /etc/sudoers.d 2>&1; cat /etc/sudoers 2>&1 | grep -v '^#' | grep -v '^$'",
      ];
      for (const c of checks) log(`reviewer: ${c}`, await run(reviewer, "sh", ["-c", c]));
    } finally {
      await stopQuietly(s);
    }
  },

  // Header-injected git fetch by SHA, per-domain transform removal, and whether a
  // connection opened before a policy update keeps its injection.
  async fetch() {
    const { token, owner, repo } = await fixtureToken();
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    const both = {
      allow: {
        "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }],
        "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }],
      },
    };
    const shas = await (await globalThis.fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=2`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const sha = shas[0].sha;
    const s = await created(`p114-fetch-${stamp}`, { networkPolicy: both });
    try {
      log("policy read back", s.networkPolicy);
      log("fetch private fixture by SHA, no credential in the Sandbox", await run(s, "sh", ["-c",
        `set -x; git init -q /tmp/w && cd /tmp/w && git fetch --no-tags https://github.com/${owner}/${repo} ${sha} 2>&1 && git cat-file -t ${sha}; git fetch https://github.com/${owner}/${repo} ${sha} --depth=1 2>&1 | tail -2`]));
      log("fork head by SHA through the base repo (public octocat/Hello-World, refs/pull)", await run(s, "sh", ["-c",
        "cd /tmp && git ls-remote https://github.com/octocat/Hello-World 'refs/pull/*/head' 2>&1 | head -3"]));
      const forkSha = (await run(s, "sh", ["-c", "git ls-remote https://github.com/octocat/Hello-World 'refs/pull/*/head' | head -1 | cut -f1"])).stdout.trim();
      log("fetch that fork SHA directly", await run(s, "sh", ["-c",
        `git init -q /tmp/h && cd /tmp/h && git fetch --no-tags https://github.com/octocat/Hello-World ${forkSha} 2>&1 | tail -3; git cat-file -t ${forkSha}`]));

      // Keep-alive client: request, wait for a flag, request again on the same socket, then on a fresh one.
      await s.writeFiles([{ path: "/tmp/keepalive.mjs", content: Buffer.from(`
        import https from "node:https"; import { existsSync } from "node:fs";
        const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
        const get = (a) => new Promise((ok) => { const r = https.get("https://api.github.com/installation/repositories", { agent: a, headers: { "user-agent": "p114" } }, (res) => { res.resume(); res.on("end", () => ok({ status: res.statusCode, reused: r.reusedSocket })); }); r.on("error", (e) => ok({ error: e.message })); });
        console.log("before", JSON.stringify(await get(agent)));
        while (!existsSync("/tmp/flag")) await new Promise((r) => setTimeout(r, 200));
        console.log("same-connection-after", JSON.stringify(await get(agent)));
        console.log("fresh-connection-after", JSON.stringify(await get(new https.Agent())));
      `) }]);
      const client = await s.runCommand({ cmd: "node", args: ["/tmp/keepalive.mjs"], detached: true });
      await sleep(4000);
      const t0 = performance.now();
      await s.update({ networkPolicy: { allow: { "github.com": both.allow["github.com"], "api.github.com": [] } } });
      log(`update removing only the api.github.com transform took ${Math.round(performance.now() - t0)}ms; read back`, (await Sandbox.get({ ...creds, name: s.name })).networkPolicy);
      await run(s, "touch", ["/tmp/flag"]);
      const done = await client.wait();
      log("keep-alive client", { exitCode: done.exitCode, stdout: await done.stdout(), stderr: await done.stderr() });
      log("github.com fetch after the api.github.com removal", await run(s, "sh", ["-c",
        `git init -q /tmp/w2 && cd /tmp/w2 && git fetch --no-tags https://github.com/${owner}/${repo} ${sha} 2>&1 | tail -2; git cat-file -t ${sha}`]));
      await s.update({ networkPolicy: { allow: { "github.com": [], "api.github.com": [] } } });
      log("github.com fetch after its own removal", await run(s, "sh", ["-c",
        `git init -q /tmp/w3 && cd /tmp/w3 && GIT_TERMINAL_PROMPT=0 git fetch --no-tags https://github.com/${owner}/${repo} ${sha} 2>&1 | tail -2`]));
    } finally {
      await stopQuietly(s);
    }
  },

  // What the dashboard's command history retains. Leaves the Sandbox stopped, not deleted.
  async history() {
    const s = await created(`p114-history-${stamp}`);
    try {
      log("argv/env/stdout markers", await run(s, "sh", ["-c", "echo STDOUT_MARKER_P114; echo STDERR_MARKER_P114 >&2; echo $SECRET_ENV"], {
        env: { SECRET_ENV: "ENV_MARKER_P114" },
      }));
      log("argv marker", await run(s, "echo", ["ARGV_MARKER_P114"]));
      await s.writeFiles([{ path: "/tmp/file-marker.txt", content: Buffer.from("FILE_CONTENT_MARKER_P114") }]);
      log("SDK file read", (await s.readFileToBuffer({ path: "/tmp/file-marker.txt" }))?.toString());
      log("NEXT", `Open the Vercel dashboard for sandbox ${s.name}, check which markers appear, then run: node phase-a.mjs history-delete ${s.name}`);
    } finally {
      await stopQuietly(s);
    }
  },

  async ["history-delete"](name) {
    const s = await Sandbox.get({ ...creds, name });
    await attempt("delete", () => s.delete());
    log("NEXT", `Re-check the dashboard for ${name}: is the command history gone?`);
  },
};

const [probe, ...args] = process.argv.slice(2);
if (!probes[probe]) {
  console.error(`probes: ${Object.keys(probes).join(", ")}`);
  process.exit(1);
}
await probes[probe](...args);
