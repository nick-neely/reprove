/**
 * The one control plane a process composes, reached the same way from a route
 * and from a step.
 *
 * Composed **once per process** rather than per call: `createControlPlane()`
 * opens a connection pool and runs ADR 0008 rule 6's seven tenancy assertions,
 * and doing that per delivery would spend GitHub's ten-second wall on work
 * whose answer cannot change between two requests. The memo holds the promise
 * rather than the resolved value, so concurrent first callers share one
 * composition instead of racing to build several pools.
 *
 * A composition that throws is **not** memoized as a failure: the next caller
 * tries again, because a boot refusal is usually a deployment being repaired,
 * and a permanently poisoned module would need a redeploy to clear.
 *
 * `@reprove/control-plane` is imported here like any other dependency and is
 * bundled or externalized as the consuming builder sees fit. What it needs at
 * run time beyond its code is its `drizzle/` folder - ADR 0017's runtime asset,
 * resolved relative to its own module - and the app's `next.config.ts` is where
 * a deployment states that the folder ships.
 *
 * Under a builder that gives a step its own module registry, this module runs
 * twice in one process and composes twice. That costs a second pool and a
 * second pass over the boot checks, and nothing else: neither composition
 * holds state the other needs.
 */
import type { ControlPlane, DeliveryToProcess } from "@reprove/control-plane";
import {
  createControlPlane,
  PHASE_0_RUN_PROFILE,
} from "@reprove/control-plane";
import type { HostedPlacement } from "@reprove/worker-hosted";

import { configFromEnvironment } from "./environment.js";

let composed: Promise<ControlPlane> | undefined;

/**
 * ADR 0014: the durable spine is what a committed delivery is handed to, and
 * the platform's step retry is then the re-drive.
 *
 * The workflow module is loaded when the first delivery arrives rather than
 * imported at the top, because it imports this module for its steps: a static
 * import each way would be a cycle, and the kick is the one edge that can be
 * deferred without changing what it does. Like every kick it is synchronous and
 * does not rethrow - the envelope is durable and a delivery that never reached
 * the spine is recoverable by hand - but it reports, because a recovery nobody
 * is told to perform is not one.
 */
const kick = (delivery: DeliveryToProcess): void => {
  void (async () => {
    try {
      const { startDelivery } = await import("./ingress.js");
      startDelivery(delivery);
    } catch (error) {
      // Only the import can fail here; `startDelivery` reports its own. The
      // ledger row is `received`, so the delivery stays recoverable.
      process.stderr.write(
        `reprove: the durable spine could not be loaded for delivery ${delivery.deliveryId}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  })();
};

/*
 * The hosted composition, as this package reaches it.
 *
 * `@reprove/worker-hosted` is an **optional peer** - `peerDependencies` plus
 * `peerDependenciesMeta.optional` - which is ADR 0010's deployment table
 * expressed as an edge rather than as prose:
 *
 * ```text
 * hosted          control-plane + control-plane-workflow + worker-hosted
 * self-hosted     control-plane + control-plane-workflow
 * ```
 *
 * *"A control plane that dispatches only to self-hosted Workers installs no
 * harness code at all"* is only true if this package can run without it, so the
 * import is lazy and its absence is an answer rather than a crash: `null`
 * composes no hosted dispatch, and everything else - the webhook, the claim
 * endpoint, Acceptance, the lifecycle - is untouched.
 *
 * The peer spelling is what delivers that and `optionalDependencies` would not:
 * pnpm installs those by default and skips them only for an install passing
 * `--omit=optional`, while `autoInstallPeers` installs missing *non-optional*
 * peers only. So the driver arrives exactly when the deployment's composition
 * root names it - `apps/control-plane` is the hosted one and declares it - and
 * never otherwise.
 *
 * It is the same shape the `kick` above uses, and for a related reason: an
 * import that may legitimately not resolve cannot be at the top of a module
 * every route reaches.
 *
 * **What "absent" means depends on who resolves the specifier.** Under Node it
 * is a resolution failure at the moment of the import, which is what this
 * classifies. Under a bundler the import is resolved at build time, so a
 * deployment that omits the package omits it from the build - and what an
 * operator verifies is the package graph, with `pnpm why`, exactly as ADR 0010
 * says.
 */

/** The one specifier whose absence means "this deployment is self-hosted". */
const HOSTED_DRIVER = "@reprove/worker-hosted";

/** Node's two spellings of "that module is not installed". */
const NOT_INSTALLED = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * The specifier a resolution failure blames, as Node writes it into the
 * message: `Cannot find package 'x' imported from y`, and `Cannot find module
 * '/abs/path'` where the package resolved and a file inside it did not.
 */
const UNRESOLVED = /Cannot find (?:package|module) '(?<specifier>[^']*)'/u;

/** As much of a module-resolution failure as this module reads. */
interface ResolutionError {
  readonly code?: string;
  readonly message?: string;
}

/**
 * Whether this failure is the hosted driver being **absent**, rather than
 * present and unable to load.
 *
 * The code alone cannot tell those apart, and reading it alone is the one wrong
 * answer available: a driver that is installed and whose own dependency does
 * not resolve raises `ERR_MODULE_NOT_FOUND` too, and calling that "self-hosted"
 * would report a broken deployment as a correctly configured one. So the
 * failing specifier has to be the driver itself.
 *
 * A resolution failure this cannot attribute - a phrasing Node changed, or a
 * loader with a message of its own - is **not** absence. It is rethrown by the
 * caller, on the same principle: an unexplained failure is a defect to surface,
 * not a deployment shape to infer.
 *
 * @param failure The load's failure, read as a resolution error.
 * @param specifier The driver's own specifier.
 * @returns Whether the driver itself is what failed to resolve.
 */
const isAbsent = (failure: ResolutionError, specifier: string): boolean => {
  const { code, message } = failure;
  if (code === undefined || !NOT_INSTALLED.has(code)) {
    return false;
  }
  return UNRESOLVED.exec(message ?? "")?.groups?.specifier === specifier;
};

/**
 * Loads the hosted composition, or concludes that this deployment has none.
 *
 * Exported for the composition seam's own test, which drives it over a loader
 * rather than over the real module: the property under test is that an absent
 * package composes no hosted dispatch, and no test can uninstall a package from
 * the workspace it is running in.
 *
 * @param load The import to attempt.
 * @param specifier What `load` imports, which is what its failure has to name
 *   for the package to count as absent. Defaults to the hosted driver; a test
 *   passing a loader of its own is the only caller that names another.
 * @returns The hosted composition, or `null` where the package is not installed.
 * @throws {Error} Whatever the module threw, when it is installed and broken -
 *   including a resolution failure that names anything but `specifier`. A
 *   package that is present and fails to load is a deployment defect, and
 *   answering `null` would report it as a self-hosted deployment.
 */
export const composeHostedPlacement = async (
  load: () => Promise<{ readonly hostedPlacement: HostedPlacement }>,
  specifier: string = HOSTED_DRIVER
): Promise<HostedPlacement | null> => {
  try {
    const loaded = await load();
    return loaded.hostedPlacement;
  } catch (error) {
    // SAFETY: `code` and `message` are Node's own fields on a resolution
    // failure. Anything raised for another reason carries no matching `code`,
    // fails the test below, and is rethrown.
    if (isAbsent(error as ResolutionError, specifier)) {
      return null;
    }
    throw error;
  }
};

let hosted: Promise<HostedPlacement | null> | undefined;

/**
 * The hosted composition this process holds, resolved on first use.
 *
 * Memoized like the control plane above, and for the weaker of the two reasons:
 * the module registry already caches the import, so this saves the repeated
 * `try` rather than repeated work. A composition that **throws** - the driver
 * installed and broken - is cleared for the same reason `controlPlane()` clears
 * its own, and with the same care about which attempt is cleared: a deployment
 * being repaired must not need a redeploy to clear a poisoned module, and
 * clearing unconditionally would let a caller awaiting the failed promise
 * discard a later caller's healthy one.
 *
 * @returns The hosted composition, or `null` in a self-hosted deployment.
 * @throws {Error} Whatever the driver threw, when it is installed and broken.
 */
export const hostedPlacement = async (): Promise<HostedPlacement | null> => {
  // The specifier stays a literal in the `import()`: a bundler resolves this
  // edge at build time, and it can only do that for one it can read.
  hosted ??= composeHostedPlacement(
    () => import("@reprove/worker-hosted"),
    HOSTED_DRIVER
  );
  const attempted = hosted;
  try {
    return await attempted;
  } catch (error) {
    if (hosted === attempted) {
      hosted = undefined;
    }
    throw error;
  }
};

const compose = async (): Promise<ControlPlane> =>
  await createControlPlane(
    configFromEnvironment(process.env, {
      // Injected by name rather than read from the environment, which is the
      // whole point of ADR 0013's profile.
      runProfile: PHASE_0_RUN_PROFILE,
      kick,
    })
  );

/**
 * The composed control plane, built on first use from the environment.
 *
 * @returns The one control plane this module instance holds.
 * @throws {TypeError} Naming the missing environment-derived field.
 * @throws {import("@reprove/control-plane").BootRefusalError} Naming every
 *   tenancy assertion that failed.
 */
export const controlPlane = async (): Promise<ControlPlane> => {
  composed ??= compose();
  const attempted = composed;
  try {
    return await attempted;
  } catch (error) {
    // Only the attempt that failed is cleared. Clearing unconditionally would
    // let a second caller awaiting the same failed promise discard a later
    // caller's healthy composition, which then holds a connection pool nothing
    // will ever reach again - one leaked pool per interleaving, on exactly the
    // recovering deployment the memo above is written for.
    if (composed === attempted) {
      composed = undefined;
    }
    throw error;
  }
};
