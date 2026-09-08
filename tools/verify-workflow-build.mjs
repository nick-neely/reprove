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
 * The fixture half of it - the gate's database, the clean build, the built
 * application, the canned GitHub and the signed delivery - is
 * `tools/gate-fixtures.mjs`, because ADR 0016's acceptance scenario is the
 * **payload** of this gate rather than a sibling of it and needs the same
 * arrangement. What stays here is what this file asserts.
 *
 * It needs the local database stack (`pnpm db:up`) and Docker, which is how the
 * stack is reached for the handful of statements the fixtures run as the admin
 * role: the root workspace may depend on no Postgres driver (ADR 0010), so the
 * database is created and read through `psql` inside the stack's own container.
 * It fails with instructions rather than skipping when the stack is down.
 *
 * Run as `node tools/verify-workflow-build.mjs`, after `turbo run build` has
 * produced every package's `dist`. `--keep` leaves the gate's database and the
 * built application in place for inspection.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import {
  APP,
  bootstrapWorld,
  buildFromClean,
  DATABASE,
  DELIVERY_TIMEOUT_MS,
  dropDatabase,
  POLL_INTERVAL_MS,
  privateKey,
  psql,
  PULL_REQUEST,
  recreateDatabase,
  requireStack,
  ROOT,
  signedDelivery,
  startBuiltApp,
  startCannedGitHub,
  untilServing,
} from "./gate-fixtures.mjs";

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
 * has to carry what its steps need. The two Worker routes are here for the same
 * reason the webhook is: they reach the same composition, so a deployment that
 * shipped either without the driver or the migration folder would answer every
 * claim and every Result with a boot refusal. The flow route is deliberately
 * absent: the workflow bundle needs nothing, which the bundle check asserts
 * directly.
 *
 * The result route is dynamic, and its trace is written under the literal
 * segment Next names it by, brackets and all.
 */
const TRACED_ROUTES = [
  "api/github/webhook",
  "api/worker/runs/claim",
  "api/worker/runs/[runId]/result",
  ".well-known/workflow/v1/step",
];

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

const RUN_TIMEOUT_MS = 90_000;

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
 * The harness stack, as names that must not appear anywhere in the workflow
 * bundle.
 *
 * `foreignSpecifiers` above is the check for a module the VM would have to
 * *load*; this is the check for one it has already **inlined**. The builder
 * compiles the workflow bundle with no `external` list, so a workflow body that
 * reached the hosted placement would not name a specifier at all - it would
 * carry `@reprove/worker-core`'s code, and `@reprove/adapters`' beneath it,
 * with no import for the pattern above to find. Each package names itself in
 * its own source (`packageName`, the composition constants), so the names are
 * what survives inlining and minification alike.
 *
 * This is ADR 0010's "no harness stack in the control-plane deployment" at the
 * one place the build can prove it. **What it does not prove**: the route
 * bundles of the application in this repository, which *is* the hosted topology
 * and does reach the harness stack through `@reprove/worker-hosted` - that is
 * what a hosted deployment is for. The self-hosted claim is a claim about the
 * package graph, and `tools/verify-workspace.mjs`'s `harness-reach` rule is
 * what holds it: the app reaches `worker-core` only through `worker-hosted`,
 * and the control plane cannot reach it at all.
 */
const HARNESS_NAMES = [
  "@reprove/worker-core",
  "@reprove/worker-hosted",
  "@reprove/adapters",
  "@reprove/sandbox-container",
  "@ai-sdk/",
];

/**
 * Which harness names a bundle carries.
 *
 * @param {string} source The bundle's text.
 * @returns {string[]} Every harness name present, in the order declared.
 */
export const harnessNames = (source) =>
  HARNESS_NAMES.filter((name) => source.includes(name));

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

const traceFile = (route) =>
  path.join(APP, ".next", "server", "app", route, "route.js.nft.json");

/*
 * The wait below polls: each pass reads what the last one changed, so the
 * `await` inside the loop is the design rather than a `Promise.all` someone
 * forgot. There is nothing to run in parallel with a deadline.
 */
/* oxlint-disable no-await-in-loop */

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
  const bundle = readFileSync(FLOW_ROUTE, "utf-8");
  const foreign = foreignSpecifiers(bundle);
  if (foreign.length === 0) {
    ok("the workflow bundle names no module but the workflow runtime");
  } else {
    bad(
      `the workflow bundle reaches modules the workflow VM cannot load: ${foreign.join(", ")}. A workflow body reached code only a step may reach.`
    );
  }

  const harness = harnessNames(bundle);
  if (harness.length === 0) {
    ok("the workflow bundle carries no harness code, inlined or imported");
  } else {
    bad(
      `the workflow bundle carries the harness stack: ${harness.join(", ")}. A workflow body reached the hosted placement, which only a step may reach (ADR 0010).`
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
