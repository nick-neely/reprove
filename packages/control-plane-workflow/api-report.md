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
 * the builder follows a bare import only into a package that does. Starting
 * one goes through `startDelivery()`, which the control plane is composed
 * with; nothing else in Reprove calls `start()`.
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
/** How one lifecycle ended, which is its return value. */
export type LifecycleOutcome =
/** This lifecycle closed the unclaimed window. */
{
    readonly kind: "unscheduled";
}
/** This lifecycle closed the executing window: nobody came back for the Run. */
 | {
    readonly kind: "worker_lost";
    /** Which side of Acceptance's window it was abandoned on. */
    readonly lostFrom: string;
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
 * Schedules one Run.
 *
 * @param runId The Run.
 * @param ownerId The Owner the Run belongs to, which every step scopes to.
 * @returns How this lifecycle ended.
 */
export declare function runLifecycle(runId: string, ownerId: number): Promise<LifecycleOutcome>;
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
