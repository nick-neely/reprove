// Throwaway. Shared plumbing for the issue #111 live-App experiments: config,
// App authentication, installation lookup, argument parsing and a request
// wrapper that can print instead of send.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const CONFIG_DIR = join(homedir(), ".config", "reprove-proto-111");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const PEM_PATH = join(CONFIG_DIR, "app.pem");

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export async function readConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, "utf8");
  } catch {
    fail(
      `No config at ${CONFIG_PATH}. Write {"appId","installationId"?,"smeeUrl","owner","repo"} there and put the App private key at ${PEM_PATH}.`,
    );
  }
  const config = JSON.parse(raw);
  for (const key of ["appId", "owner", "repo"]) {
    if (!config[key]) {
      fail(`${CONFIG_PATH} is missing "${key}".`);
    }
  }
  return config;
}

async function writeConfig(config) {
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

async function readPem() {
  try {
    return await readFile(PEM_PATH, "utf8");
  } catch {
    return fail(`No App private key at ${PEM_PATH}.`);
  }
}

async function octokitFor(auth) {
  const { Octokit } = await import("@octokit/rest");
  return new Octokit(auth);
}

// An Octokit authenticated as the App itself (JWT). Only the installation
// lookup and the App's own metadata need it.
export async function appClient(config) {
  const { createAppAuth } = await import("@octokit/auth-app");
  return octokitFor({
    authStrategy: createAppAuth,
    auth: { appId: config.appId, privateKey: await readPem() },
  });
}

// An Octokit authenticated as the installation, plus the installation id it
// resolved. The id is cached back into config.json so the lookup happens once.
export async function installationClient(config) {
  let installationId = config.installationId;
  if (!installationId) {
    const app = await appClient(config);
    const { data } = await app.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner: config.owner, repo: config.repo },
    );
    installationId = data.id;
    await writeConfig({ ...config, installationId });
    process.stderr.write(
      `Resolved installationId ${installationId} and cached it into ${CONFIG_PATH}.\n`,
    );
  }
  const { createAppAuth } = await import("@octokit/auth-app");
  const octokit = await octokitFor({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: await readPem(),
      installationId,
    },
  });
  return { octokit, installationId };
}

// The one seam every experiment goes through, so --dry-run needs no
// credentials: it prints the request it would have sent and returns nothing.
export function requester({ dryRun }) {
  if (dryRun) {
    return {
      dryRun: true,
      async request(route, params) {
        const { owner, repo, ...rest } = params ?? {};
        process.stdout.write(
          `${JSON.stringify({ dryRun: true, route, owner, repo, params: rest }, null, 2)}\n`,
        );
        return { data: null };
      },
    };
  }
  let pending;
  return {
    dryRun: false,
    async request(route, params) {
      pending ??= (async () => {
        const config = await readConfig();
        const { octokit } = await installationClient(config);
        return { config, octokit };
      })();
      const { config, octokit } = await pending;
      return octokit.request(route, {
        owner: config.owner,
        repo: config.repo,
        ...params,
      });
    },
  };
}

// In dry-run mode there is no repository to read from config, so the printed
// request still names one.
export async function repoSlug({ dryRun }) {
  if (dryRun) {
    return { owner: "<owner>", repo: "<repo>" };
  }
  const config = await readConfig();
  return { owner: config.owner, repo: config.repo };
}

export function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function parse(argv, options, { usage, commands, allowEmpty }) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  if (command === undefined && !allowEmpty) {
    process.stdout.write(`${usage}\n`);
    process.exit(1);
  }
  if (commands && !commands.includes(command)) {
    process.stderr.write(`Unknown command "${command}".\n\n${usage}\n`);
    process.exit(1);
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: commands ? rest : argv,
      options: { ...options, "dry-run": { type: "boolean" }, help: { type: "boolean" } },
      allowPositionals: false,
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage}\n`);
    process.exit(1);
  }
  if (values.help) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  return { command: commands ? command : undefined, values, dryRun: values["dry-run"] === true };
}

export function require_(values, keys, usage) {
  for (const key of keys) {
    if (values[key] === undefined) {
      process.stderr.write(`Missing --${key}.\n\n${usage}\n`);
      process.exit(1);
    }
  }
}
