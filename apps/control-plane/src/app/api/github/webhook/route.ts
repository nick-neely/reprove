/**
 * `POST /api/github/webhook`, which is the App's single hook URL.
 *
 * This file is route wiring and environment parsing, which is all
 * [ADR 0010](../../../../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * leaves the app: the handler, the signature check, the envelope and the commit
 * all live in `@reprove/control-plane`, and the matrix in
 * `tools/verify-workspace.mjs` is what stops any of it accumulating here - this
 * app cannot import a Postgres driver, so there is no arrangement in which it
 * assembles a client of its own.
 *
 * The control plane is composed **once per process** rather than per request.
 * `createControlPlane()` opens a connection pool and runs ADR 0008 rule 6's
 * seven tenancy assertions, and doing that per delivery would spend GitHub's
 * ten-second wall on work whose answer cannot change between two requests. The
 * memo holds the promise rather than the resolved value, so concurrent first
 * requests share one composition instead of racing to build several pools.
 *
 * A composition that throws is **not** memoized as a failure: the next delivery
 * tries again, because a boot refusal is usually a deployment being repaired
 * and a permanently poisoned module would need a redeploy to clear. Until it
 * succeeds every delivery gets a non-2xx, which is the answer ADR 0013 wants -
 * the delivery stays manually redeliverable rather than being acknowledged by a
 * process that cannot store it.
 */
import type { ControlPlane, Phase0RunProfile } from "@reprove/control-plane";

/**
 * The package is loaded through Node's own resolution rather than bundled into
 * the route, and the magic comment is what arranges that.
 *
 * ADR 0017 makes `@reprove/control-plane`'s `drizzle/` folder a **runtime
 * asset**: the boot assertion joins the hashes Drizzle stored against the
 * committed files that produced them, so the package resolves that folder
 * relative to its own module rather than to `process.cwd()`. Bundled, the
 * relative base becomes the bundle's location and the files are not beside it.
 *
 * `serverExternalPackages` is the configuration built for this and cannot
 * express it: Next decides what to externalize by matching the **resolved**
 * path against `/node_modules/<package>/`, and a pnpm workspace link resolves
 * through to `packages/control-plane`, where that pattern never matches. The
 * per-import escape hatch is what is left, and it is narrower anyway - one edge
 * rather than a whole package's bundling policy.
 */
const controlPlaneModule = async () =>
  await import(
    /* turbopackIgnore: true */
    "@reprove/control-plane"
  );

/** Node, not Edge: the control plane opens a Postgres connection pool. */
export const runtime = "nodejs";

/** Every delivery is a fresh write; nothing about this route is cacheable. */
export const dynamic = "force-dynamic";

let composed: Promise<ControlPlane> | undefined;

/**
 * The deployment's configuration, read here because the app is the only place
 * allowed to read it. `@reprove/control-plane` reads no environment variable.
 */
const configure = (runProfile: Phase0RunProfile) => ({
  database: {
    connectionString: process.env.REPROVE_DATABASE_URL ?? "",
    onConnectionError: (error: Error) => {
      // The pool discards the failed client itself, so there is nothing to do
      // but observe, and the package holds no logger. `process.stderr` rather
      // than a console method because this is a server process whose only log
      // sink is its own standard error.
      process.stderr.write(
        `reprove: idle database connection failed: ${error.message}\n`
      );
    },
  },
  github: {
    webhookSecret: process.env.REPROVE_GITHUB_WEBHOOK_SECRET ?? "",
    appId: process.env.REPROVE_GITHUB_APP_ID ?? "",
    // A PEM carries newlines, which a `.env` file and most secret stores do
    // not. `\n` is accepted as the escaped form so the same value works in
    // both; a real PEM passes through unchanged, because it contains no
    // backslash.
    privateKey: (process.env.REPROVE_GITHUB_PRIVATE_KEY ?? "").replaceAll(
      String.raw`\n`,
      "\n"
    ),
    // Injected by name rather than written here, which is the whole point of
    // ADR 0013's profile: a harness chosen in route wiring would be prototype
    // wiring silently becoming product selection policy.
    runProfile,
  },
});

const compose = async (): Promise<ControlPlane> => {
  const { createControlPlane, PHASE_0_RUN_PROFILE } =
    await controlPlaneModule();
  return await createControlPlane(configure(PHASE_0_RUN_PROFILE));
};

const controlPlane = async (): Promise<ControlPlane> => {
  composed ??= compose();
  try {
    return await composed;
  } catch (error) {
    composed = undefined;
    throw error;
  }
};

export const POST = async (request: Request): Promise<Response> => {
  // Resolved from the package rather than spelled out here, so there is one
  // statement of what a status means. The import is memoized by the module
  // system and is not the part that can fail; composing over a database is.
  const { WEBHOOK_STATUS } = await controlPlaneModule();

  let plane: ControlPlane;
  try {
    plane = await controlPlane();
  } catch {
    // A composition that could not prove its tenant boundary, or a missing
    // secret. Nothing is acknowledged, so the delivery stays redeliverable -
    // which is ADR 0013's answer for a control plane that cannot store what it
    // was sent.
    return Response.json(
      {
        status: WEBHOOK_STATUS.notCommitted,
        reason: "the control plane is not serving",
      },
      { status: WEBHOOK_STATUS.notCommitted }
    );
  }
  return await plane.handleGitHubWebhook(request);
};
