/**
 * The hosted composition, as this package reaches it: an optional peer, loaded
 * lazily, whose absence is an answer rather than a crash.
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
 * It is the same shape `composition.ts`'s `kick` uses, and for a related
 * reason: an import that may legitimately not resolve cannot be at the top of a
 * module every route reaches.
 *
 * **What "absent" means depends on who resolves the specifier.** Under Node it
 * is a resolution failure at the moment of the import, which is what this
 * classifies. Under a bundler the import is resolved at build time, so a
 * deployment that omits the package omits it from the build - and what an
 * operator verifies is the package graph, with `pnpm why`, exactly as ADR 0010
 * says.
 *
 * **It is a module of its own so that the self-hosted declaration graph never
 * names the peer.** `@reprove/worker-hosted` is an optional peer, so a
 * self-hosted consumer installs this package without it - and a consumer that
 * type-checks with `skipLibCheck: false` reads every declaration this package
 * ships that its entry point reaches. A `HostedPlacement` named in
 * `composition.d.ts`, which `index.d.ts` reaches for `controlPlane()`, is
 * therefore an unresolvable specifier in exactly the deployment ADR 0010 says
 * needs no harness code at all - failing the consumer's own build before
 * `hostedPlacement()` could return `null` for it.
 *
 * So the peer is named here, in `dispatch.ts` and in `pass.ts`, and those three
 * are reached only from `hosted.ts`, which is the module behind the `./hosted`
 * subpath. The default entry point reaches none of them, and
 * `tools/verify-packages.mjs` proves that by type-checking a consumer that
 * installs this package with no peer beside it.
 */
import type { HostedPlacement } from "@reprove/worker-hosted";

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
 * Memoized like `composition.ts`'s control plane, and for the weaker of the two
 * reasons: the module registry already caches the import, so this saves the
 * repeated `try` rather than repeated work. A composition that **throws** - the driver
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
