<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/control-plane-workflow

## dist/composition.d.ts

```ts
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
import type { ControlPlane } from "@reprove/control-plane";
/**
 * The composed control plane, built on first use from the environment.
 *
 * @returns The one control plane this module instance holds.
 * @throws {TypeError} Naming the missing environment-derived field.
 * @throws {import("@reprove/control-plane").BootRefusalError} Naming every
 *   tenancy assertion that failed.
 */
export declare const controlPlane: () => Promise<ControlPlane>;
```

## dist/dispatch.d.ts

```ts
/**
 * Hosted dispatch: the entry point that claims a Run and starts its pass.
 *
 * It is a module of its own, and that is a **build** decision rather than a
 * taxonomy: this function calls `controlPlane()` and `hostedPlacement()` at
 * module scope, and everything a module holding a `'use workflow'` function
 * reaches is inlined into the workflow bundle - which runs in a VM with no
 * `require`. Left beside `hostedPass` it dragged the control plane, the
 * Postgres driver and the whole harness stack into that bundle, and the
 * Workflow builder refused the build naming a Node built-in in an innocent
 * file. That is exactly the failure ADR 0014 built the real-builder gate for,
 * and the fix is the same one the gate's own documentation gives: a workflow
 * body reaches steps and the runtime's primitives, and nothing else.
 *
 * ```text
 * plane.claimRun                      execution ownership, the same conditional
 *                                     UPDATE the Worker endpoint reaches
 * start(hostedPass, [grant, owner])   the pass is now genuinely running
 * -- the window ADR 0016 pays to reach --
 * plane.markExecuting                 claimed -> executing, pass id recorded
 * ```
 *
 * The ordering itself is `@reprove/worker-hosted`'s, deliberately: it is the
 * fact [ADR 0016](../../../docs/adr/0016-phase-0-acceptance-scenario.md)
 * reasons about, and it belongs beside the placement it orders rather than
 * being restated by every composition that drives one. What is here is the
 * wiring: which control plane, which workflow, which Owner.
 *
 * **Nothing in this repository dispatches automatically yet.** ADR 0016's
 * scenario drives the claim endpoint itself and needs the Run left claimable,
 * so wiring this into the ingress spine would dispatch every Run before that
 * scenario could reach one. This is the entry point the scenario
 * ([#58](https://github.com/nick-neely/reprove/issues/58)) and the tests call;
 * saying so is the point, because an exported function with no caller reads
 * like a live path.
 *
 * **What this deliberately does not claim.** `not_composed` is a statement
 * about *this deployment* and not about the Run: nothing was claimed, nothing
 * was started, and the Run is left exactly as claimable as it was, for whatever
 * placement it belongs to. It is not a failure and is not retried - a
 * self-hosted control plane declining to execute a hosted pass is ADR 0010's
 * deployment table working - so a caller that treated it as one would put an
 * alert behind a correct configuration. And it decides nothing about the
 * dispatch it does perform: the order, the window between `start()` and the
 * write, and every outcome name below are `@reprove/worker-hosted`'s.
 */
import type { ControlPlane } from "@reprove/control-plane";
import type { HostedDispatchOptions, HostedDispatchOutcome, HostedPlacement } from "@reprove/worker-hosted";
import type { HostedNotComposed } from "./pass.js";
/** How one hosted dispatch ended, or that this deployment composes none. */
export type DispatchOutcome = HostedDispatchOutcome | HostedNotComposed;
/**
 * The two compositions one dispatch reaches, as an argument.
 *
 * The control plane is narrowed to the two statements dispatch uses, so what
 * this depends on is legible and a double is the same shape the deployment
 * passes rather than a weaker one.
 */
interface HostedComposition {
    readonly controlPlane: () => Promise<Pick<ControlPlane, "claimRun" | "markExecuting">>;
    readonly hostedPlacement: () => Promise<HostedPlacement | null>;
}
/**
 * Claims a Run through a given composition and starts its pass, in the order
 * the module header above sets out and for the reasons it gives.
 *
 * Exported for this module's own test, which drives it over doubles rather than
 * over the composed deployment, for the same reason `composeHostedPlacement`
 * takes its loader: the branch worth testing is the one where **no** hosted
 * placement is composed, and no test can uninstall a package from the workspace
 * it is running in. What the composed path does is `spine.test.ts`'s subject,
 * against the real World and the real control plane.
 *
 * @param composition The control plane and the hosted placement to dispatch
 *   through.
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run to dispatch.
 * @param options ADR 0016's test-only injection point, forwarded unchanged.
 * @returns What the dispatch concluded, or that no hosted placement is composed.
 */
export declare const dispatchThrough: (composition: HostedComposition, ownerId: number, runId: string, options: HostedDispatchOptions) => Promise<DispatchOutcome>;
/**
 * Claims a Run for this deployment's hosted placement and starts its pass.
 *
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run to dispatch. Hosted dispatch always names its Run,
 *   because polling is the half of the protocol hosted never exercises.
 * @param options ADR 0016's test-only injection point, forwarded unchanged.
 *   Nothing in this package sets it, which `pass.test.ts` asserts by reading
 *   this package's own shipped source.
 * @returns What the dispatch concluded, or that no hosted placement is composed.
 */
export declare const dispatchHostedPass: (ownerId: number, runId: string, options?: HostedDispatchOptions) => Promise<DispatchOutcome>;
export {};
```

## dist/environment.d.ts

```ts
/**
 * The deployment's configuration, read from the environment - here and nowhere
 * else in Reprove's library code.
 *
 * [ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md) puts every
 * step definition and **all step configuration** in this package, for a reason
 * that is a fact about the build rather than a preference: a `'use step'`
 * function compiles into a bundle whose module graph is fixed at build time, and
 * whether that bundle shares a module instance with the route that composed the
 * deployment is builder-dependent - the same under Turbopack, different under
 * `@workflow/vitest`. A step can therefore neither rely on being configured by
 * its caller nor assume it must not read the environment. It resolves its own
 * configuration, and this is where it resolves it from.
 *
 * That is also what lets `@reprove/control-plane` read no environment variable
 * at all, literally rather than nearly (ADR 0010 as amended): every value below
 * is parsed here and passed to `createControlPlane()` explicitly.
 *
 * The parse is a pure function of an environment object so a test can hand it
 * one. Absent values pass through as empty strings rather than being refused
 * here: `createControlPlane()` already names the missing field in the error it
 * throws, and a second refusal in front of it would be a second spelling of the
 * same rule.
 *
 * The two Run-window durations are the exception, and they are the exception
 * because nothing downstream could name what went wrong: the profile they
 * override is injected by name, so a refusal from `normalizeRunProfile` would
 * name a field in a package rather than the variable a deployment set.
 */
import type { ControlPlaneConfig, KickProcessing, Phase0RunProfile } from "@reprove/control-plane";
/**
 * The variables a deployment sets. Named once, so the app's README, the build
 * gate and this parser cannot drift on a spelling.
 */
export declare const ENVIRONMENT: {
    /** The **pooled** endpoint, as the restricted runtime role. */
    readonly databaseUrl: "REPROVE_DATABASE_URL";
    /** The webhook secret the App was registered with. */
    readonly webhookSecret: "REPROVE_GITHUB_WEBHOOK_SECRET";
    /** GitHub's numeric App id, which is the App JWT's issuer. */
    readonly appId: "REPROVE_GITHUB_APP_ID";
    /**
     * The App's PEM private key. A PEM carries newlines, which a `.env` file and
     * most secret stores do not, so the escaped form `\n` is accepted too; a real
     * PEM passes through unchanged, because it contains no backslash.
     */
    readonly privateKey: "REPROVE_GITHUB_PRIVATE_KEY";
    /**
     * Optional. GitHub's REST root, for a GitHub Enterprise Server deployment or
     * a build gate standing a canned GitHub up on loopback. Unset means
     * `https://api.github.com`.
     *
     * It must be `https:`, or `http:` on loopback (`127.0.0.1`, `localhost`,
     * `::1`): every request under it carries an App credential, so
     * `createControlPlane()` refuses a cleartext root off the machine rather than
     * sending a token to it.
     */
    readonly githubApiUrl: "REPROVE_GITHUB_API_URL";
    /**
     * Optional. How long a created Run stays claimable, in milliseconds. Unset
     * means the injected profile's own value, which is
     * `PHASE_0_CLAIMABLE_FOR_MS`.
     *
     * See {@link livenessForMs} for why the two windows are separate variables.
     */
    readonly claimableForMs: "REPROVE_RUN_CLAIMABLE_FOR_MS";
    /**
     * Optional. How long a claimed execution stays live without renewed
     * evidence, in milliseconds. Unset means the injected profile's own value,
     * which is `PHASE_0_LIVENESS_FOR_MS`.
     *
     * **These two are the only fields of the profile a deployment may name, and
     * that is a line rather than an accident.** ADR 0013 injects the profile by
     * name precisely so that a harness, a model or a placement read from an
     * environment variable cannot turn a Phase 0 fixture into product selection
     * policy. A duration is not a selection: it changes how long a window is
     * open, not what runs inside it, and both are already bounded and validated
     * by `normalizeRunProfile`.
     *
     * They exist as a **paid verification affordance**, in the same register as
     * the dispatch path's test-only injection point, and ADR 0016 is what buys
     * them. The Phase 0 exit has to observe a Run "terminalized by liveness
     * alone", which means running the real lifecycle loop, the real durable sleep
     * and the real conditional UPDATE against a deadline that actually arrives -
     * and the shipped durations are five and ten minutes, against a CI job
     * budgeted at thirty for everything.
     *
     * Three alternatives were rejected. An injectable clock disagrees with the
     * durable schedule it is supposed to be testing, because Workflow's own
     * `sleep` runs on wall time. Moving `execution_expires_at` earlier in the
     * database does not wake anything: the lifecycle sleeps toward the deadline
     * it read and only re-reads on wake. Calling the terminal transition directly
     * proves the predicate while proving nothing about the loop that fires it,
     * which is the whole of what this case exists to prove.
     *
     * They are independent on purpose. A short claim window races Run creation,
     * which takes a per-pull-request advisory lock and fetches canonical state
     * before the Run exists to be claimed, so a scenario watching the **liveness**
     * window shortens that one and leaves the other generous.
     */
    readonly livenessForMs: "REPROVE_RUN_LIVENESS_FOR_MS";
};
/** An environment, as `process.env` is shaped. */
export type Environment = Readonly<Record<string, string | undefined>>;
/** What the deployment passes by name rather than through the environment. */
export interface CompositionOptions {
    /**
     * ADR 0013's injected profile. Passed by name on purpose: a harness or a
     * model read from an environment variable would be a Phase 0 fixture quietly
     * becoming product selection policy.
     */
    readonly runProfile: Phase0RunProfile;
    /** What the webhook hands a committed delivery to. */
    readonly kick?: KickProcessing;
    /**
     * Where an idle connection failure is reported. Defaults to the process's
     * standard error, which is the only log sink a server process has; a test
     * passes something quieter.
     */
    readonly onConnectionError?: (error: Error) => void;
}
/**
 * Parses the deployment's configuration.
 *
 * @param env The environment to read, usually `process.env`.
 * @param options What the deployment passes by name.
 * @returns What `createControlPlane()` is composed over.
 */
export declare const configFromEnvironment: (env: Environment, options: CompositionOptions) => ControlPlaneConfig;
```

## dist/hosted.d.ts

```ts
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
```

## dist/index.d.ts

```ts
/**
 * Every workflow and step definition for the hosted control plane, and all step
 * configuration ([ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)).
 *
 * `apps/control-plane` composes this: its `next.config.ts` wraps the build with
 * `withWorkflow`, and its webhook route calls `controlPlane()` and hands the
 * request on. `@reprove/control-plane` neither defines nor configures a step,
 * and reads no environment variable; this package does both, because a `'use
 * step'` function compiles into a bundle whose module graph is fixed at build
 * time, so the layer that defines steps is the only layer that can configure
 * them.
 *
 * **The workflow functions are exported for the builder, not for callers.**
 * A `'use workflow'` function has to be reachable from the application's
 * module graph for the Workflow build to discover and register it, and it is
 * discovered here because this package declares `workflow` as a dependency -
 * the builder follows a bare import only into a package that does. Starting a
 * lifecycle goes through `startDelivery()`, which the control plane is composed
 * with; starting a pass goes through `dispatchHostedPass()`, and nothing else
 * in Reprove calls `start()`.
 *
 * **The hosted pass is here rather than in `@reprove/worker-hosted`** for the
 * reason this package exists at all: ADR 0014 gives it every workflow and step
 * definition, because a step's module graph is fixed at build time and the
 * layer that defines steps is the only layer that can configure them. What the
 * hosted placement *does* is that package's, reached through ports and through
 * an optional import, so a self-hosted deployment omits it and this one runs
 * unchanged.
 *
 * **It is not on this entry point, though: it is on `./hosted`.** That half of
 * the package declares its types over the optional peer, so its declarations
 * name a specifier a self-hosted install does not have - and a consumer
 * type-checking the package it did install would fail on it. Everything here
 * resolves with `@reprove/control-plane` and `workflow` alone, which is what
 * ADR 0010's self-hosted row installs; `hosted.ts` explains the split and
 * `tools/verify-packages.mjs` proves it against the packed artifact.
 */
export type { CompositionOptions, Environment } from "./environment.js";
export { configFromEnvironment, ENVIRONMENT } from "./environment.js";
export { controlPlane } from "./composition.js";
export type { DispatchedLifecycle, IngressConclusion } from "./ingress.js";
export { ingressDelivery, RE_DRIVE, startDelivery } from "./ingress.js";
export type { LifecycleOutcome, LifecycleSignal } from "./lifecycle.js";
export { lifecycleToken, runLifecycle } from "./lifecycle.js";
export type { Notified } from "./notify.js";
export { notifyLifecycle } from "./notify.js";
export declare const packageName: "@reprove/control-plane-workflow";
```

## dist/ingress.d.ts

```ts
/**
 * What a committed delivery is handed to, and the re-drive [ADR
 * 0013](../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * made a Phase 0 exit condition.
 *
 * ```text
 * webhook commits the envelope, answers 200
 *   -> startDelivery()                 start(ingressDelivery, [delivery])
 *        step processDelivery          the advisory lock, the canonical fetch,
 *                                      the Run; RetryableError on contended and
 *                                      transient IS the re-drive
 *        step dispatchLifecycle        start(runLifecycle); the Run row arbitrates
 *        step notifyEnded              wake the lifecycles of Runs this delivery ended
 * ```
 *
 * [ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md): "the
 * ingress step throws `RetryableError` on `contended` and `transient`, and
 * Workflow's own step retry is the re-drive." No Reprove-owned sweeper, backoff
 * table or second job system appears beside the orchestrator, which is what
 * makes ADR 0006's "ingress must not write a parallel queue" true by
 * construction rather than by discipline.
 *
 * Every step here calls `controlPlane()` first, for the reason `composition.ts`
 * gives: whether a step shares a module instance with the route that composed
 * the deployment is builder-dependent, so a step resolves its own.
 */
import type { DeliveryToProcess, ProcessedDelivery } from "@reprove/control-plane";
import type { Notified } from "./notify.js";
/**
 * The re-drive schedule, as Phase 0 fixture values. ADR 0013 fixed the retry
 * metadata and sent the schedule here; nothing in Phase 0 measures either
 * number, so both are chosen to be observable during development rather than
 * to be right.
 *
 * `contended` is another processor holding the same pull request's lock, which
 * it releases within one transaction's `idle_in_transaction_session_timeout`
 * at most, so the wait is short. `transient` is GitHub answering with a `5xx`,
 * a `429` or a rate limit, which clears on its own but not in a second.
 */
export declare const RE_DRIVE: {
    readonly contendedAfterMs: 2000;
    readonly transientAfterMs: 30000;
    /**
     * Retries **after** the first attempt, so a delivery is attempted at most one
     * more time than this before the workflow run fails and the ledger row is
     * left `received` for an operator, with its retry class saying why.
     */
    readonly maxRetries: 5;
};
/** How the lifecycle dispatch concluded. */
export interface DispatchedLifecycle {
    /** The lifecycle this Run now records, or `null` where another already did. */
    readonly workflowRunId: string | null;
    /**
     * A lifecycle this step started and then cancelled, because the Run already
     * recorded another by the time this one was written. That is ADR 0014's
     * orphan being made inert on the spot rather than at its deadline.
     */
    readonly cancelledLifecycle: string | null;
}
/** What one ingress workflow run concluded, for whoever reads its return. */
export interface IngressConclusion {
    readonly processed: ProcessedDelivery;
    readonly dispatched: DispatchedLifecycle | null;
    readonly notified: readonly Notified[];
}
/**
 * Moves one committed delivery onto the durable spine.
 *
 * @param delivery The committed ledger row and its envelope.
 * @returns What the delivery concluded, once the durable run has.
 */
export declare function ingressDelivery(delivery: DeliveryToProcess): Promise<IngressConclusion>;
/**
 * Starts the durable run for one committed delivery. This is the `kick` the
 * control plane is composed with, and like every kick it is synchronous and
 * returns nothing: the acknowledgement must not wait on it, and a rejection
 * here leaves the ledger row `received` for a manual redelivery, which is the
 * only recovery a delivery that never reached the spine has.
 *
 * A failure here is **reported and not rethrown**. Swallowing it silently was
 * the worse half of the same decision: a deployment whose World is misconfigured
 * would then acknowledge every delivery, commit every envelope, run nothing, and
 * say nothing anywhere, so the manual recovery this comment relies on is one
 * nobody knows to perform. Standard error is the only sink a server process has,
 * and it is the one `environment.ts` already reports a broken connection to.
 *
 * @param delivery The committed ledger row and its envelope.
 */
export declare const startDelivery: (delivery: DeliveryToProcess) => void;
```

## dist/lifecycle.d.ts

```ts
/**
 * The Run's durable schedule - [ADR
 * 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)'s **lifecycle**,
 * which outlives any Worker.
 *
 * It schedules; it does not decide. Every fact about a Run's outcome is written
 * by the control plane, and this workflow reads what was written and acts on
 * the Run's **two** bounded windows. [ADR
 * 0015](../../../docs/adr/0015-execution-ownership-and-worker-liveness.md)
 * shapes it as a **state-driven loop** that re-reads authoritative Run state on
 * every wake rather than trusting the timestamp it slept toward:
 *
 * ```text
 * wake
 *   -> read authoritative Run state
 *      invisible, or another lifecycle recorded  -> return, having written nothing
 *      terminal                                  -> return
 *      queued              -> claim-window branch, on claimableUntil
 *      claimed | executing -> liveness branch, on the CURRENT executionExpiresAt
 *                             deadline ahead   -> sleep toward it, or until notified
 *                             deadline passed  -> attempt failed(worker_lost)
 * ```
 *
 * **The two branches are one shape.** Each window is a deadline the Run itself
 * carries, so below the branch the loop sleeps toward it or tries to close it,
 * and only the transition differs. The re-read is what makes a self-hosted
 * Lease renewal work later without a new mechanism: renewal advances a column,
 * and a wake that finds a later deadline sleeps again.
 *
 * **One durable run per Run.** A separate watchdog workflow was rejected: it
 * would add a third `start()` orphan window of exactly the kind that leaves a
 * Run at `claimed` with a live, unrecorded pass - the hole this loop's second
 * branch exists to close. The cost is one pending `sleep` per lost race, an
 * un-cancelled job that fires later as an early-return no-op.
 *
 * **Everything this workflow body reaches is inlined into the workflow bundle,
 * and that bundle runs in a VM with no `require`.** So the body calls the
 * runtime's own primitives and the steps below, and nothing else; the control
 * plane is reached only from inside a step, where a Node module graph is
 * permitted. A helper hoisted to module scope and called from the body would
 * drag its whole transitive graph into the bundle and break every workflow in
 * the application, with an error naming an innocent one, while the build
 * stayed green. The real-builder gate exists because that rule cannot be left
 * to memory.
 *
 * **The terminal write is the correctness boundary; cancelling is
 * reclamation.** The liveness branch terminalizes first and cancels the
 * still-running pass second, best-effort, and only if its transition won.
 * Where the Run records no pass there is nothing to cancel and that is fine: a
 * pass that emerges afterwards cannot change a Run whose Acceptance has already
 * closed.
 *
 * **The watchdog reads the pass before it writes, and only then.** Once the
 * deadline has passed and a pass id is recorded, its durable state is what
 * turns `deadline_elapsed` into the observation that names what the pass
 * actually did (ADR 0015's set). Before the deadline there is nothing to ask
 * about - a running pass inside its window is the ordinary case - and with no
 * pass id there is nothing to ask.
 */
import type { ExecutionLostObservation, LostFrom } from "@reprove/control-plane";
/**
 * The hook token, scoped to the **lifecycle** and never to the Run alone.
 *
 * Hook tokens are globally unique, and `start()` takes no idempotency key, so
 * two lifecycles can exist for one Run. A token derived from the Run id would
 * then collide - and collide the wrong way round: the orphan starts first,
 * holds the token, and the lifecycle actually recorded on the Run is the one
 * that dies. Carrying the lifecycle's own id makes the two disjoint; the cost
 * is that a notifier must read the recorded lifecycle from the database before
 * it can resume anything, which is the right dependency direction anyway.
 *
 * @param runId The Run.
 * @param workflowRunId The lifecycle scheduling it.
 * @returns The token its hook is created and resumed under.
 */
export declare const lifecycleToken: (runId: string, workflowRunId: string) => string;
/**
 * What a notification carries. It is a wake-up and nothing more: the lifecycle
 * re-reads the Run rather than trusting the payload, so the database decides
 * and the notification follows, never the reverse (ADR 0014).
 */
export interface LifecycleSignal {
    /** Why the notifier thinks the lifecycle should look. */
    readonly reason: "superseded" | "cancelled";
}
/**
 * What the pass's own durable run says about itself, as a step can carry it
 * back into a workflow body.
 *
 * `null` is "its state could not be read", which is a different fact from any
 * status and is why this is not simply a string: a World that answered nothing
 * has told the watchdog nothing about the pass, and the observation set has a
 * member for exactly that.
 *
 * Unexported, like the step that produces it: it crosses no package boundary,
 * and `observationFor` below - the only other thing that names it - is not on
 * the entry point either.
 */
interface PassDisposition {
    readonly status: string | null;
}
/** How one lifecycle ended, which is its return value. */
export type LifecycleOutcome =
/** This lifecycle closed the unclaimed window. */
{
    readonly kind: "unscheduled";
}
/** This lifecycle closed the executing window: nobody came back for the Run. */
 | {
    readonly kind: "worker_lost";
    /**
     * Which side of Acceptance's window it was abandoned on, as the control
     * plane's own vocabulary rather than as a bare string. The type comes
     * from `@reprove/control-plane`'s published surface, which is a closed
     * set of strings and names no Drizzle type - so this package still
     * depends on none.
     */
    readonly lostFrom: LostFrom;
    /** What the watchdog could say for itself about the pass, if anything. */
    readonly observation: ExecutionLostObservation;
    /**
     * The pass this lifecycle cancelled **after** its transition won, or
     * `null` where the Run recorded none. Reclamation, never correctness: the
     * database write is the boundary and this follows it.
     */
    readonly cancelledPass: string | null;
}
/** The Run was ended by the control plane: superseded, cancelled, or terminal. */
 | {
    readonly kind: "ended";
    readonly status: string;
}
/**
 * The Run is claimed or executing and carries no execution deadline, so
 * there is no second window to watch.
 *
 * A claim writes all six execution-ownership columns in one statement, so
 * this is a state the schema cannot reach. It is reported rather than thrown
 * on because a lifecycle's job is to schedule, not to assert: a Run in a
 * shape nothing can produce is something to look at, not something to end.
 */
 | {
    readonly kind: "claimed";
    readonly status: string;
}
/** Another lifecycle is the recorded one, or none was recorded in time. */
 | {
    readonly kind: "orphaned";
    readonly recordedLifecycle: string | null;
}
/** No such Run is visible to this Owner. */
 | {
    readonly kind: "unknown_run";
};
/**
 * What the watchdog saw, as one of ADR 0015's observations.
 *
 * ```text
 * no pass recorded        deadline_elapsed
 * pending | running       deadline_elapsed                 it is still going
 * completed               workflow_terminal_without_result it ended, and no
 *                                                          Result ever arrived
 * failed                  workflow_failed
 * cancelled               workflow_cancelled
 * unreadable              workflow_state_unavailable
 * ```
 *
 * **`deadline_elapsed` covers two different pictures** and that is deliberate:
 * with no pass id, and with a pass still running past its Run's deadline, the
 * watchdog has seen the same thing - nothing usable arrived in time. Inventing
 * a name for the second would claim the watchdog knows why, and it does not.
 *
 * **A `completed` pass is not a completed Run.** The transition only runs at
 * all over a Run still inside Acceptance's window, so a pass that returned
 * normally and left the Run there submitted no Result: that is what
 * `workflow_terminal_without_result` names, and it is why the status is read
 * rather than the pass's return value.
 *
 * **Which is also where a hosted pass's structured Failure ends up, today.**
 * Phase 0 has no transition for a Failure or a Refusal from Worker core, so
 * `@reprove/worker-hosted` returns either as the pass's own value and writes
 * nothing; the durable run then ends `completed`, and this mapping closes the
 * Run `failed(worker_lost)` with `workflow_terminal_without_result`, keeping
 * none of the reason, phase or detail the pass returned. Reading the return
 * value would not fix it - there would still be no failure reason to write
 * (`RUN_FAILURE_REASONS` has one member) - so it is recorded here as a gap
 * rather than patched at the watchdog, and [#83](https://github.com/nick-neely/reprove/issues/83) is where it is
 * received. It is unreachable in the shipped Phase 0 composition, whose Worker
 * core is a fixture that produces a Result or throws, and `spine.test.ts` pins
 * it.
 *
 * An unrecognized status maps to `workflow_state_unavailable` rather than
 * throwing: the World's status vocabulary belongs to a dependency, and a
 * lifecycle's job is to schedule rather than to assert. Saying "its state could
 * not be read" about a status this loop does not understand is true.
 *
 * **Exported for `lifecycle.test.ts` beside it, and for nothing else.** The
 * package's entry point does not re-export it: it takes a type this module
 * keeps to itself, and the mapping is the loop's own business rather than
 * something a consumer composes with. The module-level export is what lets the
 * one part of the liveness branch that can be enumerated exhaustively be
 * enumerated without a World and a database.
 *
 * @param pass What the pass's durable run said, or `null` where the Run records
 *   no pass at all.
 * @returns The observation the terminal transition records.
 */
export declare const observationFor: (pass: PassDisposition | null) => ExecutionLostObservation;
/**
 * Schedules one Run.
 *
 * @param runId The Run.
 * @param ownerId The Owner the Run belongs to, which every step scopes to.
 * @returns How this lifecycle ended.
 */
export declare function runLifecycle(runId: string, ownerId: number): Promise<LifecycleOutcome>;
export {};
```

## dist/notify.d.ts

```ts
import type { LifecycleSignal } from "./lifecycle.js";
/** What became of one notification. */
export type Notified = {
    readonly runId: string;
    readonly notified: true;
    readonly workflowRunId: string;
} | {
    readonly runId: string;
    readonly notified: false;
    /**
     * `no_recorded_lifecycle` - the Run is not visible or nothing has been
     * recorded for it yet; `no_open_hook` - the recorded lifecycle has no
     * hook open under its token, because it has not reached the hook yet or
     * has already ended.
     */
    readonly reason: "no_recorded_lifecycle" | "no_open_hook";
};
/**
 * Wakes the lifecycle the Run records, if there is one to wake.
 *
 * @param ownerId The Owner the Run belongs to.
 * @param runId The Run whose status the control plane has already written.
 * @param reason Why the lifecycle should look.
 * @returns Whether a lifecycle was woken, and which.
 */
export declare const notifyLifecycle: (ownerId: number, runId: string, reason: LifecycleSignal["reason"]) => Promise<Notified>;
```

## dist/pass.d.ts

```ts
/**
 * The **pass**: one hosted Worker's attempt at a Run, as a durable run of its
 * own ([ADR 0014](../../../docs/adr/0014-workflow-orchestration-seam.md)).
 *
 * ```text
 * dispatchHostedPass                    plain function; nothing durable yet
 *   plane.claimRun                      execution ownership, the same UPDATE
 *                                       the Worker endpoint reaches
 *   start(hostedPass, [grant, owner])   the pass is now running
 *   -- the window ADR 0016 pays to reach --
 *   plane.markExecuting                 claimed -> executing, pass id recorded
 *
 * hostedPass                            'use workflow'
 *   step executeHostedPass              worker-hosted drives worker-core and
 *                                       reports through the control plane
 * ```
 *
 * **The workflow lives here and the behaviour lives in
 * `@reprove/worker-hosted`.** ADR 0014 gives this package "every workflow and
 * step definition, and all step configuration", because a `'use step'` function
 * compiles into a bundle whose module graph is fixed at build time, so the
 * layer that defines steps is the only layer that can configure them - and
 * `@reprove/worker-hosted` reads no environment and depends on no control
 * plane, by ADR 0010's matrix. So the ordering, the placement and the Phase 0
 * Worker core are that package's, reached here through ports; the durable
 * shape, the step boundaries and the composition are this one's.
 *
 * **Everything the workflow body reaches is inlined into the workflow bundle,
 * which runs in a VM with no `require`.** The body below calls one step and
 * nothing else, and the harness stack is reached only from inside that step,
 * where a Node module graph is permitted. `tools/verify-workflow-build.mjs`
 * asserts the emitted bundle names no module but the workflow runtime, and
 * names none of `@reprove/worker-core`, `@reprove/adapters`,
 * `@reprove/sandbox-container` or `@ai-sdk/*` in particular.
 *
 * **The grant travels in the pass's arguments, and that includes the execution
 * token.** It has to: the control plane stores only `sha256(token)`, so the
 * plaintext cannot be re-read, and a pass that could not present it could
 * neither submit a Result nor report itself lost. The consequence is stated
 * rather than hidden - the token is at rest in the World's storage for the life
 * of the durable run, where the Workflow SDK's own payload encryption is what
 * protects it, and the control plane's row still holds a digest only.
 *
 * **Nothing in this repository starts a pass automatically yet.** ADR 0016's
 * Phase 0 scenario drives the claim endpoint itself and leaves the Run
 * claimable, so wiring dispatch into the ingress spine would dispatch every Run
 * before that scenario could reach it. `dispatchHostedPass` is the entry point
 * the scenario ([#58](https://github.com/nick-neely/reprove/issues/58)) and the
 * tests call; saying so is the point, because an exported function with no
 * caller reads like a live path.
 */
import type { ClaimGrant } from "@reprove/protocol/v1";
import type { HostedPassOutcome } from "@reprove/worker-hosted";
/**
 * What a deployment that composed no hosted placement answers with.
 *
 * It is a value rather than a throw because it is not a failure: a self-hosted
 * control plane not executing hosted passes is the deployment working as ADR
 * 0010 describes it. A throw would put a retry loop and an alert behind a
 * correct configuration.
 */
export interface HostedNotComposed {
    readonly kind: "not_composed";
}
/** How one hosted pass ended, or that this deployment composes none. */
export type PassOutcome = HostedNotComposed | HostedPassOutcome;
/**
 * The Phase 0 build version a hosted pass reports as its own.
 *
 * A fixture, and the same shape a self-hosted Worker's would be: ADR 0006 makes
 * `workerBuildVersion` a Worker's statement about itself, and the hosted
 * placement's build is the deployment's. It is a constant here because lockstep
 * versioning (ADR 0010) means there is nothing else it could honestly be until
 * a release pipeline stamps one.
 */
export declare const HOSTED_WORKER_BUILD_VERSION = "0.0.0";
/**
 * One hosted Worker's attempt at one Run.
 *
 * @param grant The claim grant, which carries the Run's spec and the token the
 *   execution submits with.
 * @param ownerId The Owner the Run belongs to, which every step scopes to.
 * @returns How the pass ended.
 */
export declare function hostedPass(grant: ClaimGrant, ownerId: number): Promise<PassOutcome>;
```

## dist/placement.d.ts

```ts
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
export declare const composeHostedPlacement: (load: () => Promise<{
    readonly hostedPlacement: HostedPlacement;
}>, specifier?: string) => Promise<HostedPlacement | null>;
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
export declare const hostedPlacement: () => Promise<HostedPlacement | null>;
```
