#!/usr/bin/env node
/**
 * The real-builder workflow check
 * [ADR 0014](../docs/adr/0014-workflow-orchestration-seam.md) mandates.
 *
 * It protects **observable execution**, not the current artifact shape. The
 * build behaviour the orchestration seam depends on is undocumented and
 * version-specific: a module-scope helper called from a workflow body drags its
 * whole transitive graph into the workflow bundle, which runs in a VM with no
 * `require`, so every workflow in the application breaks at runtime with an
 * error naming an innocent one - while the build stays green. A rule someone
 * has to remember is not sufficient for a failure with that shape, so this
 * builds from clean and then runs what it built:
 *
 * ```text
 * a database of the gate's own, bootstrapped and migrated, plus the World's schema
 *   -> next build, from clean, which is where the builder's own plugin refuses
 *      a Node built-in reached from a workflow body
 *   -> the workflow bundle exists and names no module but the workflow runtime
 *   -> the output trace carries what the steps need: pg, and the migrations
 *   -> next start
 *   -> a signed delivery, against a canned GitHub on loopback
 *   -> the Run is queued and records a lifecycle that is running in the World
 * ```
 *
 * Absence fails. A check that passes when it cannot find what it inspects
 * protects nothing, so a missing artifact or trace is a failure rather than a
 * note. It deliberately asserts **no bundle size** and no other property of
 * today's output: the SDK promises workflow-mode transformation and dead-code
 * elimination, not one shared bundle or its externalization behaviour, and
 * canonising today's output would make this brittle against a dependency
 * upgrade while protecting nothing extra. The runtime execution is the check
 * that survives such an upgrade.
 *
 * It needs the local database stack (`pnpm db:up`) and Docker, which is how the
 * stack is reached for the handful of statements this file runs as the admin
 * role: the root workspace may depend on no Postgres driver (ADR 0010), so the
 * database is created and read through `psql` inside the stack's own container.
 * It fails with instructions rather than skipping when the stack is down.
 *
 * Run as `node tools/verify-workflow-build.mjs`, after `turbo run build` has
 * produced every package's `dist`. `--keep` leaves the gate's database and the
 * built application in place for inspection.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { bootstrap, migrate } from "@reprove/control-plane";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP = path.join(ROOT, "apps", "control-plane");
const COMPOSE_FILE = path.join(ROOT, "tools", "db", "compose.yaml");

/** The local stack, as `tools/db/compose.yaml` publishes it. */
const ADMIN_HOST = "127.0.0.1:55532";
const RUNTIME_HOST = "127.0.0.1:56532";
const MAINTENANCE_DATABASE = "reprove";
/** Not a secret: both hops of the local stack authenticate with `trust`. */
const RUNTIME_PASSWORD = "local-development-only";
const RUNTIME_ROLE = "reprove_runtime";

/** The gate's own database, recreated on every run. */
const DATABASE = "reprove_gate";

/** Where the built application listens. Override with `REPROVE_GATE_PORT`. */
const PORT = Number(process.env.REPROVE_GATE_PORT ?? "3939");
if (!(Number.isInteger(PORT) && PORT > 0 && PORT < 65_536)) {
  // Refused here rather than ninety seconds later in `untilServing`, whose
  // timeout message would name a deadline instead of the mistake.
  throw new Error(
    `REPROVE_GATE_PORT is ${JSON.stringify(process.env.REPROVE_GATE_PORT)}, which is not a port`
  );
}

/** The generated workflow route, as the Workflow build writes it into the app tree. */
const FLOW_ROUTE = path.join(
  APP,
  "src",
  "app",
  ".well-known",
  "workflow",
  "v1",
  "flow",
  "route.js"
);

/**
 * The routes that compose the control plane, and whose output trace therefore
 * has to carry what its steps need. The flow route is deliberately absent: the
 * workflow bundle needs nothing, which the bundle check asserts directly.
 */
const TRACED_ROUTES = ["api/github/webhook", ".well-known/workflow/v1/step"];

/**
 * What the steps need shipped, as fragments of a traced path.
 *
 * The journal alone is not enough: the boot assertion joins the hashes Drizzle
 * stored against the `.sql` files that produced them, so a trace carrying the
 * index and none of what it indexes would pass while a deployment refused to
 * boot. `0001_` is named because migration history is append-only, so the first
 * migration is the one file that is always there.
 */
const REQUIRED_IN_TRACE = {
  "the Postgres driver": "/node_modules/pg/",
  "the migration journal": "/drizzle/meta/_journal.json",
  "the first migration": "/drizzle/0001_",
};

const WEBHOOK_SECRET = "a-webhook-secret-that-is-not-a-real-one";
const APP_ID = "1234";
const OWNER_ID = 1001;
const REPOSITORY_ID = 3001;
const PULL_REQUEST = 7;
const HEAD_SHA = "b".repeat(40);
const BASE_SHA = "a".repeat(40);

const STARTUP_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 90_000;
/**
 * How long the acknowledgement of one signed delivery may take.
 *
 * The webhook verifies a signature, commits a ledger row and answers; ADR 0013
 * makes that the whole of the synchronous path. Generous against a cold route
 * compiled on its first request, and still far short of the five minutes
 * `fetch` would otherwise wait on a server that never answers.
 */
const DELIVERY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const BARE_REQUIRE = /\brequire\(\s*["'](?<specifier>[^"'./][^"']*)["']\s*\)/gu;
const STATIC_IMPORT =
  /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["'](?<specifier>[^"']+)["']/gmu;
const BARE_IMPORT = /^\s*import\s*["'](?<specifier>[^"'./][^"']*)["']/gmu;
/**
 * `import("pg")`, which the three patterns above all miss. A workflow body that
 * reaches a driver behind an `await import(...)` compiles cleanly and fails
 * only when the VM evaluates that path, which is exactly the arrangement this
 * check exists to catch. A computed specifier is not matched and cannot be: a
 * literal is what a bundle names.
 */
const DYNAMIC_IMPORT =
  /\bimport\s*\(\s*["'](?<specifier>[^"'./][^"']*)["']\s*\)/gu;

/**
 * The module specifiers a workflow bundle reaches for that are not the
 * workflow runtime itself.
 *
 * The bundle may import `workflow` and its `@workflow/*` family, because that
 * is the runtime it is compiled against and runs inside. Anything else - a Node
 * built-in, a Postgres driver, one of Reprove's own packages - is a module the
 * VM cannot load, and its presence means a workflow body reached code that
 * only a step may reach.
 *
 * **Where the teeth actually are, measured against `workflow@4.8.5`.** The
 * builder deliberately compiles a workflow bundle with no `external` list,
 * precisely because the VM has no `require`, so today's output inlines its
 * whole graph and names almost nothing. What refuses a Node built-in is the
 * builder's own plugin, which fails `next build` - and this gate builds from
 * clean, so that refusal is a gate failure rather than a lint someone might
 * skip. This check is the **backstop for the other arrangement**: a builder
 * version that emits externals instead, where the same defect would compile
 * cleanly and break in the VM. It is written over specifiers rather than over
 * a chunk layout for the same reason ADR 0014 forbids asserting bundle size.
 *
 * @param {string} source The bundle's text.
 * @returns {string[]} Every offending specifier, deduplicated and sorted.
 */
export const foreignSpecifiers = (source) => {
  const specifiers = new Set();
  for (const pattern of [
    BARE_REQUIRE,
    STATIC_IMPORT,
    BARE_IMPORT,
    DYNAMIC_IMPORT,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match.groups?.specifier;
      if (specifier && !specifier.startsWith(".")) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers]
    .filter(
      (specifier) =>
        !(
          specifier === "workflow" ||
          specifier.startsWith("workflow/") ||
          specifier.startsWith("@workflow/")
        )
    )
    .toSorted();
};

/**
 * Which of the required paths a trace's file list lacks.
 *
 * @param {readonly string[]} files The `files` of an `.nft.json`.
 * @param {Readonly<Record<string, string>>} required What must be present, by
 *   the name a failure prints, as a path fragment.
 * @returns {string[]} The names of what is missing.
 */
export const missingFromTrace = (files, required) =>
  Object.entries(required)
    .filter(([, fragment]) => !files.some((file) => file.includes(fragment)))
    .map(([name]) => name);

// --- the stack ---------------------------------------------------------------

/** The column separator `psql` is told to use: one no value here contains. */
const FIELD_SEPARATOR = "\t";

/**
 * One statement as the admin role, through the stack's own `psql`. Rows come
 * back one per line, columns tab-separated, which is all this file reads.
 *
 * The statement is fed on standard input rather than through `-c`, because
 * `psql` performs variable interpolation only over input it lexes itself: a
 * `-c` string is handed to the server verbatim and `:'name'` reaches it as a
 * syntax error.
 *
 * @param {string} database The database to run against.
 * @param {string} statement The statement. It may reference a bound value as
 *   `:'name'`, which `psql` quotes as a literal, so no value this file reads
 *   back out of a database is ever concatenated into SQL.
 * @param {Readonly<Record<string, string>>} [values] The bound values.
 * @returns {string[][]} The rows.
 */
const psql = (database, statement, values = {}) =>
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

const requireStack = () => {
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

const adminUrl = (database) => `postgres://postgres@${ADMIN_HOST}/${database}`;
const runtimeUrl = (database) =>
  `postgres://${RUNTIME_ROLE}@${RUNTIME_HOST}/${database}`;

/** A database of the gate's own, from a known-clean state however the last run ended. */
const recreateDatabase = async () => {
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
 */
const bootstrapWorld = () => {
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

// --- the build ---------------------------------------------------------------

const nextBin = () => path.join(APP, "node_modules", ".bin", "next");

const buildFromClean = () => {
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

const traceFile = (route) =>
  path.join(APP, ".next", "server", "app", route, "route.js.nft.json");

// --- the run -----------------------------------------------------------------

/**
 * GitHub, on loopback. The App JWT, the installation-token exchange, the
 * request line and the response parsing all execute for real inside the built
 * application; what is canned is the two bodies.
 */
const startCannedGitHub = async () => {
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

const privateKey = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();

const signedDelivery = () => {
  const body = Buffer.from(
    JSON.stringify({
      action: "opened",
      number: PULL_REQUEST,
      installation: { id: 42 },
      repository: {
        id: REPOSITORY_ID,
        full_name: "acme/reprove",
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
 */
const startBuiltApp = (githubUrl, key) => {
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
  // `try` here, so nothing would be torn down. Recorded like any other failure
  // and left to `untilServing` to report.
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
 * The two waits below poll: each pass reads what the last one changed, so the
 * `await` inside the loop is the design rather than a `Promise.all` someone
 * forgot. There is nothing to run in parallel with a deadline.
 */
/* oxlint-disable no-await-in-loop */

const untilServing = async (origin) => {
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

/**
 * Waits for the delivery to become a queued Run with a recorded lifecycle,
 * which is what says the ingress workflow executed for real: it took the
 * lock, fetched canonical state, created the Run, started the lifecycle and
 * won the race to record it.
 */
const untilRunScheduled = async () => {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = psql(
      DATABASE,
      "select status, coalesce(workflow_run_id, '') from run"
    );
    if (row && row[0] === "queued" && row[1] !== "") {
      return { status: row[0], workflowRunId: row[1] };
    }
    if (row && row[0] !== "queued") {
      throw new Error(
        `the Run reached ${row[0]} rather than staying claimable`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const [ledger] = psql(
    DATABASE,
    "select state, coalesce(retry_class, ''), attempt_count from ingress_delivery"
  );
  throw new Error(
    `no queued Run with a recorded lifecycle appeared within ${RUN_TIMEOUT_MS}ms; the ledger row reads ${JSON.stringify(ledger ?? null)}`
  );
};

// --- the gate ----------------------------------------------------------------

const keep = process.argv.includes("--keep");
let failures = 0;
const ok = (message) => {
  process.stdout.write(`  ok    ${message}\n`);
};
const bad = (message) => {
  failures += 1;
  process.stdout.write(`  FAIL  ${message}\n`);
};

const checkBundle = () => {
  if (!existsSync(FLOW_ROUTE)) {
    bad(
      `${path.relative(ROOT, FLOW_ROUTE)} was not emitted; the gate cannot inspect what it must protect`
    );
    return;
  }
  const foreign = foreignSpecifiers(readFileSync(FLOW_ROUTE, "utf-8"));
  if (foreign.length === 0) {
    ok("the workflow bundle names no module but the workflow runtime");
  } else {
    bad(
      `the workflow bundle reaches modules the workflow VM cannot load: ${foreign.join(", ")}. A workflow body reached code only a step may reach.`
    );
  }
};

const checkTraces = () => {
  for (const route of TRACED_ROUTES) {
    const file = traceFile(route);
    if (!existsSync(file)) {
      bad(
        `no output trace at ${path.relative(ROOT, file)}; the gate cannot verify what ships for /${route}`
      );
      continue;
    }
    // SAFETY: `.nft.json` is Next's own output, `{ version, files: string[] }`,
    // and a malformed one fails here rather than passing quietly.
    const { files } = JSON.parse(readFileSync(file, "utf-8"));
    const missing = missingFromTrace(files, REQUIRED_IN_TRACE);
    if (missing.length === 0) {
      ok(
        `the output trace for /${route} carries ${Object.keys(REQUIRED_IN_TRACE).join(" and ")}`
      );
    } else {
      bad(
        `the output trace for /${route} omits ${missing.join(" and ")}; a deployment would be missing it`
      );
    }
  }
};

const checkExecution = async () => {
  const github = await startCannedGitHub();
  const app = startBuiltApp(github.url, privateKey());
  try {
    await untilServing(app.origin);
    ok("the built application serves");

    const delivery = signedDelivery();
    const response = await fetch(`${app.origin}/api/github/webhook`, {
      method: "POST",
      headers: delivery.headers,
      body: delivery.body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      bad(
        `the webhook answered ${response.status} ${await response.text()}. Server said: ${app.log()}`
      );
      return;
    }
    ok("a signed delivery was acknowledged");

    const scheduled = await untilRunScheduled();
    ok(
      `the delivery became a queued Run that records lifecycle ${scheduled.workflowRunId}`
    );

    const [ledger] = psql(DATABASE, "select state from ingress_delivery");
    if (ledger?.[0] === "done") {
      ok("the ledger row settled done, by the ingress workflow");
    } else {
      bad(`the ledger row reads ${ledger?.[0] ?? "nothing"} rather than done`);
    }

    // `workflow.workflow_runs` names its primary key `id`; the World's own
    // schema reserves `run_id` for the tables that point at a run.
    const [lifecycle] = psql(
      DATABASE,
      "select status from workflow.workflow_runs where id = :'lifecycle'",
      { lifecycle: scheduled.workflowRunId }
    );
    if (lifecycle?.[0] === "running") {
      ok(
        "the lifecycle is a running durable run in the World, asleep toward the deadline"
      );
    } else {
      bad(
        `the World records the lifecycle as ${lifecycle?.[0] ?? "nothing"} rather than running`
      );
    }

    if (!github.seen.some((line) => line.endsWith(`/pulls/${PULL_REQUEST}`))) {
      bad("the built application never fetched canonical state from GitHub");
    }
  } catch (error) {
    bad(
      `${error instanceof Error ? error.message : String(error)}\nServer said: ${app.log()}`
    );
  } finally {
    // Settled rather than sequenced: a `stop()` that rejects must not leave the
    // canned server listening, whose open handle would hang the gate instead of
    // letting it exit.
    await Promise.allSettled([app.stop(), github.close()]);
  }
};

const dropDatabase = () => {
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

const run = async () => {
  process.stdout.write("\nReal-builder workflow gate\n\n");
  requireStack();
  await recreateDatabase();
  bootstrapWorld();
  ok(
    `database ${DATABASE} bootstrapped, migrated, and carrying the World's schema`
  );

  buildFromClean();
  ok("built from clean");

  checkBundle();
  checkTraces();
  if (failures === 0) {
    await checkExecution();
  } else {
    // Not a failure of its own: the count below names what actually broke.
    process.stdout.write(
      "  ----  skipped executing a workflow: the artifact checks above already failed\n"
    );
  }

  if (failures === 0) {
    process.stdout.write(
      "\nWorkflow build gate holds: a clean build executes the durable spine end to end.\n"
    );
    return;
  }
  process.stdout.write(`\n${failures} workflow build gate failure(s).\n`);
  process.exitCode = 1;
};

/**
 * The gate, and the database it owns either way. A build that throws left the
 * database behind before this wrapper existed, which contradicts `--keep` being
 * the thing that leaves state to inspect.
 */
const main = async () => {
  try {
    await run();
  } finally {
    if (!keep) {
      dropDatabase();
    }
  }
};

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `\n${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
