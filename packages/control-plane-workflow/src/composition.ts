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
 * `@reprove/control-plane` is loaded through Node's own resolution rather than
 * bundled, and the magic comment is what arranges that under Turbopack. ADR
 * 0017 makes that package's `drizzle/` folder a **runtime asset**: the boot
 * assertion joins the hashes Drizzle stored against the committed files that
 * produced them, and the package resolves the folder relative to its own
 * module. Bundled, the relative base becomes the bundle's location and the
 * files are not beside it. `serverExternalPackages` is the configuration built
 * for this and cannot express it, because Next matches the *resolved* path
 * against `/node_modules/<package>/` and a pnpm workspace link resolves through
 * to `packages/control-plane`. Every other builder ignores the comment and
 * resolves the import normally, which is also correct.
 *
 * Under a builder that gives a step its own module registry, this module runs
 * twice in one process and composes twice. That costs a second pool and a
 * second pass over the boot checks, and nothing else: neither composition
 * holds state the other needs.
 */
import type { ControlPlane, DeliveryToProcess } from "@reprove/control-plane";

import { configFromEnvironment } from "./environment.js";

/**
 * Node's own resolution, not the bundler's. See the module comment for why the
 * comment is load-bearing rather than decorative.
 */
const controlPlaneModule = async () =>
  await import(
    /* turbopackIgnore: true */
    "@reprove/control-plane"
  );

let composed: Promise<ControlPlane> | undefined;

/**
 * ADR 0014: the durable spine is what a committed delivery is handed to, and
 * the platform's step retry is then the re-drive.
 *
 * The workflow module is loaded when the first delivery arrives rather than
 * imported at the top, because it imports this module for its steps: a static
 * import each way would be a cycle, and the kick is the one edge that can be
 * deferred without changing what it does. Like every kick it is synchronous
 * and swallows its own rejection - the envelope is durable, this package holds
 * no logger, and a delivery that never reached the spine is recoverable by
 * hand.
 */
const kick = (delivery: DeliveryToProcess): void => {
  void (async () => {
    try {
      const { startDelivery } = await import("./ingress.js");
      startDelivery(delivery);
    } catch {
      // Nothing to do, and nothing to log with. The ledger row is `received`.
    }
  })();
};

const compose = async (): Promise<ControlPlane> => {
  const { createControlPlane, PHASE_0_RUN_PROFILE } =
    await controlPlaneModule();
  return await createControlPlane(
    configFromEnvironment(process.env, {
      // Injected by name rather than read from the environment, which is the
      // whole point of ADR 0013's profile.
      runProfile: PHASE_0_RUN_PROFILE,
      kick,
    })
  );
};

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
  try {
    return await composed;
  } catch (error) {
    composed = undefined;
    throw error;
  }
};
