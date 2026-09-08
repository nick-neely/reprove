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
 * `@reprove/worker-hosted` is an **optional** dependency, which is ADR 0010's
 * deployment table expressed as an edge rather than as prose:
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

/** Node's two spellings of "that module is not installed". */
const NOT_INSTALLED = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/** As much of a module-resolution failure as this module reads. */
interface ResolutionError {
  readonly code?: string;
}

/**
 * Loads the hosted composition, or concludes that this deployment has none.
 *
 * Exported for the composition seam's own test, which drives it over a loader
 * rather than over the real module: the property under test is that an absent
 * package composes no hosted dispatch, and no test can uninstall a package from
 * the workspace it is running in.
 *
 * @param load The import to attempt.
 * @returns The hosted composition, or `null` where the package is not installed.
 * @throws {Error} Whatever the module threw, when it is installed and broken. A
 *   package that is present and fails to load is a deployment defect, and
 *   answering `null` would report it as a self-hosted deployment.
 */
export const composeHostedPlacement = async (
  load: () => Promise<{ readonly hostedPlacement: HostedPlacement }>
): Promise<HostedPlacement | null> => {
  try {
    const loaded = await load();
    return loaded.hostedPlacement;
  } catch (error) {
    // SAFETY: `code` is Node's own field on a resolution failure. Anything
    // raised for another reason carries none, fails the test below, and is
    // rethrown.
    const { code } = error as ResolutionError;
    if (code !== undefined && NOT_INSTALLED.has(code)) {
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
 * `try` rather than repeated work.
 *
 * @returns The hosted composition, or `null` in a self-hosted deployment.
 */
export const hostedPlacement = async (): Promise<HostedPlacement | null> => {
  hosted ??= composeHostedPlacement(() => import("@reprove/worker-hosted"));
  return await hosted;
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
