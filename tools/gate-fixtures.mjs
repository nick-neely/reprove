/**
 * The fixtures the real-builder gate is built out of: a database of its own, a
 * clean build, the built application, a canned GitHub on loopback, and a signed
 * delivery to post at it.
 *
 * They live here rather than in `tools/verify-workflow-build.mjs` for the reason
 * `tools/workspaces.mjs` exists: a second reader needs the same arrangement, and
 * a second copy of it would drift. That reader is
 * [ADR 0016](../docs/adr/0016-phase-0-acceptance-scenario.md)'s acceptance
 * scenario, which is the **payload** of the same gate rather than a sibling of
 * it - "the Phase 0 exit is one fact and gets one signal" - and which needs
 * exactly this fixture: a built application serving over HTTP against real
 * Postgres behind real PgBouncer, with only GitHub substituted and only at the
 * transport.
 *
 * Nothing here asserts anything. The gate owns its `ok`/`FAIL` reporting and
 * its exit code; this module owns only what has to be stood up before there is
 * anything to assert about. A function here that fails throws, because a
 * fixture that could not be built is not a finding about the code under test.
 *
 * It needs the local database stack (`pnpm db:up`) and **Docker itself**, which
 * is how the stack is reached for the handful of statements run as the admin
 * role: the root workspace may depend on no Postgres driver (ADR 0010), so the
 * database is created and read through `psql` inside the stack's own container.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { bootstrap, migrate } from "@reprove/control-plane";

/** The repository root, as every path here is resolved against it. */
export const ROOT = path.resolve(import.meta.dirname, "..");
/** The application the gate builds, boots and drives. */
export const APP = path.join(ROOT, "apps", "control-plane");
const COMPOSE_FILE = path.join(ROOT, "tools", "db", "compose.yaml");

/** The local stack, as `tools/db/compose.yaml` publishes it. */
const ADMIN_HOST = "127.0.0.1:55532";
const RUNTIME_HOST = "127.0.0.1:56532";
/** The database that always exists, from which the gate's own is created. */
export const MAINTENANCE_DATABASE = "reprove";
/** Not a secret: both hops of the local stack authenticate with `trust`. */
const RUNTIME_PASSWORD = "local-development-only";
const RUNTIME_ROLE = "reprove_runtime";

/** The gate's own database, recreated on every run. */
export const DATABASE = "reprove_gate";

/** Where the built application listens. Override with `REPROVE_GATE_PORT`. */
export const PORT = Number(process.env.REPROVE_GATE_PORT ?? "3939");
if (!(Number.isInteger(PORT) && PORT > 0 && PORT < 65_536)) {
  // Refused here rather than ninety seconds later in `untilServing`, whose
  // timeout message would name a deadline instead of the mistake.
  throw new Error(
    `REPROVE_GATE_PORT is ${JSON.stringify(process.env.REPROVE_GATE_PORT)}, which is not a port`
  );
}

/**
 * The fixture's identities, which the canned GitHub, the signed delivery and
 * every readback all have to agree on.
 *
 * The webhook secret is an English phrase rather than anything with entropy in
 * it, because a committed file carrying a high-entropy literal is a secret as
 * far as scanning is concerned even when it is not one.
 */
export const WEBHOOK_SECRET = "a-webhook-secret-that-is-not-a-real-one";
export const APP_ID = "1234";
export const INSTALLATION_ID = 42;
export const OWNER_ID = 1001;
export const REPOSITORY_ID = 3001;
export const REPOSITORY_FULL_NAME = "acme/reprove";
export const PULL_REQUEST = 7;
export const HEAD_SHA = "b".repeat(40);
export const BASE_SHA = "a".repeat(40);

export const STARTUP_TIMEOUT_MS = 90_000;
/**
 * How long the acknowledgement of one signed delivery may take.
 *
 * The webhook verifies a signature, commits a ledger row and answers; ADR 0013
 * makes that the whole of the synchronous path. Generous against a cold route
 * compiled on its first request, and still far short of the five minutes
 * `fetch` would otherwise wait on a server that never answers.
 */
export const DELIVERY_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 500;

// --- the stack ---------------------------------------------------------------

/** The column separator `psql` is told to use: one no value here contains. */
const FIELD_SEPARATOR = "\t";

/**
 * One statement as the admin role, through the stack's own `psql`. Rows come
 * back one per line, columns tab-separated, which is all the gate reads.
 *
 * The statement is fed on standard input rather than through `-c`, because
 * `psql` performs variable interpolation only over input it lexes itself: a
 * `-c` string is handed to the server verbatim and `:'name'` reaches it as a
 * syntax error.
 *
 * @param {string} database The database to run against.
 * @param {string} statement The statement. It may reference a bound value as
 *   `:'name'`, which `psql` quotes as a literal, so no value the gate reads
 *   back out of a database is ever concatenated into SQL.
 * @param {Readonly<Record<string, string>>} [values] The bound values.
 * @returns {string[][]} The rows.
 */
export const psql = (database, statement, values = {}) =>
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      ...Object.entries(values).flatMap(([name, value]) => [
        "-v",
        `${name}=${value}`,
      ]),
      "-F",
      FIELD_SEPARATOR,
      "-tA",
    ],
    { encoding: "utf-8", input: statement, stdio: ["pipe", "pipe", "pipe"] }
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(FIELD_SEPARATOR));

/**
 * Refuses to run at all when the local stack is down.
 *
 * @throws {Error} Naming the command that starts it. There is nothing to skip
 *   to: the gate runs the built application against real Postgres behind real
 *   PgBouncer, so a skipped run would prove nothing.
 */
export const requireStack = () => {
  try {
    psql(MAINTENANCE_DATABASE, "select 1");
  } catch (error) {
    throw new Error(
      `The local database stack is not reachable through docker compose (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).\n` +
        "The real-builder gate runs the built application against real Postgres behind real\n" +
        "PgBouncer, so there is nothing to skip to. Start it with:\n\n" +
        "    pnpm db:up\n",
      { cause: error }
    );
  }
};

/**
 * The direct endpoint as the admin role, which owns the tables.
 *
 * @param {string} database The database.
 * @returns {string} The connection string.
 */
export const adminUrl = (database) =>
  `postgres://postgres@${ADMIN_HOST}/${database}`;

/**
 * The pooled endpoint as the restricted runtime role, which is what all
 * application traffic uses (ADR 0008).
 *
 * @param {string} database The database.
 * @returns {string} The connection string.
 */
export const runtimeUrl = (database) =>
  `postgres://${RUNTIME_ROLE}@${RUNTIME_HOST}/${database}`;

/**
 * A database of the gate's own, from a known-clean state however the last run
 * ended.
 *
 * @returns {Promise<void>} Once it is bootstrapped and migrated.
 */
export const recreateDatabase = async () => {
  psql(
    MAINTENANCE_DATABASE,
    `drop database if exists "${DATABASE}" with (force)`
  );
  psql(MAINTENANCE_DATABASE, `create database "${DATABASE}"`);
  await bootstrap({
    connectionString: adminUrl(DATABASE),
    runtimePassword: RUNTIME_PASSWORD,
  });
  await migrate({ connectionString: adminUrl(DATABASE) });
};

/**
 * The World's own schema. `@workflow/world-postgres` does not migrate on
 * first use; its `bootstrap` bin does, and it is resolved from the app because
 * the app is the workspace that depends on the World (ADR 0014).
 *
 * @throws {Error} When the World ships no bootstrap bin where one is expected.
 */
export const bootstrapWorld = () => {
  const appRequire = createRequire(path.join(APP, "package.json"));
  const worldEntry = appRequire.resolve("@workflow/world-postgres");
  const setup = path.join(path.dirname(worldEntry), "..", "bin", "setup.js");
  if (!existsSync(setup)) {
    throw new Error(`the World's bootstrap bin is not at ${setup}`);
  }
  execFileSync(process.execPath, [setup], {
    cwd: APP,
    env: { ...process.env, WORKFLOW_POSTGRES_URL: adminUrl(DATABASE) },
    stdio: ["ignore", "pipe", "pipe"],
  });
};

/**
 * Drops the gate's database, ignoring a stack that has already gone.
 *
 * @returns {void}
 */
export const dropDatabase = () => {
  try {
    psql(
      MAINTENANCE_DATABASE,
      `drop database if exists "${DATABASE}" with (force)`
    );
  } catch {
    // The stack is down, which is what the failure being reported already says.
    // The next run recreates this database from a known-clean state regardless.
  }
};

// --- the build ---------------------------------------------------------------

const nextBin = () => path.join(APP, "node_modules", ".bin", "next");

/**
 * Builds `apps/control-plane` from clean, which is where the builder's own
 * plugin refuses a Node built-in reached from a workflow body.
 *
 * @throws {Error} Carrying the tail of the build's own output.
 */
export const buildFromClean = () => {
  // The generated workflow routes are stale-prone across builds, and a stale
  // artifact silently invalidates every check below.
  rmSync(path.join(APP, ".next"), { recursive: true, force: true });
  // Only the generated tree. `.well-known` is a route namespace an application
  // is entitled to put committed source in, and this runs on a working copy.
  rmSync(path.join(APP, "src", "app", ".well-known", "workflow"), {
    recursive: true,
    force: true,
  });
  const built = spawnSync(nextBin(), ["build"], {
    cwd: APP,
    encoding: "utf-8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    timeout: 600_000,
  });
  if (built.status !== 0) {
    throw new Error(
      `next build failed:\n${`${built.stdout}\n${built.stderr}`.trim().slice(-4000)}`
    );
  }
};

// --- the run -----------------------------------------------------------------

/**
 * GitHub, on loopback. The App JWT, the installation-token exchange, the
 * request line and the response parsing all execute for real inside the built
 * application; what is canned is the two bodies.
 *
 * @returns {Promise<{url: string, seen: string[], close: () => Promise<void>}>}
 *   Where it listens, the request lines it has been sent, and how to stop it.
 */
export const startCannedGitHub = async () => {
  const seen = [];
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    seen.push(`${method} ${url}`);
    request.resume();
    request.on("end", () => {
      const answer = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (method === "POST" && url.endsWith("/access_tokens")) {
        answer(201, {
          token: "ghs_a_token",
          expires_at: "2026-02-01T13:00:00Z",
        });
        return;
      }
      if (method === "GET" && url.endsWith(`/pulls/${PULL_REQUEST}`)) {
        answer(200, {
          number: PULL_REQUEST,
          state: "open",
          draft: false,
          head: { sha: HEAD_SHA, repo: { id: REPOSITORY_ID } },
          base: { sha: BASE_SHA, repo: { id: REPOSITORY_ID } },
          user: { id: 5005 },
          author_association: "MEMBER",
        });
        return;
      }
      answer(404, { message: `no canned answer for ${method} ${url}` });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  /*
   * SAFETY: `listen(0)` on a TCP host always yields an `AddressInfo`. The union
   * in the type is for the Unix-socket form this never uses, and a wrong port
   * would fail on the first request rather than pass quietly.
   */
  /** @type {import("node:net").AddressInfo} */
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

/**
 * The App's private key, generated per run rather than committed: a PEM in the
 * repository is a secret as far as scanning is concerned, and nothing here
 * needs the same key twice.
 *
 * @returns {string} A PKCS#8 PEM.
 */
export const privateKey = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();

/**
 * One `pull_request` delivery, signed the way GitHub signs one: an HMAC over
 * the exact bytes that go on the wire.
 *
 * @returns {{body: Buffer, headers: Record<string, string>}} The bytes and the
 *   headers that carry them.
 */
export const signedDelivery = () => {
  const body = Buffer.from(
    JSON.stringify({
      action: "opened",
      number: PULL_REQUEST,
      installation: { id: INSTALLATION_ID },
      repository: {
        id: REPOSITORY_ID,
        full_name: REPOSITORY_FULL_NAME,
        owner: { id: OWNER_ID, login: "acme", type: "Organization" },
      },
      pull_request: { number: PULL_REQUEST, head: { sha: HEAD_SHA } },
    })
  );
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "real-builder-gate",
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
  };
};

/**
 * Starts the built application against the gate's database and the Postgres
 * World, with the environment the app's README names and nothing else.
 *
 * @param {string} githubUrl Where the canned GitHub listens.
 * @param {string} key The App's private key, PEM-encoded.
 * @returns {{origin: string, log: () => string, stop: () => Promise<void>}} Where
 *   it serves, what it has said, and how to stop it and everything it forked.
 */
export const startBuiltApp = (githubUrl, key) => {
  const origin = `http://127.0.0.1:${PORT}`;
  const server = spawn(nextBin(), ["start", "-p", String(PORT)], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(PORT),
      NEXT_TELEMETRY_DISABLED: "1",
      REPROVE_DATABASE_URL: runtimeUrl(DATABASE),
      REPROVE_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      REPROVE_GITHUB_APP_ID: APP_ID,
      REPROVE_GITHUB_PRIVATE_KEY: key,
      REPROVE_GITHUB_API_URL: githubUrl,
      WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
      WORKFLOW_POSTGRES_URL: adminUrl(DATABASE),
      WORKFLOW_LOCAL_BASE_URL: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the signals below reach the render workers
    // `next start` forks as well as the process this spawned. Killing only the
    // direct child leaves a worker holding the port for the next run.
    detached: true,
  });
  let log = "";
  server.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  server.stderr.on("data", (chunk) => {
    log += String(chunk);
  });
  // A spawn that never starts - no `next` binary, no permission - emits `error`
  // asynchronously, and an unhandled one is an uncaught exception outside every
  // `try` in the gate, so nothing would be torn down. Recorded like any other
  // failure and left to `untilServing` to report.
  server.on("error", (error) => {
    log += `spawn failed: ${error.message}\n`;
  });
  /**
   * Signals the whole group, ignoring the case where it has already gone.
   *
   * @param {NodeJS.Signals} signal The signal.
   */
  const signalGroup = (signal) => {
    try {
      process.kill(-(server.pid ?? 0), signal);
    } catch {
      // Already reaped, or never started.
    }
  };
  return {
    origin,
    log: () => log.slice(-4000),
    stop: async () => {
      if (server.exitCode !== null || server.pid === undefined) {
        return;
      }
      signalGroup("SIGTERM");
      const abandon = new AbortController();
      await Promise.race([
        once(server, "exit"),
        // Aborted on a clean exit, so a five-second timer does not keep the
        // event loop referenced after the gate is done.
        sleep(5000, undefined, { signal: abandon.signal }).catch(() => {
          // Aborted, which is the good case.
        }),
      ]);
      abandon.abort();
      if (server.exitCode === null) {
        signalGroup("SIGKILL");
        await Promise.race([once(server, "exit"), sleep(2000)]);
      }
    },
  };
};

/*
 * The wait below polls: each pass reads what the last one changed, so the
 * `await` inside the loop is the design rather than a `Promise.all` someone
 * forgot. There is nothing to run in parallel with a deadline.
 */
/* oxlint-disable no-await-in-loop */

/**
 * Waits for the built application to answer at all.
 *
 * @param {string} origin Where it should be serving.
 * @returns {Promise<void>} Once it does.
 * @throws {Error} Naming the deadline, when it never does.
 */
export const untilServing = async (origin) => {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Bounded by what is left of the deadline, because the loop only checks
      // it between passes: `fetch` waits five minutes for response headers by
      // default, so a server that accepts the connection and then says nothing
      // would hold this probe open long past the failure it is meant to report.
      const response = await fetch(origin, {
        signal: AbortSignal.timeout(deadline - Date.now()),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `the built application did not serve within ${STARTUP_TIMEOUT_MS}ms`
  );
};
