/**
 * The hosted half of this package, behind an entry point of its own:
 * `@reprove/control-plane-workflow/hosted`.
 *
 * ```text
 * placement.ts   hostedPlacement(), the optional composition and its absence
 * pass.ts        hostedPass, one hosted Worker's attempt at a Run
 * dispatch.ts    dispatchHostedPass(), which claims a Run and starts one
 * ```
 *
 * **Why a subpath rather than three more exports on the default entry point.**
 * `@reprove/worker-hosted` is an *optional* peer (ADR 0010): a self-hosted
 * deployment installs this package without it and composes no hosted dispatch.
 * The three modules above declare their types over that peer, so their emitted
 * declarations import its specifier - and a consumer type-checking with
 * `skipLibCheck: false` follows every declaration its entry point reaches. Left
 * on the default entry point they made the package's own bare specifier
 * unresolvable in exactly the deployment the optional peer exists for, before
 * `hostedPlacement()` could answer `null` for it.
 *
 * The split says the same thing the manifest says, in the export map: the
 * default subpath is what every deployment installs, and this one is what the
 * deployment that also installs the driver reaches for. Nothing here is
 * conditional at run time - `hostedPlacement()` still answers `null` where the
 * driver is absent - because a bundler resolves the specifier at build time and
 * a subpath a hosted app imports must work whichever way the driver went
 * missing.
 *
 * **This is also where the hosted workflow enters an application's module
 * graph.** A `'use workflow'` function is discovered and registered by the
 * Workflow build from what the application imports (ADR 0014), so the hosted
 * composition root reaches `hostedPass` through this subpath;
 * `apps/control-plane` names it for that reason. A self-hosted composition root
 * imports neither this subpath nor the driver, and registers no hosted pass.
 */
export { composeHostedPlacement, hostedPlacement } from "./placement.js";
export type { DispatchOutcome } from "./dispatch.js";
export { dispatchHostedPass } from "./dispatch.js";
export type { HostedNotComposed, PassOutcome } from "./pass.js";
export { HOSTED_WORKER_BUILD_VERSION, hostedPass } from "./pass.js";
