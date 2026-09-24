// PROTOTYPE for #114. Throwaway, never merged.
// Shared plumbing: credentials, a spend ledger, and state printing.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dns from "node:dns";

// This host's AAAA lookups time out after 5s; force IPv4 so local timings are not polluted.
const lookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === "function") [cb, opts] = [opts, {}];
  if (typeof opts === "number") opts = { family: opts };
  return lookup(host, { ...opts, family: 4 }, cb);
};

export const CONFIG_DIR = join(homedir(), ".config", "reprove-proto-114");
const APP_DIR = join(homedir(), ".config", "reprove-proto-111");
const LEDGER = new URL("./out/ledger.jsonl", import.meta.url);

// Reads KEY=value lines from ~/.config/reprove-proto-114/env into process.env.
export function loadEnv() {
  const path = join(CONFIG_DIR, "env");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

// Vercel credentials: VERCEL_TOKEN (or the CLI's login token), VERCEL_TEAM_ID,
// VERCEL_PROJECT_ID. Returned as the explicit Credentials the SDK accepts.
export function vercelCredentials() {
  loadEnv();
  let token = process.env.VERCEL_TOKEN;
  if (!token) {
    const auth = join(homedir(), ".local/share/com.vercel.cli/auth.json");
    if (existsSync(auth)) token = JSON.parse(readFileSync(auth, "utf8")).token;
  }
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) {
    throw new Error(
      `Need VERCEL_TOKEN (or vercel login), VERCEL_TEAM_ID, VERCEL_PROJECT_ID in ${CONFIG_DIR}/env`,
    );
  }
  return { token, teamId, projectId };
}

// A read-only installation token for the fixture repository, narrowed by
// repository id and permission, as ADR 0024 prescribes for a Pass.
export async function fixtureToken() {
  const { createAppAuth } = await import("@octokit/auth-app");
  const config = JSON.parse(readFileSync(join(APP_DIR, "config.json"), "utf8"));
  const auth = createAppAuth({
    appId: config.appId,
    privateKey: readFileSync(join(APP_DIR, "app.pem"), "utf8"),
  });
  const { token, expiresAt } = await auth({
    type: "installation",
    installationId: config.installationId,
    repositoryNames: [config.repo],
    permissions: { contents: "read" },
  });
  return { token, expiresAt, owner: config.owner, repo: config.repo };
}

export function log(label, value) {
  const at = new Date().toISOString();
  process.stdout.write(`\n[${at}] ${label}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

export function describeError(error) {
  return {
    name: error?.name,
    message: error?.message,
    status: error?.response?.status,
    json: error?.json,
    text: typeof error?.text === "string" ? error.text.slice(0, 500) : undefined,
  };
}

// Records every Sandbox and Provider spend so the 80% stop can be checked.
export function ledger(entry) {
  appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function sandboxFacts(sandbox) {
  return {
    name: sandbox.name,
    sessionId: sandbox.currentSession().sessionId,
    status: sandbox.status,
    persistent: sandbox.persistent,
    createdAt: sandbox.createdAt,
    expiresAt: sandbox.expiresAt,
    timeout: sandbox.timeout,
    vcpus: sandbox.vcpus,
    memory: sandbox.memory,
    region: sandbox.region,
    networkPolicy: sandbox.networkPolicy,
    activeCpuUsageMs: sandbox.activeCpuUsageMs,
    totalDurationMs: sandbox.totalDurationMs,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
