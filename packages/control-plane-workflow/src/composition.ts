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
 *
 * The **hosted** composition is `placement.ts`'s, and is a module of its own so
 * that nothing a self-hosted deployment reaches names the optional peer: this
 * module is on the default entry point, and every route reaches it.
 */
import type { ControlPlane, DeliveryToProcess } from "@reprove/control-plane";
import {
  createControlPlane,
  PHASE_0_RUN_PROFILE,
} from "@reprove/control-plane";

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
