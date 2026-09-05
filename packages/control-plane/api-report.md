<!-- Generated from the packed artifact by tools/verify-packages.mjs.
     Run `pnpm verify:packages --update` to accept an intended API change. -->

# @reprove/control-plane

## dist/auth/auth.d.ts

```ts
import type { GithubOptions } from "better-auth/social-providers";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
/** The GitHub App's OAuth credentials. Not read from the environment. */
export interface GitHubAppCredentials {
    readonly clientId: string;
    readonly clientSecret: string;
}
/**
 * What `createAuth()` composes over. No value here is read from the
 * environment, and every one of them is checked before an instance exists -
 * Better Auth would otherwise fall back to `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL`, which is the ambient resolution this package refuses for
 * the same reason `pg` may not resolve a connection string from `PGHOST`.
 */
export interface AuthConfig {
    /**
     * The Drizzle client the four tables are reached through. It is **not** a
     * tenant transaction: these tables carry no Owner policy, and `withOwner`
     * would be asserting a tenancy the authentication model does not have.
     */
    readonly database: NodePgDatabase<typeof schema>;
    /**
     * The signing secret, which is also what the OAuth token encryption key is
     * derived from. Rotating it invalidates every stored token.
     */
    readonly secret: string;
    /** The origin Better Auth builds its callback URLs from. */
    readonly baseURL: string;
    readonly github: GitHubAppCredentials;
}
/** The composed instance. */
export type Auth = ReturnType<typeof createAuth>;
/**
 * Composes Better Auth against Reprove's adopted tables.
 *
 * @param config The database client and the credentials, passed in rather than
 *   read from anywhere.
 * @returns The Better Auth instance.
 * @throws {TypeError} Naming the field, when a credential or the secret is
 *   absent, null or empty.
 */
export declare const createAuth: (config: AuthConfig) => import("better-auth").Auth<{
    secret: string;
    baseURL: string;
    database: (options: import("better-auth").BetterAuthOptions) => import("better-auth").DBAdapter<import("better-auth").BetterAuthOptions>;
    account: {
        encryptOAuthTokens: true;
    };
    socialProviders: {
        github: GithubOptions;
    };
    telemetry: {
        enabled: false;
    };
}>;
```

## dist/auth/token-grant.d.ts

```ts
/**
 * The check [ADR
 * 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md) states
 * as a code requirement rather than a documented intention:
 *
 * > Reprove verifies at authentication and refresh time that GitHub issued an
 * > expiring access token and a refresh token, and refuses or fails
 * > configuration loudly otherwise.
 *
 * The reasoning it rests on: a GitHub App user access token expires in eight
 * hours and is backed by a six-month refresh token, which is what makes keeping
 * a person's credential in Reprove's database defensible at all. Both halves
 * come from the App's **"Expire user authorization tokens"** setting. It is
 * default-on for a new App and it is still a toggle, and opting out changes
 * nothing observable at sign-in: the flow succeeds, a token is stored, and it
 * is a permanent one. That is the failure that succeeds quietly, which ADR 0004
 * bans outright.
 *
 * A pure function over the grant, deliberately: the condition is a property of
 * a value, so it is falsifiable from a literal with no network and no App.
 */
/**
 * The part of an OAuth grant this assertion is about.
 *
 * Structurally compatible with Better Auth's `OAuth2Tokens` without naming it,
 * so the check is measurable from a literal and holds no opinion about where
 * the grant came from. Better Auth maps GitHub's `expires_in` to
 * `accessTokenExpiresAt` and leaves it `undefined` when the field is absent,
 * which is exactly the non-expiring case.
 */
export interface GitHubTokenGrant {
    readonly accessToken?: string | undefined;
    readonly refreshToken?: string | undefined;
    readonly accessTokenExpiresAt?: Date | undefined;
}
/**
 * What `createAuth()`'s GitHub seam throws instead of storing the grant.
 *
 * `CONTEXT.md`'s noun is **Refusal**; the `Error` suffix is the JavaScript
 * convention for a throwable and is not a second domain word. It is not a
 * `BootRefusalError`, because this is not the boot assertion: it refuses one
 * sign-in or one refresh, at the moment GitHub answered, rather than refusing
 * to return a database client.
 */
export declare class GitHubTokenGrantError extends Error {
    /** Every condition the grant broke, in the order they are checked. */
    readonly conditions: readonly string[];
    constructor(conditions: readonly string[]);
}
/**
 * Every condition the grant breaks, empty when it is the grant ADR 0008
 * assumes.
 *
 * `no access token` is separate from `non-expiring access token` rather than
 * absorbed by it, because the two send a reader to different places: one is a
 * broken exchange, the other is the App setting.
 *
 * @param grant The token response, as Better Auth mapped it.
 * @returns One condition per broken clause.
 */
export declare const gitHubTokenGrantConditions: (grant: GitHubTokenGrant) => string[];
/**
 * Loudly, and before the grant is written anywhere.
 *
 * @param grant The token response, as Better Auth mapped it.
 * @throws {GitHubTokenGrantError} Naming every condition the grant broke and
 *   the App setting that produces them.
 */
export declare const assertGitHubTokenGrant: (grant: GitHubTokenGrant) => void;
```

## dist/bin.d.ts

```ts
#!/usr/bin/env node
export {};
```

## dist/control-plane.d.ts

```ts
import type { CheckOutcome } from "./db/refusal.js";
import type { GitHubFetch } from "./github/client.js";
import type { DeliveryToProcess, ProcessedDelivery } from "./github/delivery.js";
import type { Phase0RunProfile } from "./github/profile.js";
/** The database connection, as configuration rather than as a client. */
export interface ControlPlaneDatabaseConfig {
    /**
     * The **pooled** endpoint, as the restricted runtime role. Never the admin
     * credential and never the direct endpoint.
     */
    readonly connectionString: string;
    /** Client connections the pool may hold open. */
    readonly poolSize?: number;
    /** Called when the pool's connection fails while idle. */
    readonly onConnectionError?: (error: Error) => void;
}
/** The App's webhook seam, and the authority it reads GitHub back with. */
export interface ControlPlaneGitHubConfig {
    /** The webhook secret the App was registered with. */
    readonly webhookSecret: string;
    /** GitHub's numeric App id, which is the App JWT's issuer. */
    readonly appId: string;
    /** The App's private key, PEM-encoded, in either PKCS#1 or PKCS#8. */
    readonly privateKey: string;
    /**
     * ADR 0013's injected profile: the half of a Run's immutable spec no pull
     * request can influence. There is deliberately no default - a value the
     * package chose silently is exactly the "prototype wiring becoming product
     * selection policy" the ADR built the profile to prevent - so the composition
     * root passes `PHASE_0_RUN_PROFILE` or something of its own.
     */
    readonly runProfile: Phase0RunProfile;
    /** The largest delivery body to accept, in bytes. */
    readonly maximumDeliveryBytes?: number;
    /** GitHub's REST root. Defaults to `https://api.github.com`. */
    readonly apiUrl?: string;
    /** The per-request timeout, in milliseconds. */
    readonly requestTimeoutMs?: number;
    /**
     * The transport. Defaults to the global `fetch`, and exists as configuration
     * because ADR 0016's acceptance scenario substitutes GitHub "only at the
     * transport" - so the JWT, the exchange, the request shape and the response
     * parsing all execute for real against a canned body.
     */
    readonly fetch?: GitHubFetch;
}
/** Everything the control plane is composed over. */
export interface ControlPlaneConfig {
    readonly database: ControlPlaneDatabaseConfig;
    readonly github: ControlPlaneGitHubConfig;
}
/** The composed control plane, as the app holds it. */
export interface ControlPlane {
    /** Every boot check's outcome, kept so a deployment can log what it proved. */
    readonly checks: readonly CheckOutcome[];
    /** `POST /api/github/webhook`. */
    readonly handleGitHubWebhook: (request: Request) => Promise<Response>;
    /**
     * Turns one committed delivery into its Run, or into the conclusion that
     * there is none.
     *
     * The webhook kicks this and does not await it, which is ADR 0013's order.
     * It is **also** exposed here on purpose: the ADR makes an automatic re-drive
     * of `contended` and `transient` dispositions a Phase 0 exit condition and
     * hands the mechanism to
     * [#38](https://github.com/nick-neely/reprove/issues/38), so the durable
     * scheduler needs a way in that is not a webhook request. Calling it twice
     * for one delivery is safe: the second attempt settles nothing, because
     * `done` and `discarded` are terminal.
     */
    readonly processDelivery: (delivery: DeliveryToProcess) => Promise<ProcessedDelivery>;
    /** Drains the connection pool. */
    readonly close: () => Promise<void>;
}
/**
 * Opens the runtime connection, proves the tenant boundary, and composes the
 * routes over it.
 *
 * The webhook's commit port is bound to a `withOwner` transaction here, and
 * that binding is what makes ADR 0013's ordering true end to end: the handler
 * awaits a call that resolves only once the transaction has committed, so the
 * acknowledgement cannot precede the row.
 *
 * @param config The pooled connection and the App's webhook secret.
 * @returns The composed control plane.
 * @throws {TypeError} Naming the field, when a required value is absent or empty.
 * @throws {import("./db/refusal.js").BootRefusalError} Naming every tenancy
 *   assertion that failed.
 */
export declare const createControlPlane: (config: ControlPlaneConfig) => Promise<ControlPlane>;
```

## dist/db/bootstrap.d.ts

```ts
/** What `bootstrap()` connects with. No value here is read from the environment. */
export interface BootstrapConfig {
    /**
     * The **admin** connection on the direct endpoint: the role that owns the
     * tables and applies the migrations.
     */
    readonly connectionString: string;
    /** The password the runtime role will authenticate with. */
    readonly runtimePassword: string;
}
/**
 * Provisions the restricted runtime role and the reach it has *before* any table
 * exists, idempotently.
 *
 * The role name is not configurable. The committed policies name it, so a
 * deployment that renamed it would migrate a boundary granted to a role that
 * does not exist. It is exported as {@link RUNTIME_ROLE} instead.
 *
 * **Run this before `migrate()`.** `CREATE POLICY ... TO "reprove_runtime"`
 * fails outright if the role does not exist yet, so the two commands are
 * ordered rather than interchangeable.
 *
 * What it takes **away** is as much of the point as what it grants: the negative
 * flags in {@link ROLE_FLAGS}, `CREATE` on `public`, `TEMPORARY` on the
 * database, and every membership the role holds - see
 * {@link revokeMemberships}. Each of those is something the boot assertion
 * refuses, and re-running this is how an operator repairs one.
 *
 * What it does **not** do is grant anything on Reprove's tables. Those grants
 * name the managed tables one by one and are issued by `migrate()`, which is the
 * only moment those tables are known to exist; see
 * {@link import("./privileges.js").applyRuntimeGrants} for why naming them
 * matters. Re-running `migrate()` is therefore how a table grant is repaired,
 * and re-running `bootstrap` remains safe at any point.
 *
 * **Run it as the same role that runs `migrate()`.** A default privilege is
 * recorded against the role that granted it, so the `drizzle` ledger grant below
 * reaches a migration ledger only when the same admin creates it. That fails
 * closed - the boot assertion refuses on `permission denied` - and re-running
 * `bootstrap` as the migrating role is the repair.
 *
 * **Two of these started together survive each other.** Everything it provisions
 * runs in one transaction that takes {@link BOOTSTRAP_LOCK} first, so bootstraps
 * against one database queue; the runtime role is cluster-wide, so bootstraps
 * against *different* databases in one cluster can still meet on it, and a
 * bootstrap that loses that race re-runs its own transaction - see
 * {@link CONTENDED_ATTEMPTS}. A deployment scaling out and a test suite running
 * a database per file are the same case.
 *
 * @param config The admin connection and the runtime role's password.
 * @throws {TypeError} If either field is not a non-empty string. A JavaScript
 *   caller can omit one, and neither omission fails loudly on its own.
 */
export declare const bootstrap: (config: BootstrapConfig) => Promise<void>;
```

## dist/db/checks.d.ts

```ts
import type { Pool } from "pg";
import type { Classification } from "./classification.js";
import type { CheckOutcome } from "./refusal.js";
/**
 * Runs all seven checks and reports every outcome, failures included.
 *
 * A check that throws is a failed check rather than a thrown error, so one
 * unreachable catalog view cannot hide the six answers beside it.
 *
 * @param pool A pool on the **runtime** connection. Reading these facts through
 *   the admin connection would measure a privilege set the application never
 *   uses.
 * @param classification The classification to measure against. The parameter
 *   exists so a test can present a deliberately malformed one; production code
 *   never passes it, and `createRuntimeDb()` does not expose it.
 * @returns One outcome per check, in the order ADR 0008 lists them.
 */
export declare const runBootChecks: (pool: Pool, classification?: Classification) => Promise<CheckOutcome[]>;
/**
 * Rule 6 as an assertion: either every check passed, or nothing is returned.
 *
 * @param pool A pool on the runtime connection.
 * @param classification See {@link runBootChecks}.
 * @returns Every check's outcome, once they have all passed.
 * @throws {BootRefusalError} Naming every check that failed and why.
 */
export declare const assertTenantBoundary: (pool: Pool, classification?: Classification) => Promise<CheckOutcome[]>;
```

## dist/db/classification.d.ts

```ts
import { PgTable } from "drizzle-orm/pg-core";
/**
 * A table's SQL name, which is the only form the catalog and `pg_policies`
 * speak.
 *
 * @param table Any table from the schema module.
 * @returns The unqualified table name as Postgres holds it.
 */
export declare const tableName: (table: PgTable) => string;
/**
 * The SQL names of a set of tables, sorted, for a message a reader can scan.
 *
 * @param tables Any set of tables.
 * @returns Their SQL names in lexical order.
 */
export declare const tableNames: (tables: readonly PgTable[]) => string[];
/** Every Owner-scoped table. Each carries the Owner id denormalized. */
export declare const TENANT_TABLES: readonly PgTable[];
/**
 * Better Auth's four, adopted into Reprove's migration history and deliberately
 * outside Owner RLS: a User can legitimately reach several Owners.
 */
export declare const NON_TENANT_TABLES: readonly PgTable[];
export declare const MANAGED_TABLES: readonly PgTable[];
/** The classification the boot assertion reads. */
export interface Classification {
    readonly managed: readonly PgTable[];
    readonly tenant: readonly PgTable[];
    readonly nonTenant: readonly PgTable[];
}
/** The real classification, and the default every check is measured against. */
export declare const CLASSIFICATION: Classification;
```

## dist/db/config.d.ts

```ts
/**
 * What the three exported entry points check about their own configuration
 * before they open anything.
 *
 * TypeScript states these preconditions; it cannot enforce them. The package
 * ships as JavaScript, so a consumer is free to hand `bootstrap()` an object
 * whose `connectionString` is missing, and every type in this folder says that
 * cannot happen. What follows is worse than a crash, twice over:
 *
 * - `pg` resolves an absent connection string from the ambient `PGHOST`,
 *   `PGUSER` and `PGDATABASE` variables, so the command reaches whatever
 *   database the shell happened to name rather than failing.
 * - `format('%L', NULL)` renders the bare token `NULL`, so an absent
 *   `runtimePassword` provisions the restricted role with **no password at
 *   all** - the one role in this design whose credential is the boundary.
 *
 * Both are the class ADR 0004 bans outright: a failure that succeeds quietly.
 * So the field is named and the call is refused before a pool exists.
 */
/**
 * A configuration field as it actually arrives.
 *
 * The three absent forms are named because they are the ones a caller produces
 * without meaning to: a property nobody set, an environment variable that was
 * never exported, and a `null` from parsed JSON. A field holding some other type
 * entirely is a different mistake, and not one this guard pretends to catch.
 */
export type SuppliedField = string | null | undefined;
/**
 * The value, or a refusal naming the field it arrived on.
 *
 * @param value The field as it arrived.
 * @param field The field's qualified name, which is what the reader has to go
 *   and fix.
 * @returns The value, narrowed to a non-empty string.
 * @throws {TypeError} Naming the field and showing what it held.
 */
export declare const requireNonEmpty: (value: SuppliedField, field: string) => string;
```

## dist/db/declared.d.ts

```ts
import type { Classification } from "./classification.js";
/**
 * The set arithmetic ADR 0017 states, and nothing else:
 *
 * ```text
 * MANAGED_TABLES == TENANT_TABLES ∪ NON_TENANT_TABLES
 * TENANT_TABLES  ∩  NON_TENANT_TABLES == ∅
 * ```
 *
 * The managed set is enumerated from the schema module's `pgTable` exports, so
 * a table added there and left out of both declared sets is a problem here
 * rather than a table sitting silently outside the tenant boundary.
 *
 * Shared with the boot assertion, which adds the one clause that needs a
 * database to answer.
 *
 * @param classification The classification to measure.
 * @returns One message per broken clause, empty when the three hold.
 */
export declare const classificationProblems: (classification: Classification) => string[];
/**
 * Everything the schema module alone can be held to.
 *
 * @param classification The classification to measure. Defaults to the real one,
 *   which is what the test asserting the repository holds passes.
 * @returns One message per problem, empty when the committed schema intends the
 *   boundary.
 */
export declare const checkDeclaredTenancy: (classification?: Classification) => string[];
```

## dist/db/force-generate.d.ts

```ts
import type { Classification } from "./classification.js";
import type { ForceOperation } from "./force.js";
/** What the generator wrote, for the caller that has to report it. */
export interface ForceMigration {
    /** The journal tag, which is also the `.sql` file's basename. */
    readonly tag: string;
    readonly operations: readonly ForceOperation[];
}
export interface EmitOptions {
    /** The migration folder to append to. Defaults to this package's own. */
    readonly folder?: string;
    /** The classification the delta is derived from. */
    readonly classification?: Classification;
    /**
     * The journal timestamp. Drizzle applies only migrations whose `when` exceeds
     * the newest applied one, so it is taken as strictly later than the last entry
     * rather than trusted from the clock.
     */
    readonly now?: number;
}
/**
 * Appends one custom migration carrying the FORCE delta, or nothing at all.
 *
 * The three artifacts are the three drizzle-kit writes for a `generate --custom`
 * migration, and they are written together because a journal entry naming a
 * missing file, or a snapshot chain with a hole in it, is a migration folder
 * every other reader of it would refuse.
 *
 * @param options See {@link EmitOptions}.
 * @returns What was appended, or `null` when the history already agrees with the
 *   classification.
 * @throws {Error} If the folder holds no migration to chain a snapshot onto.
 *   The initial schema is drizzle-kit's to generate, never this generator's.
 */
export declare const emitForceMigration: (options?: EmitOptions) => ForceMigration | null;
```

## dist/db/force.d.ts

```ts
import type { Classification } from "./classification.js";
import type { Policy } from "./policy.js";
/**
 * The first line of every migration this generator owns. It is what separates a
 * generated file from a hand-authored custom one, and the verifier holds
 * everything under it to the grammar below.
 */
export declare const FORCE_MARKER = "-- reprove:force-row-level-security";
/** One table left forced, or explicitly not, by one generated statement. */
export interface ForceOperation {
    readonly table: string;
    readonly forced: boolean;
}
/** One journaled migration, as the three checks below need to see it. */
export interface MigrationSource {
    readonly idx: number;
    readonly tag: string;
    /** The raw file text, which is also what Drizzle hashes. */
    readonly sql: string;
    /**
     * Who wrote it. `drizzle` advanced the snapshot, so drizzle-kit generated it
     * from the schema module; the other two share their parent's snapshot, and
     * the marker separates them.
     */
    readonly kind: "drizzle" | "generator" | "hand-authored";
}
interface JournalEntry {
    idx: number;
    tag: string;
    when: number;
}
/** The journal, which is drizzle-kit's own output and the order of record. */
export declare const readJournal: (folder: string) => JournalEntry[];
/** The snapshot drizzle-kit chained to one journal entry. */
export declare const snapshotFile: (folder: string, idx: number) => string;
/**
 * Every journaled migration in order, each attributed to the author whose rules
 * it is then held to.
 *
 * The attribution is measured rather than declared, because drizzle-kit marks
 * nothing: `generate` writes a snapshot reflecting the new schema, and
 * `generate --custom` writes its parent's content back out unchanged apart from
 * the snapshot's own identity. A migration whose snapshot did not advance is
 * therefore a custom one, and the marker separates the generator's from a
 * human's.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One entry per journal entry, in journal order.
 */
export declare const readMigrationSources: (folder?: string) => MigrationSource[];
/**
 * The generated file, which is the only thing that ever writes this grammar.
 * {@link parseForceMigration} is its exact inverse, and `force.test.ts` holds
 * the two to that.
 *
 * @param operations The operations to emit, in the order they should apply.
 * @returns The migration file text, trailing newline included.
 */
export declare const renderForceMigration: (operations: readonly ForceOperation[]) => string;
/**
 * A generator-owned migration reduced to the operations it performs, or the
 * reason it is not one.
 *
 * "Exactly", not "contains": a second arbitrary statement may not ride into a
 * file that claims to be generated, because everything downstream of this walk
 * trusts the file to say only what the grammar can say.
 *
 * @param sql The raw file text.
 * @returns The operations in file order, or the first line that broke the
 *   grammar.
 */
export declare const parseForceMigration: (sql: string) => {
    operations: ForceOperation[];
} | {
    problem: string;
};
/**
 * Every migration held to its author's rules.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One message per migration that broke them, empty when the history is
 *   one drizzle-kit generated the schema and one the generator forced it.
 */
export declare const checkMigrationGrammar: (folder?: string) => string[];
/**
 * The FORCE state each table is left in once the whole journal has been applied,
 * in order, with the last relevant operation winning.
 *
 * A table absent from the result was never named by any generated migration.
 * That is a different fact from being named and left `NO FORCE`, and
 * {@link forceStateProblems} reports it differently, because "nobody generated
 * it" and "somebody unforced it" are different mistakes.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns The final state per table, keyed by SQL name.
 */
export declare const effectiveForceState: (folder?: string) => Map<string, boolean>;
/**
 * The delta between what the classification says and what the migration history
 * has already established, which is the whole of what a new generated migration
 * would contain.
 *
 * Symmetric in both directions, because a tenant to non-tenant reclassification
 * is security-significant and leaving the old `FORCE` in place would be the
 * classification and the database disagreeing:
 *
 * ```text
 * tenant     && !forced  ->  FORCE ROW LEVEL SECURITY
 * non-tenant &&  forced  ->  NO FORCE ROW LEVEL SECURITY
 * already matching       ->  nothing
 * ```
 *
 * @param classification The classification the delta is derived from.
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns The operations to append, sorted by table name, empty when the
 *   history already agrees with the classification.
 */
export declare const forceDelta: (classification: Classification, folder?: string) => ForceOperation[];
/**
 * The classification and the migration history, cross-checked.
 *
 * This is the authoring-time half of ADR 0008's fourth boot check. The boot
 * assertion reads `relforcerowsecurity` and sees what a database actually has;
 * this one reads the history and sees whether the pull request would ever have
 * given it one.
 *
 * @param classification The classification to measure against.
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One message per table whose forced state does not follow from its
 *   classification, empty when the delta is empty.
 */
export declare const forceStateProblems: (classification: Classification, folder?: string) => string[];
/** Where the boundary stands once every migration has been read, in order. */
interface EffectiveBoundary {
    /** Every policy in force at the end of history, keyed by SQL table name. */
    readonly policies: Map<string, Policy[]>;
    /** Whether row-level security is enabled, keyed by SQL table name. */
    readonly enabled: Map<string, boolean>;
    /** Statements the walk could not interpret, which are failures, not skips. */
    readonly problems: string[];
}
/**
 * The policy set and RLS enablement the whole journal leaves behind.
 *
 * Every migration is read, whoever wrote it. Attribution decides which rules a
 * *file* is held to; it does not decide whether a statement counts, because a
 * `DROP POLICY` drops the policy just as thoroughly in a file drizzle-kit
 * generated as in one nobody should have written.
 *
 * A boundary statement the walk cannot parse is a **problem**, never a skip.
 * The measurement is only worth what its coverage is worth, and a form nobody
 * anticipated is exactly where a silent gap would sit.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns The state at the end of history, and every statement that refused to
 *   be read.
 */
export declare const effectiveBoundary: (folder?: string) => EffectiveBoundary;
/**
 * The migration history and the schema module, cross-checked on the two facts
 * `FORCE` is defense in depth beside.
 *
 * This is what makes a drizzle-attributed migration trustworthy rather than
 * trusted. `checkMigrationGrammar` lets such a file carry `CREATE POLICY` and
 * `ENABLE ROW LEVEL SECURITY`, because that is drizzle-kit's own output; only
 * this check knows whether the statements in it are the ones the schema module
 * asked for. A `DROP POLICY` or `DISABLE ROW LEVEL SECURITY` edited into one
 * fails here, at authoring time, rather than waiting for the live-catalog check
 * at boot.
 *
 * @param classification The classification to measure against.
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One message per table the history leaves outside its classification.
 */
export declare const boundaryProblems: (classification: Classification, folder?: string) => string[];
export {};
```

## dist/db/index.d.ts

```ts
/**
 * Persistence: the schema, the two database paths, and the boot assertion
 * between them.
 *
 * ```text
 * bootstrap()        -> admin connection, explicit operator command, SQL only
 * migrate()          -> admin connection, explicit operator command
 * createRuntimeDb()  -> restricted runtime connection
 *                    -> rule 6's seven checks must pass
 *                    -> otherwise refuse to return a client
 * ```
 *
 * `bootstrap` and `migrate` are **ordered**, not interchangeable: a policy names
 * the role it applies to, so the role has to exist before the first migration
 * runs.
 *
 * This is the **package-internal** barrel and reaches everything, Drizzle types
 * included. `src/index.ts` publishes a strict subset: ADR 0010 forbids
 * `apps/control-plane` from depending on `drizzle-orm` or a Postgres driver, so
 * a published signature naming either would hand the only consumer a type it is
 * not allowed to import.
 *
 * The tables are deliberately absent: `./schema.js` is imported directly by the
 * code that queries them, because re-exporting the namespace from here would
 * pull Drizzle's whole module graph through one barrel.
 */
export type { BootstrapConfig } from "./bootstrap.js";
export { bootstrap } from "./bootstrap.js";
export { assertTenantBoundary, runBootChecks } from "./checks.js";
export type { Classification } from "./classification.js";
export { CLASSIFICATION, MANAGED_TABLES, NON_TENANT_TABLES, tableName, tableNames, TENANT_TABLES, } from "./classification.js";
export type { MigrateConfig } from "./migrate.js";
export { migrate } from "./migrate.js";
export type { CommittedMigration } from "./migrations.js";
export { MIGRATIONS_FOLDER, readCommittedMigrations } from "./migrations.js";
export type { CheckName, CheckOutcome } from "./refusal.js";
export { BootRefusalError } from "./refusal.js";
export { RUNTIME_ROLE } from "./roles.js";
export type { RuntimeDb, RuntimeDbConfig, TenantTransaction, } from "./runtime.js";
export { createRuntimeDb } from "./runtime.js";
```

## dist/db/migrate.d.ts

```ts
/** What `migrate()` connects with. No value here is read from the environment. */
export interface MigrateConfig {
    /** The **admin** connection on the direct endpoint. Never the runtime role. */
    readonly connectionString: string;
}
/**
 * Applies every committed migration that has not been applied yet, then brings
 * the runtime role's privileges on the managed tables to exactly what
 * `privileges.ts` declares.
 *
 * The grants live here rather than in `bootstrap()` because they name the
 * managed tables one by one, and the only moment those tables are known to exist
 * is after the migrations have run. That has a consequence worth stating: a
 * `migrate()` that applied nothing still re-applies the grants, so re-running it
 * is how an operator repairs a privilege that drifted.
 *
 * It refuses if the runtime role is missing, rather than failing halfway
 * through: the generated migrations carry `CREATE POLICY ... TO
 * "reprove_runtime"`, which errors outright when the role does not exist, and
 * "run bootstrap first" is a better thing to read than a Postgres role error
 * raised from inside migration `0000`.
 *
 * Drizzle applies only migrations whose `folderMillis` exceeds the newest
 * `created_at` in the ledger, so a journal entry appended with an *older*
 * timestamp than one already applied is skipped here and reported as pending by
 * the boot assertion forever. ADR 0017's authoring-time append-only verifier is
 * what keeps the journal from reaching that state; there is no recovery from
 * this side.
 *
 * @param config The admin connection.
 * @returns The journal tags this call applied, in order. An empty array means
 *   the database was already up to date, not that nothing happened: the grants
 *   were re-applied either way.
 * @throws {TypeError} If the connection string is not a non-empty string; `pg`
 *   would otherwise resolve an absent one from the ambient `PG*` variables and
 *   migrate whatever database the shell happened to name.
 * @throws {Error} If `bootstrap()` has not run against this cluster.
 */
export declare const migrate: (config: MigrateConfig) => Promise<string[]>;
```

## dist/db/migrations.d.ts

```ts
/**
 * The folder `drizzle-kit generate` writes to, resolved from this module's own
 * location. `src/db/` and `dist/db/` sit the same distance below the package
 * root, so one expression serves the source tree and the packed artifact.
 */
export declare const MIGRATIONS_FOLDER: string;
/** One committed migration, joined to the journal entry that names it. */
export interface CommittedMigration {
    /** The journal tag, which is what a refusal names. */
    readonly tag: string;
    /** `journal.when`, written verbatim as `created_at` when the migration applies. */
    readonly folderMillis: number;
    /** `sha256` of the entire raw `.sql` file, as Drizzle computes and stores it. */
    readonly hash: string;
}
/**
 * Every committed migration in journal order.
 *
 * The hash and `folderMillis` come from Drizzle's own `readMigrationFiles`, so
 * they are the exact values `migrate()` writes into
 * `drizzle.__drizzle_migrations`; the tag comes from the journal beside them.
 * Computing either independently would be a reimplementation that could drift
 * from the thing it is supposed to be comparing against.
 *
 * @param folder The migration folder to read. Defaults to this package's own.
 * @returns One entry per journal entry, in journal order.
 */
export declare const readCommittedMigrations: (folder?: string) => CommittedMigration[];
```

## dist/db/policy.d.ts

```ts
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
/** A policy as either the schema module declares it or the catalog holds it. */
export interface Policy {
    readonly name: string;
    readonly permissive: boolean;
    readonly command: string;
    readonly roles: readonly string[];
    readonly using: string;
    readonly withCheck: string;
}
export declare const describePolicy: (policy: Policy) => string;
export declare const samePolicy: (a: Policy, b: Policy) => boolean;
/** Everything about a policy except the two predicates, which are reduced. */
type RawPolicy = Omit<Policy, "using" | "withCheck"> & {
    readonly using: string;
    readonly withCheck: string;
};
/**
 * One policy with both predicates reduced to comparable form, or the reason
 * neither side can be compared.
 *
 * Every policy that reaches {@link samePolicy}, declared or live, is built here,
 * which is what makes the connective refusal unskippable: the comparison has no
 * other way to obtain a `Policy`.
 *
 * @param table The SQL name of the table the policy is attached to.
 * @param raw The policy as its own side spells it.
 * @returns The comparable policy, or the connective that refused it.
 */
export declare const comparablePolicy: (table: string, raw: RawPolicy) => {
    policy: Policy;
} | {
    problem: string;
};
/**
 * The column carrying the tenant key. It is `owner_id` on every Owner-scoped
 * table except `owner` itself, whose own primary key *is* GitHub's numeric Owner
 * id - which is why there is no second identifier beside it.
 *
 * @param table A tenant table.
 * @returns The column the canonical policy compares.
 * @throws {Error} If the table carries neither, which no tenant table may.
 */
export declare const tenantKey: (table: PgTable) => PgColumn;
/**
 * The single policy a tenant table declares, or the reason there is not exactly
 * one of it.
 *
 * @param table A tenant table.
 * @returns The declared policy in comparable form, or the problem.
 */
export declare const declaredPolicy: (table: PgTable) => {
    policy: Policy;
} | {
    problem: string;
};
/**
 * The canonical policy a tenant table must carry, rendered by the pinned dialect
 * rather than compared against a frozen SQL literal.
 *
 * That is what preserves ADR 0008's hardest-won fix - `nullif(...)` rather than
 * the bare cast, which is correct on every unpooled connection and an outage
 * behind PgBouncer after a reset - without fossilising its spelling. A
 * hand-rolled policy carrying that exact bug fails against this, where a "has a
 * policy on the runtime role" check would pass it.
 *
 * What is still declared here is the convention around the predicate: the
 * policy's name, and which column is the tenant key.
 *
 * @param table A tenant table.
 * @returns The policy the table is required to declare, in comparable form.
 * @throws {Error} If the canonical policy itself cannot be reduced, which would
 *   mean `tenantPolicy()` had grown a boolean connective.
 */
export declare const canonicalPolicy: (table: PgTable) => Policy;
export {};
```

## dist/db/predicate.d.ts

```ts
/**
 * One policy predicate, reduced to the form two deparsers agree on.
 *
 * Postgres re-prints a stored expression through its own deparser, so the text
 * in `pg_policies` never matches the text Drizzle rendered even when the two
 * mean the same thing: it uppercases function names, adds `::text` to every
 * string literal, unquotes what it can and re-parenthesises freely. Comparing
 * the two therefore needs a normal form, and this module is the whole of it.
 *
 * It is separated from `checks.ts` because it is pure: no database, no Drizzle,
 * no catalog. That is what lets `predicate.test.ts` measure the three
 * distinctions the tenant boundary actually rests on - identifier folding,
 * literal opacity, and the refusal below - without a Postgres to run against.
 */
/** A predicate reduced to comparable form, or the reason it cannot be. */
export type NormalizedPredicate = {
    readonly normalized: string;
} | {
    readonly connective: string;
};
/**
 * One predicate reduced to the form both deparsers agree on.
 *
 * Two reductions run over the token stream. `::text` goes because Postgres adds
 * one to every string literal and Drizzle does not. The table qualifier goes
 * because Drizzle renders `"run"."owner_id"` where Postgres, which already
 * knows the relation, renders `owner_id`.
 *
 * @param expression A policy predicate from either side.
 * @param table The SQL name of the table the policy is attached to.
 * @returns The predicate as a token sequence, or the connective that refused it.
 */
export declare const normalizePredicate: (expression: string, table: string) => NormalizedPredicate;
```

## dist/db/privileges.d.ts

```ts
/**
 * What the runtime role may do, spelled once and read by all three places that
 * care: `bootstrap()` and `migrate()`, which grant it, and the boot assertion,
 * which refuses when the live grants say something else.
 *
 * The reach is **manifest-scoped**, not schema-wide. A `grant ... on all tables
 * in schema public` and an `alter default privileges ... on tables` both say
 * "whatever is in this schema", and a schema is a place a neighbour may
 * legitimately put a table ([ADR
 * 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * permits Vercel Workflow to share the server). Naming the managed tables one by
 * one is what keeps a grant from arriving at a relation nobody classified - and
 * a relation nobody classified is one the boot assertion never measured for a
 * tenant policy.
 *
 * A **view** is the sharpest form of that. A view runs as its owner unless it
 * carries `security_invoker`, so an admin-owned view over a tenant table reads
 * every Owner's rows, and a schema-wide grant hands it over.
 *
 * What the role may **be** is here for the same reason. A membership is a
 * privilege path as surely as a grant is, and the one no privilege query
 * answers, so the rule against it has the same two ends: `bootstrap()` revokes
 * one and the boot assertion refuses one - see {@link revokeMemberships}.
 */
import type { PoolClient } from "pg";
/**
 * What the runtime role holds on a managed table. Exactly the four the
 * application needs, and the list is a SQL fragment because `GRANT` takes no
 * bind parameter for a privilege name.
 */
export declare const RUNTIME_TABLE_PRIVILEGES = "select, insert, update, delete";
/**
 * The privileges on a managed table the runtime role must **not** hold, revoked
 * on every `migrate()` and refused by the boot assertion.
 *
 * `TRUNCATE` is the one that matters most and the one a schema-wide grant never
 * mentioned: it ignores row-level security entirely, so a role holding it can
 * empty another Owner's table through a boundary that denies it every single
 * row. `REFERENCES` and `TRIGGER` are DDL rights on someone else's table, which
 * an application role has no use for.
 */
export declare const WITHHELD_TABLE_PRIVILEGES: string[];
/**
 * The privileges whose presence means the role can reach a relation at all.
 *
 * Used against relations **outside** the managed set, where holding any one of
 * them is the failure. `has_table_privilege` answers for a view and a foreign
 * table as readily as for a table, which is the point: `relkind = 'r'` was the
 * hole a view walked through.
 */
export declare const REACHING_TABLE_PRIVILEGES: string[];
/**
 * Runs one DDL statement whose variable parts Postgres itself quotes.
 *
 * `format('%I', ...)` and `format('%L', ...)` are why a role name, a password or
 * a table name travels as a bind parameter rather than as interpolated text: DDL
 * takes no parameters, so something has to do the quoting, and Postgres's own
 * quoting is the one thing guaranteed to agree with Postgres's own parser.
 *
 * @param client A connected admin client.
 * @param template A `format()` template, with the fixed SQL written out.
 * @param args One value per placeholder, in order.
 */
export declare const ddl: (client: PoolClient, template: string, ...args: string[]) => Promise<void>;
/**
 * Brings the runtime role's privileges on the managed tables to exactly what
 * this module declares, and touches nothing else.
 *
 * Run by `migrate()` on the admin connection after the migrations have applied,
 * which is the only moment at which the managed tables are known to exist. It is
 * idempotent, so re-running `migrate()` on an up-to-date database is how an
 * operator repairs a grant that drifted.
 *
 * Both halves matter and neither implies the other. The grant is what lets the
 * application work; the revoke is what stops a privilege granted out of band -
 * or by an older version of this code, which granted schema-wide - from
 * outliving the decision that it should not exist.
 *
 * @param client A connected admin client, inside a transaction.
 * @param tables The SQL names of the managed tables.
 */
export declare const applyRuntimeGrants: (client: PoolClient, tables: readonly string[]) => Promise<void>;
/**
 * Revokes every membership the given role holds, and reports what it revoked.
 *
 * The negative counterpart of {@link applyRuntimeGrants}, and it lives here for
 * the same reason: the boot assertion refuses a runtime role that is a member of
 * anything at all, so the rule has two ends - the refusal in `checks.ts` and the
 * repair `bootstrap()` runs - and one place to be stated.
 *
 * Why every membership rather than the dangerous ones: a membership is a
 * `SET ROLE` path the checks cannot see through, because every privilege they
 * read is `current_user`'s own. Whatever a granted role holds is invisible to
 * all seven of them, so the membership itself is the misconfiguration, and
 * nothing in this design needs one.
 *
 * A `REVOKE` needs `ADMIN OPTION` on the granted role. The role that owns the
 * tables and applies the migrations has it over anything it granted; where it
 * does not, this fails the way every other statement in the bootstrap
 * transaction fails - loudly, having applied nothing.
 *
 * @param client A connected admin client, inside a transaction.
 * @param member The role to strip. Production passes {@link RUNTIME_ROLE} and
 *   nothing else; the parameter is what lets the repair be measured on a role of
 *   a test's own, because granting a membership to the cluster-wide runtime role
 *   would refuse every boot running beside it.
 * @returns The roles whose membership was revoked, as the catalog listed them.
 */
export declare const revokeMemberships: (client: PoolClient, member: string) => Promise<string[]>;
```

## dist/db/refusal.d.ts

```ts
/**
 * What a failed boot assertion is, as data.
 *
 * Separated from `checks.ts` so that a caller can name the refusal without
 * reaching the Drizzle and `pg` types the checks are implemented with: ADR 0010
 * forbids `apps/control-plane` from depending on either, so neither may appear
 * on this package's published surface.
 */
/** The stable name of each of rule 6's seven checks. */
export type CheckName = "runtime-role-is-not-privileged" | "runtime-role-reaches-only-the-managed-tables" | "every-managed-table-is-classified" | "tenant-tables-are-forced" | "tenant-policies-are-exactly-canonical" | "migrations-match-the-committed-files" | "no-owner-context-reads-empty";
/**
 * One check's outcome. `detail` is what a refusal prints.
 *
 * Not `CheckResult`: `CONTEXT.md` gives **Result** to what a Worker submits for
 * a Run, and a second unrelated meaning for the same noun is exactly the drift
 * the glossary exists to stop. `verdict` is on its avoid list for the same
 * reason.
 */
export interface CheckOutcome {
    readonly name: CheckName;
    readonly ok: boolean;
    readonly detail: string;
}
/**
 * What `createRuntimeDb()` throws instead of returning a client. There is no
 * flag that downgrades this to a warning and no path to a client that skipped
 * it: the assertion lives in the connection factory precisely so that it is
 * unskippable by construction (ADR 0010).
 *
 * `CONTEXT.md`'s noun is **Refusal**; the `Error` suffix is the JavaScript
 * convention for a throwable and is not a second domain word.
 */
export declare class BootRefusalError extends Error {
    readonly checks: readonly CheckOutcome[];
    constructor(checks: readonly CheckOutcome[]);
}
```

## dist/db/roles.d.ts

```ts
/**
 * The database roles by name, and nothing else.
 *
 * Its own module because it is the one persistence fact that reaches the
 * **published** surface: `bootstrap` provisions this role and the bin names it
 * in its usage text, while `schema.ts` and everything else that touches Drizzle
 * stays behind the package boundary (see the README).
 */
/**
 * The restricted role all application traffic runs as.
 *
 * It is a constant rather than configuration because the committed policies name
 * it: a deployment that renamed the role would migrate a tenant boundary granted
 * to a role that does not exist, and every one of rule 6's policy checks would
 * then refuse.
 *
 * `bootstrap()` provisions it as SQL over the admin connection, per ADR 0008 -
 * never a role created in a provider console, because those inherit the
 * privileges this design exists to deny.
 */
export declare const RUNTIME_ROLE = "reprove_runtime";
```

## dist/db/runtime.d.ts

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { CheckOutcome } from "./refusal.js";
import * as schema from "./schema.js";
/** What the runtime connects with. No value here is read from the environment. */
export interface RuntimeDbConfig {
    /**
     * The **pooled** endpoint, as the restricted runtime role. Never the admin
     * credential and never the direct endpoint: ADR 0008 keeps migrations and
     * application traffic on two connections that are never crossed.
     */
    readonly connectionString: string;
    /** Client connections the pool may hold open. Defaults to 8. */
    readonly poolSize?: number;
    /**
     * Called when the pool's own connection to Postgres fails while idle - a
     * restart, a pooler recycling a server connection, a reset network.
     *
     * A handler is attached whether or not one is supplied, because `pg.Pool` is
     * an `EventEmitter` and an unhandled `error` event **takes the process down**.
     * The pool discards the failed client itself, so there is nothing to do but
     * observe; this package holds no logger, so observing is the caller's.
     */
    readonly onConnectionError?: (error: Error) => void;
}
type Database = NodePgDatabase<typeof schema>;
/**
 * A Drizzle transaction with an Owner context already set on it. Every
 * Owner-scoped query belongs inside one.
 */
export type TenantTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Work to run inside a tenant transaction. */
type InTransaction<T> = (tx: TenantTransaction) => Promise<T>;
/** A client that has passed all seven of rule 6's checks. */
export interface RuntimeDb {
    /** Every check's outcome, kept so a deployment can log what it proved. */
    readonly checks: readonly CheckOutcome[];
    /**
     * The single entry point, and there is deliberately no second one. ADR 0008
     * puts *all* access through a call of this shape, so that a tenant-scoped
     * query written outside a tenant transaction is difficult to write by accident
     * rather than merely forbidden by convention. A `withoutOwner` beside this
     * would be the accident, pre-named and ready to reach for.
     *
     * The first argument is GitHub's durable numeric Owner id, which is the
     * tenant key itself.
     */
    readonly withOwner: <T>(ownerId: number, fn: InTransaction<T>) => Promise<T>;
    /** Drains the pool. */
    readonly close: () => Promise<void>;
}
/**
 * Opens the runtime connection, proves the tenant boundary, and returns a client
 * only if every check passed.
 *
 * @param config The pooled runtime connection and its pool size.
 * @returns A client whose tenant boundary has been measured, not assumed.
 * @throws {TypeError} If the connection string is not a non-empty string; `pg`
 *   would otherwise resolve an absent one from the ambient `PG*` variables and
 *   serve from whatever database the shell happened to name.
 * @throws {import("./refusal.js").BootRefusalError} Naming every check that
 *   failed. The pool is drained first, so a refused boot leaves no connection
 *   behind.
 */
export declare const createRuntimeDb: (config: RuntimeDbConfig) => Promise<RuntimeDb>;
export {};
```

## dist/db/schema-values.d.ts

```ts
/**
 * The closed value sets the schema's `text` columns hold, as types.
 *
 * `src/db/schema.ts` documents each of these in a comment beside its column and
 * cannot express them: a Postgres `ENUM` is a type whose values are altered by
 * migration rather than by a diff, and ADR 0008 keeps the state machines in the
 * application. This module is what stops the comment being the only statement -
 * it names no Drizzle type, so it is reachable from anywhere in the package and
 * from its published surface alike.
 */
/** `owner.type`. */
export type OwnerType = "user" | "organization";
/**
 * `ingress_delivery.state`. ADR 0013: none of these is Refusal or Failure
 * vocabulary, because nothing was refused and nothing executed. They are
 * ingress machinery before execution.
 */
export declare const INGRESS_STATES: readonly ["received", "done", "discarded"];
export type IngressState = (typeof INGRESS_STATES)[number];
/**
 * `ingress_delivery.disposition`, on `discarded`. Each one is terminal, and
 * each is a conclusion about the delivery rather than about a Run:
 *
 * ```text
 * canonical state ineligible - closed, draft   -> ineligible
 * a Run already exists at the canonical head   -> duplicate_head
 * grant definitively gone                      -> grant_gone
 * the delivery is not one that acts            -> inert
 * ```
 *
 * `inert` is ADR 0013's own word for the last row of its trigger table -
 * "everything else | inert" - promoted to a disposition because the ledger has
 * to say something about a delivery it concluded on, and every alternative
 * misreports it. `done` claims a Run was created, `ineligible` claims canonical
 * state was read and refused the pull request, and leaving the row `received`
 * hands a re-drive work that will reach the same answer forever. An `edited`
 * delivery, or one of the three events GitHub delivers to every App
 * unconditionally, is concluded the moment its event and action are read: no
 * lock is taken and no canonical fetch is made.
 *
 * It needs no migration. `disposition` is a `text` column and ADR 0008 keeps
 * the state machines in the application rather than in a Postgres `ENUM`, which
 * is exactly the case this is.
 */
export declare const INGRESS_DISPOSITIONS: readonly ["ineligible", "duplicate_head", "grant_gone", "inert"];
export type IngressDisposition = (typeof INGRESS_DISPOSITIONS)[number];
/**
 * `ingress_delivery.retry_class`, on a nonterminal `received`.
 *
 * ADR 0013 classifies retryability **by typed cause, never by HTTP status**,
 * because `403 Resource not accessible by integration`, a missing permission, a
 * revoked grant and a misconfigured App are all permanent and "all 401/403
 * retry with backoff" produces an invisible loop:
 *
 * ```text
 * network failure, 5xx, 429, secondary rate limiting  -> transient
 * auth or App configuration cannot establish access   -> operator_attention
 * advisory lock contention                            -> contended
 * ```
 *
 * `transient` and `contended` are the two ADR 0013 makes a Phase 0 exit
 * condition: every nonterminal `received` caused by either must have an
 * automatic re-drive path, which #38 chooses the mechanism for.
 */
export declare const INGRESS_RETRY_CLASSES: readonly ["transient", "operator_attention", "contended"];
export type IngressRetryClass = (typeof INGRESS_RETRY_CLASSES)[number];
/**
 * `run.status`. ADR 0007's machine: `queued` -> `claimed` -> `executing`,
 * terminating in one of the six below.
 */
export declare const RUN_STATUSES: readonly ["queued", "claimed", "executing", "completed", "incomplete", "failed", "superseded", "cancelled", "unscheduled"];
export type RunStatus = (typeof RUN_STATUSES)[number];
/**
 * The statuses ADR 0013 calls **live**, and the ones the partial unique index
 * `run_one_live_per_pull_request` is predicated on:
 *
 * ```sql
 * UNIQUE (repository_id, pull_request_number)
 *   WHERE status IN ('queued', 'claimed', 'executing')
 * ```
 *
 * The index spells them again rather than importing this list, because a
 * migration is a text artifact that has already run in databases this list
 * cannot reach. `run-creation.test.ts` measures the two against each other by
 * inserting a second live Run at each status rather than by comparing strings.
 */
export declare const LIVE_RUN_STATUSES: readonly ["queued", "claimed", "executing"];
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number];
/**
 * `run.cancellation_reason`, on `cancelled`.
 *
 * Both come from ADR 0013's trigger table - "`closed` | cancel the live Run;
 * create none" and "`converted_to_draft` | cancel the live Run; create none" -
 * and both are decided from **canonical state** rather than from the action
 * that arrived, so a stale `closed` for a pull request that has since reopened
 * cancels nothing. `superseded` is deliberately not here: it is a status of its
 * own, and recording it twice would let the two disagree.
 */
export declare const RUN_CANCELLATION_REASONS: readonly ["pull_request_closed", "pull_request_drafted"];
export type RunCancellationReason = (typeof RUN_CANCELLATION_REASONS)[number];
```

## dist/db/schema.d.ts

```ts
import type { SQLWrapper } from "drizzle-orm";
/**
 * Declared `existing()` so drizzle-kit names the role in the policies it emits
 * without taking over its privilege flags, which `bootstrap()` spells out.
 */
export declare const runtimeRole: import("drizzle-orm/pg-core").PgRole;
/**
 * The one tenant predicate, and the reason it is not the bare cast.
 *
 * `RESET ALL`, and PgBouncer's `DISCARD ALL` where it is enabled, do not remove
 * a custom GUC - they set it to the **empty string**. `''::bigint` then raises
 * `invalid input syntax for type bigint: ""` from inside the policy, so the
 * table stops being deniable and becomes unqueryable. The bare cast is correct
 * on every direct connection and fails only behind a pooler after a reset,
 * which is the worst possible distribution for a defect (ADR 0008).
 *
 * `current_setting(..., true)` returns NULL when the GUC was never set, so a
 * missing tenant context reads as zero rows rather than as an error - the same
 * shape as the wrong tenant.
 *
 * The empty string is not only a pooler's doing, which is measured rather than
 * inferred: a transaction-local `set_config('app.owner_id', ..., true)` also
 * leaves `''` behind on the session once its transaction ends, on the direct
 * endpoint as much as the pooled one. So `withOwner` itself creates the value
 * that would break the bare cast, and the guard is load-bearing on every
 * connection this package hands out rather than only after a reset.
 */
export declare const ownerContext: import("drizzle-orm").SQL<unknown>;
/**
 * The canonical tenant policy, applied identically to every Owner-scoped table.
 * There is exactly one of these and no second spelling, because ADR 0017 makes
 * the boot assertion set equality against what this helper renders: a
 * hand-rolled policy carrying the bare cast fails, and a second permissive
 * policy beside a correct one fails too.
 *
 * The column is typed `SQLWrapper` because inside the extra-config callback a
 * column is an `ExtraConfigColumn` rather than the builder it was declared with.
 */
export declare const tenantPolicy: (name: string, column: SQLWrapper) => import("drizzle-orm/pg-core").PgPolicy;
/**
 * The tenant. `id` is GitHub's durable numeric Owner id and there is no internal
 * uuid beside it: a Reprove-minted key would reintroduce the circularity on the
 * webhook path, where the payload carries GitHub's id and mapping it would
 * itself be an unscoped lookup.
 */
export declare const owner: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "owner";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "owner";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        login: import("drizzle-orm/pg-core").PgColumn<{
            name: "login";
            tableName: "owner";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        type: import("drizzle-orm/pg-core").PgColumn<{
            name: "type";
            tableName: "owner";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/** A live grant of the Reprove GitHub App. Revocation destroys nothing. */
export declare const installation: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "installation";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "installation";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "installation";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        revokedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "revoked_at";
            tableName: "installation";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/**
 * Operational persistence only. Review configuration is file-derived from the
 * base ref, so no configuration column lives here (ADR 0008, deferring to #21).
 */
export declare const repository: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "repository";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "repository";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "repository";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        installationId: import("drizzle-orm/pg-core").PgColumn<{
            name: "installation_id";
            tableName: "repository";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nameWithOwner: import("drizzle-orm/pg-core").PgColumn<{
            name: "name_with_owner";
            tableName: "repository";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        inScope: import("drizzle-orm/pg-core").PgColumn<{
            name: "in_scope";
            tableName: "repository";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/** A self-hosted Worker's durable identity, established once by Enrollment. */
export declare const worker: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "worker";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "worker";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "worker";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        protocolVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "protocol_version";
            tableName: "worker";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        workerBuildVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "worker_build_version";
            tableName: "worker";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastSeenAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_seen_at";
            tableName: "worker";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/**
 * Rows, not current-and-previous columns, so ADR 0006's rotation grace window is
 * an ordinary row lifetime rather than a fact encoded in a column name. During
 * rotation the predecessor takes `expiresAt = graceEnd`.
 */
export declare const workerCredential: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "worker_credential";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "worker_credential";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "worker_credential";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        workerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "worker_id";
            tableName: "worker_credential";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        secretHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "secret_hash";
            tableName: "worker_credential";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "worker_credential";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        expiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expires_at";
            tableName: "worker_credential";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        revokedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "revoked_at";
            tableName: "worker_credential";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/** Hash-only, never the plaintext, with atomic single-use consumption. */
export declare const enrollmentCode: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "enrollment_code";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "enrollment_code";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "enrollment_code";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        codeHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "code_hash";
            tableName: "enrollment_code";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        expiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expires_at";
            tableName: "enrollment_code";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        consumedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "consumed_at";
            tableName: "enrollment_code";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/**
 * ADR 0013's durable ingress ledger: a bounded normalized envelope and its
 * processing state. The raw webhook body is deliberately not persisted, the
 * table gets no `CONTEXT.md` noun, and nothing here ever enters a Run's spec.
 *
 * It arrived after ADR 0008's entity list, which is exactly why the coverage
 * assertion enumerates the schema module rather than trusting one ADR's list.
 */
export declare const ingressDelivery: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "ingress_delivery";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "ingress_delivery";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        deliveryGuid: import("drizzle-orm/pg-core").PgColumn<{
            name: "delivery_guid";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        event: import("drizzle-orm/pg-core").PgColumn<{
            name: "event";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        action: import("drizzle-orm/pg-core").PgColumn<{
            name: "action";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        installationId: import("drizzle-orm/pg-core").PgColumn<{
            name: "installation_id";
            tableName: "ingress_delivery";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        repositoryId: import("drizzle-orm/pg-core").PgColumn<{
            name: "repository_id";
            tableName: "ingress_delivery";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        repositoryNameWithOwner: import("drizzle-orm/pg-core").PgColumn<{
            name: "repository_name_with_owner";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pullRequestNumber: import("drizzle-orm/pg-core").PgColumn<{
            name: "pull_request_number";
            tableName: "ingress_delivery";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        state: import("drizzle-orm/pg-core").PgColumn<{
            name: "state";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        disposition: import("drizzle-orm/pg-core").PgColumn<{
            name: "disposition";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        retryClass: import("drizzle-orm/pg-core").PgColumn<{
            name: "retry_class";
            tableName: "ingress_delivery";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        attemptCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "attempt_count";
            tableName: "ingress_delivery";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastAttemptAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_attempt_at";
            tableName: "ingress_delivery";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nextAttemptAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "next_attempt_at";
            tableName: "ingress_delivery";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        receivedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "received_at";
            tableName: "ingress_delivery";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/**
 * One table, not three. ADR 0007's spec / resolution / state split is a
 * type-level guarantee about mutability, enforced in zod and the data-access
 * layer; projecting it to three tables would always be a 1:1 join and would cost
 * three writes per state change.
 */
export declare const run: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "run";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "run";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "run";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        repositoryId: import("drizzle-orm/pg-core").PgColumn<{
            name: "repository_id";
            tableName: "run";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pullRequestNumber: import("drizzle-orm/pg-core").PgColumn<{
            name: "pull_request_number";
            tableName: "run";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        baseSha: import("drizzle-orm/pg-core").PgColumn<{
            name: "base_sha";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        headSha: import("drizzle-orm/pg-core").PgColumn<{
            name: "head_sha";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        provenance: import("drizzle-orm/pg-core").PgColumn<{
            name: "provenance";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        provenanceBasis: import("drizzle-orm/pg-core").PgColumn<{
            name: "provenance_basis";
            tableName: "run";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        trigger: import("drizzle-orm/pg-core").PgColumn<{
            name: "trigger";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        harness: import("drizzle-orm/pg-core").PgColumn<{
            name: "harness";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        model: import("drizzle-orm/pg-core").PgColumn<{
            name: "model";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        strategy: import("drizzle-orm/pg-core").PgColumn<{
            name: "strategy";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        autonomy: import("drizzle-orm/pg-core").PgColumn<{
            name: "autonomy";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        placement: import("drizzle-orm/pg-core").PgColumn<{
            name: "placement";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        allowHostedFallback: import("drizzle-orm/pg-core").PgColumn<{
            name: "allow_hosted_fallback";
            tableName: "run";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        resolvedConfig: import("drizzle-orm/pg-core").PgColumn<{
            name: "resolved_config";
            tableName: "run";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        configDigest: import("drizzle-orm/pg-core").PgColumn<{
            name: "config_digest";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        cancellationReason: import("drizzle-orm/pg-core").PgColumn<{
            name: "cancellation_reason";
            tableName: "run";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        claimableUntil: import("drizzle-orm/pg-core").PgColumn<{
            name: "claimable_until";
            tableName: "run";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "run";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        passes: import("drizzle-orm/pg-core").PgColumn<{
            name: "passes";
            tableName: "run";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        refusals: import("drizzle-orm/pg-core").PgColumn<{
            name: "refusals";
            tableName: "run";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/**
 * Rows, because Findings are queried across Runs by bucket key for
 * Reconciliation. `evidence` and `patch` are JSONB: bounded, always read with
 * their parent, never queried independently.
 */
export declare const finding: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "finding";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "finding";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "finding";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "finding";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        path: import("drizzle-orm/pg-core").PgColumn<{
            name: "path";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        line: import("drizzle-orm/pg-core").PgColumn<{
            name: "line";
            tableName: "finding";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        severity: import("drizzle-orm/pg-core").PgColumn<{
            name: "severity";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        verification: import("drizzle-orm/pg-core").PgColumn<{
            name: "verification";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        title: import("drizzle-orm/pg-core").PgColumn<{
            name: "title";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        body: import("drizzle-orm/pg-core").PgColumn<{
            name: "body";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        anchoredText: import("drizzle-orm/pg-core").PgColumn<{
            name: "anchored_text";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        evidence: import("drizzle-orm/pg-core").PgColumn<{
            name: "evidence";
            tableName: "finding";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        patch: import("drizzle-orm/pg-core").PgColumn<{
            name: "patch";
            tableName: "finding";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        contentPurgedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "content_purged_at";
            tableName: "finding";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        bucketKey: import("drizzle-orm/pg-core").PgColumn<{
            name: "bucket_key";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        bucketKeyVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "bucket_key_version";
            tableName: "finding";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        publicationDisposition: import("drizzle-orm/pg-core").PgColumn<{
            name: "publication_disposition";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        reconciliation: import("drizzle-orm/pg-core").PgColumn<{
            name: "reconciliation";
            tableName: "finding";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
/** One row per Run, since at most one logical Review is published. */
export declare const publication: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "publication";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "publication";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_id";
            tableName: "publication";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "publication";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        state: import("drizzle-orm/pg-core").PgColumn<{
            name: "state";
            tableName: "publication";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        githubReviewId: import("drizzle-orm/pg-core").PgColumn<{
            name: "github_review_id";
            tableName: "publication";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        event: import("drizzle-orm/pg-core").PgColumn<{
            name: "event";
            tableName: "publication";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        appliedThreshold: import("drizzle-orm/pg-core").PgColumn<{
            name: "applied_threshold";
            tableName: "publication";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        reconciledAgainstRunId: import("drizzle-orm/pg-core").PgColumn<{
            name: "reconciled_against_run_id";
            tableName: "publication";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        priorReconciliation: import("drizzle-orm/pg-core").PgColumn<{
            name: "prior_reconciliation";
            tableName: "publication";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        attempts: import("drizzle-orm/pg-core").PgColumn<{
            name: "attempts";
            tableName: "publication";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        submittedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "submitted_at";
            tableName: "publication";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
export declare const user: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "user";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "user";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        name: import("drizzle-orm/pg-core").PgColumn<{
            name: "name";
            tableName: "user";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        email: import("drizzle-orm/pg-core").PgColumn<{
            name: "email";
            tableName: "user";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        emailVerified: import("drizzle-orm/pg-core").PgColumn<{
            name: "email_verified";
            tableName: "user";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        image: import("drizzle-orm/pg-core").PgColumn<{
            name: "image";
            tableName: "user";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "user";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "user";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
export declare const session: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "session";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "session";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        userId: import("drizzle-orm/pg-core").PgColumn<{
            name: "user_id";
            tableName: "session";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        token: import("drizzle-orm/pg-core").PgColumn<{
            name: "token";
            tableName: "session";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        expiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expires_at";
            tableName: "session";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ipAddress: import("drizzle-orm/pg-core").PgColumn<{
            name: "ip_address";
            tableName: "session";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        userAgent: import("drizzle-orm/pg-core").PgColumn<{
            name: "user_agent";
            tableName: "session";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "session";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "session";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
export declare const account: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "account";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        userId: import("drizzle-orm/pg-core").PgColumn<{
            name: "user_id";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        providerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "provider_id";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        issuer: import("drizzle-orm/pg-core").PgColumn<{
            name: "issuer";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        accountId: import("drizzle-orm/pg-core").PgColumn<{
            name: "account_id";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        accessToken: import("drizzle-orm/pg-core").PgColumn<{
            name: "access_token";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        refreshToken: import("drizzle-orm/pg-core").PgColumn<{
            name: "refresh_token";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        accessTokenExpiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "access_token_expires_at";
            tableName: "account";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        refreshTokenExpiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "refresh_token_expires_at";
            tableName: "account";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        scope: import("drizzle-orm/pg-core").PgColumn<{
            name: "scope";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        idToken: import("drizzle-orm/pg-core").PgColumn<{
            name: "id_token";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        password: import("drizzle-orm/pg-core").PgColumn<{
            name: "password";
            tableName: "account";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "account";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "account";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
export declare const verification: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "verification";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "verification";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        identifier: import("drizzle-orm/pg-core").PgColumn<{
            name: "identifier";
            tableName: "verification";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        value: import("drizzle-orm/pg-core").PgColumn<{
            name: "value";
            tableName: "verification";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        expiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expires_at";
            tableName: "verification";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "verification";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "verification";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: 'pg';
}>;
```

## dist/github/app-auth.d.ts

```ts
/**
 * How far the `iat` claim is backdated. GitHub rejects a JWT whose `iat` is in
 * *its* future, and the two clocks are not the same clock; a minute is GitHub's
 * own documented recommendation for the gap.
 */
export declare const CLOCK_DRIFT_SECONDS = 60;
/**
 * The token's life, under GitHub's ten-minute ceiling with the backdating
 * already spent. Nine minutes rather than the ceiling, because a JWT that
 * expires exactly at the limit is one whose validity depends on the drift being
 * in the direction that helps.
 */
export declare const APP_JWT_LIFETIME_SECONDS: number;
/** The App's identity, as the deployment configured it. */
export interface AppCredentials {
    /** GitHub's numeric App id, which is the JWT's `iss`. */
    readonly appId: string;
    /** The App's private key, PEM-encoded, in either PKCS#1 or PKCS#8. */
    readonly privateKey: string;
}
/**
 * Mints the JWT the installation-token exchange is authorized by.
 *
 * @param credentials The App id and its PEM private key.
 * @param issuedAt The instant to date the assertion from.
 * @returns A compact JWS, ready for an `Authorization: Bearer` header.
 * @throws {TypeError} Naming the field, when the App id is empty or the private
 *   key is not a key. Both are deployment configuration, and a JWT built from
 *   either would fail at GitHub as an opaque `401` classified
 *   `operator_attention` - true, and several steps removed from the cause.
 */
export declare const appJwt: (credentials: AppCredentials, issuedAt: Date) => string;
/** An installation token, or the reason this response carried none. */
export type IssuedInstallationToken = {
    readonly kind: "token";
    readonly token: string;
} | {
    readonly kind: "unreadable";
    readonly reason: string;
};
/**
 * Reads `POST /app/installations/{id}/access_tokens`'s body.
 *
 * @param body The raw response body.
 * @returns The token, or why there is none.
 */
export declare const readInstallationToken: (body: string) => IssuedInstallationToken;
```

## dist/github/body.d.ts

```ts
/**
 * Reading a delivery body under a hard cap, which is what runs in front of the
 * hash.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * asks for an oversized body to be rejected *before* hashing it, and that is a
 * statement about the bytes rather than about the status: `await
 * request.arrayBuffer()` followed by a length check has already accumulated
 * whatever was sent, so the cap it enforces is on what the handler proceeds
 * with rather than on what the process holds.
 *
 * So the body is read as a stream and abandoned the moment it passes the cap.
 * The declared `content-length` is consulted first because a sender that
 * describes an oversized body has already said enough, and it is never trusted
 * on its own, because a stream that lies about its length is exactly the shape
 * the cap exists for.
 */
/** A body that fitted, or the cap it broke. */
export type BoundedBody = {
    readonly kind: "bytes";
    readonly bytes: Uint8Array;
} | {
    readonly kind: "oversized";
    readonly limit: number;
};
/**
 * Reads at most `limit` bytes of a request body.
 *
 * @param request The delivery, unread.
 * @param limit The largest body in bytes that may be accumulated.
 * @returns The exact bytes received, or the cap they broke.
 */
export declare const readBoundedBody: (request: Request, limit: number) => Promise<BoundedBody>;
```

## dist/github/canonical.d.ts

```ts
/** Canonical state, in Reprove's shape rather than GitHub's. */
export interface CanonicalPullRequest {
    readonly number: number;
    /** `state === "open"`. A merged pull request is closed. */
    readonly open: boolean;
    readonly draft: boolean;
    /** The base branch tip, not the merge base. */
    readonly baseSha: string;
    readonly headSha: string;
    readonly baseRepositoryId: number;
    /** `null` for a deleted fork. */
    readonly headRepositoryId: number | null;
    readonly authorId: number;
    readonly authorAssociation: string;
}
/** Canonical state, or the reason this response could not become it. */
export type ParsedPullRequest = {
    readonly kind: "canonical";
    readonly pullRequest: CanonicalPullRequest;
} | {
    readonly kind: "unreadable";
    readonly reason: string;
};
/**
 * Reads a `GET /repos/{owner}/{repo}/pulls/{number}` body into canonical state.
 *
 * @param body The raw response body.
 * @returns The canonical state, or why there is none.
 */
export declare const readPullRequest: (body: string) => ParsedPullRequest;
```

## dist/github/client.d.ts

```ts
/**
 * The GitHub client, which is two requests and a classification.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * requires canonical state to be resolved "under installation authority", which
 * is App JWT then installation token then `GET
 * /repos/{owner}/{repo}/pulls/{number}`, and it fixes two things about how that
 * call may fail:
 *
 * ```text
 * network failure, 5xx, 429, identified secondary rate limiting -> transient
 * grant confirmed gone                                          -> grant_gone
 * auth or App configuration cannot establish access             -> operator_attention
 * ```
 *
 * > Retryability is classified by typed cause, never by HTTP status.
 *
 * The two `403`s are why. `403 Resource not accessible by integration` is a
 * missing permission and is permanent; a `403` carrying `retry-after` or an
 * exhausted quota is rate limiting and clears on its own. "All 401/403 retry
 * with backoff" retries the first forever and reports nothing, which is the
 * invisible loop ADR 0013 named.
 *
 * **Octokit is the rejected alternative**, and it is rejected for what it does
 * rather than for its size. Its app plugin brings a token cache, a retry plugin
 * and a throttling plugin whose defaults each contradict a decision above: it
 * would retry by status where ADR 0013 classifies by cause, and it would sleep
 * on a rate limit inside a transaction that is holding both an advisory lock and
 * a pooled connection. Turning three plugins off is more code than the fifty
 * lines below and leaves the behaviour a version bump from changing.
 *
 * `fetch` is injected rather than taken from the global for the same reason the
 * webhook's commit is a port: ADR 0016's acceptance scenario intercepts GitHub
 * "only at the transport", so the JWT, the exchange, the request shape and the
 * response parsing all execute for real against a canned body.
 */
import type { AppCredentials } from "./app-auth.js";
import type { CanonicalPullRequest } from "./canonical.js";
/** GitHub's REST root. Overridden only by a test or by GitHub Enterprise. */
export declare const GITHUB_API_URL = "https://api.github.com";
/**
 * The hard client timeout ADR 0013 requires, per request.
 *
 * It is a **budget inside a transaction**, not a generous ceiling: the fetch
 * runs while an advisory lock and a pooled connection are both held, and ADR
 * 0013 backstops it with a transaction-local `idle_in_transaction_session_
 * timeout` set higher, "so application code normally aborts cleanly before
 * Postgres kills the session". Two requests at this budget still fit inside
 * that backstop.
 */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
/** The injected transport. One `Request` in, one `Response` out. */
export type GitHubFetch = (request: Request) => Promise<Response>;
/** What the client is composed over. No value here is read from anywhere. */
export interface GitHubClientConfig extends AppCredentials {
    readonly fetch: GitHubFetch;
    /** Defaults to {@link GITHUB_API_URL}. */
    readonly baseUrl?: string;
    /** Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** The clock the App JWT is dated from. Defaults to the system clock. */
    readonly now?: () => Date;
}
/** Which pull request, reached through which grant. */
export interface CanonicalRequest {
    readonly installationId: number;
    /** `owner/name`. */
    readonly repositoryNameWithOwner: string;
    readonly pullRequestNumber: number;
}
/**
 * What the fetch concluded, in ADR 0013's own vocabulary rather than in HTTP's.
 * Each failure maps onto exactly one ledger outcome, which is what stops the
 * classification being made twice in two places.
 */
export type CanonicalOutcome = {
    readonly kind: "canonical";
    readonly pullRequest: CanonicalPullRequest;
}
/** Confirmed gone. Terminal: `discarded: grant_gone`. */
 | {
    readonly kind: "grant_gone";
    readonly reason: string;
}
/** Clears on its own. Nonterminal: `received`, `retryClass = transient`. */
 | {
    readonly kind: "transient";
    readonly reason: string;
}
/** A person has to act. Nonterminal: `received`, `operator_attention`. */
 | {
    readonly kind: "operator_attention";
    readonly reason: string;
};
/** The one thing this client does. */
export interface GitHubClient {
    readonly canonicalPullRequest: (request: CanonicalRequest) => Promise<CanonicalOutcome>;
}
/**
 * Composes the client over an App's credentials and a transport.
 *
 * @param config The App id, its private key and the injected `fetch`.
 * @returns A client that resolves canonical pull request state.
 */
export declare const createGitHubClient: (config: GitHubClientConfig) => GitHubClient;
```

## dist/github/delivery.d.ts

```ts
/**
 * What one delivery is, and what processing it concluded - as types a consumer
 * may hold.
 *
 * These three live apart from the modules that use them for a boundary reason
 * rather than a tidiness one. [ADR
 * 0010](../../../../docs/adr/0010-package-graph-and-open-core-boundary.md)
 * forbids `apps/control-plane` from depending on `drizzle-orm` or a Postgres
 * driver, and `tools/verify-packages.mjs` measures that by type-checking the
 * packed declarations in a consumer with `skipLibCheck: false`. A published type
 * that merely *lives in* a module importing Drizzle drags Drizzle's whole
 * declaration graph into that check, whether or not any signature names one.
 *
 * `ledger.ts` and `processing.ts` both name a Drizzle transaction, so neither
 * can be the home of a type `createControlPlane()` returns. Declaring them here
 * - over `IngressEnvelope` and the closed value sets, and nothing else - is what
 * makes the boundary hold by construction instead of by review.
 */
import type { IngressDisposition, IngressRetryClass } from "../db/schema-values.js";
import type { IngressEnvelope } from "./envelope.js";
/**
 * How a processing attempt ended, as the ledger holds it.
 *
 * A union rather than three nullable columns a caller fills in, because the
 * combinations the columns permit are mostly nonsense: a `done` row carrying a
 * retry class, or a `discarded` row with a next attempt, is a delivery a
 * re-drive sweeper would pick up and redo. Here the state names its own
 * evidence and there is no fourth shape.
 */
export type IngressOutcome =
/** A Run was created. Terminal. */
{
    readonly state: "done";
}
/** Terminal, and the disposition says which conclusion was reached. */
 | {
    readonly state: "discarded";
    readonly disposition: IngressDisposition;
}
/**
 * Nonterminal: the delivery stays `received` and the retry class says what
 * kind of recovery it needs. ADR 0013 makes an automatic re-drive path for
 * `transient` and `contended` a Phase 0 exit condition rather than deferred
 * work, and #38 chooses the mechanism.
 */
 | {
    readonly state: "received";
    readonly retryClass: IngressRetryClass;
    readonly nextAttemptAt: Date | null;
};
/** A committed ledger row and the envelope it holds. */
export interface DeliveryToProcess {
    /** The ledger row's id, as `recordDelivery()` returned it. */
    readonly deliveryId: string;
    readonly envelope: IngressEnvelope;
}
/** What one processing attempt concluded, and whether the ledger took it. */
export interface ProcessedDelivery {
    readonly outcome: IngressOutcome;
    /**
     * `false` when the row was already terminal, or belongs to another Owner.
     * ADR 0013's stateful GUID rule is what makes that expected rather than
     * exceptional: the contended attempt that settles after the one that won the
     * lock must not reopen a delivery whose work is finished.
     */
    readonly settled: boolean;
    /** The Run this delivery produced, where it produced one. */
    readonly runId: string | null;
}
```

## dist/github/envelope.d.ts

```ts
import type { OwnerType } from "../db/schema-values.js";
/**
 * The row's worth of facts, and the exact set of them. Everything nullable here
 * is nullable in the ledger for the same reason: a lifecycle delivery carries
 * only the bounded ids the removal needs and has no one repository to locate.
 */
export interface IngressEnvelope {
    /** `X-GitHub-Delivery`. Reused on a manual redelivery, so never a key. */
    readonly deliveryGuid: string;
    /** `X-GitHub-Event`. */
    readonly event: string;
    readonly action: string | null;
    /** GitHub's durable numeric Owner id, which is the tenant key itself. */
    readonly ownerId: number;
    readonly ownerLogin: string;
    readonly ownerType: OwnerType;
    readonly installationId: number | null;
    readonly repositoryId: number | null;
    /** The `owner/name` locator **as the delivery carried it**. */
    readonly repositoryNameWithOwner: string | null;
    readonly pullRequestNumber: number | null;
}
/** An envelope, or the reason these bytes could not become one. */
export type NormalizedDelivery = {
    readonly kind: "envelope";
    readonly envelope: IngressEnvelope;
} | {
    readonly kind: "malformed";
    readonly reason: string;
};
/** A signature-verified delivery, still unparsed. */
export interface ReceivedDelivery {
    readonly event: string;
    readonly deliveryGuid: string;
    /** The exact bytes, which the signature has already been checked against. */
    readonly body: Uint8Array;
}
/**
 * Reads a verified delivery into the envelope the ledger commits.
 *
 * @param delivery The event, the delivery GUID and the verified bytes.
 * @returns The envelope, or the reason there is none.
 */
export declare const normalizeDelivery: (delivery: ReceivedDelivery) => NormalizedDelivery;
```

## dist/github/ledger.d.ts

```ts
import type { TenantTransaction } from "../db/runtime.js";
import type { IngressOutcome } from "./delivery.js";
import type { IngressEnvelope } from "./envelope.js";
/**
 * Commits one envelope, with the identity rows it depends on, inside the
 * caller's tenant transaction.
 *
 * The transaction is the caller's on purpose: "committed before the
 * acknowledgement" is a property of the call the handler awaits, and a function
 * that opened a transaction of its own would let a caller acknowledge while the
 * commit was still in flight.
 *
 * @param tx A tenant transaction already scoped to the envelope's Owner.
 * @param envelope The bounded normalized envelope.
 * @returns The ledger row's id, which is what later processing resumes from.
 */
export declare const recordDelivery: (tx: TenantTransaction, envelope: IngressEnvelope) => Promise<string>;
/**
 * Records how one processing attempt ended, and counts it.
 *
 * The attempt bookkeeping is incremented in SQL rather than read and written
 * back, so two processors that reached the same delivery cannot both write the
 * count they each read.
 *
 * Only a `received` row is settled. `done` and `discarded` are terminal in ADR
 * 0013, and the state is what the stateful GUID rule reads - same GUID plus a
 * terminal state is a duplicate - so a late attempt that reopened one would put
 * a retry class and a next attempt back on a delivery whose work is finished,
 * and hand a re-drive something that must never be redone. That is reachable
 * without any second processor writing at the same instant: the contended
 * attempt that lost the advisory lock settles after the attempt that won it.
 * Repeating a still-`received` row is the one repeat that does land, because
 * that is exactly what a re-drive is.
 *
 * Settling nothing is silent, for both reasons it can happen. Across the tenant
 * boundary the update matches nothing, and raising there would tell the wrong
 * Owner the row exists; on a terminal row the settlement is simply stale, and
 * the caller has nothing left to do about a delivery that is already concluded.
 * The return value is what distinguishes either from a settlement that landed.
 *
 * @param tx A tenant transaction already scoped to the delivery's Owner.
 * @param deliveryId The ledger row returned by {@link recordDelivery}.
 * @param outcome How the attempt ended.
 * @returns Whether this attempt was recorded - `false` when the row is already
 *   terminal, or belongs to another Owner.
 */
export declare const settleDelivery: (tx: TenantTransaction, deliveryId: string, outcome: IngressOutcome) => Promise<boolean>;
```

## dist/github/manifest.d.ts

```ts
/**
 * The GitHub App registration, as the manifest GitHub creates one from.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * fixes the grant and the reason it is this small:
 *
 * ```text
 * Metadata: read          mandatory for every App
 * Pull requests: read     gates delivery of the pull_request event
 * ```
 *
 * That is the complete grant. `Contents: read`, `Pull requests: write` and
 * `Checks: write` are **not** pre-declared, and the asymmetry that tempts the
 * opposite choice is understood rather than overlooked: adding a *permission*
 * later requires every existing installation to approve it and the App keeps
 * operating under the old grant until they do, whereas adding an *event
 * subscription* later is free once the gating permission is held. It does not
 * apply because Phase 0 has no third-party installations, so the migration cost
 * is currently zero and will be paid exactly once, deliberately, before Phase 1
 * launches. Pre-declaring write authority buys nothing today and costs an
 * install consent screen that overstates what the App can do, on a product whose
 * central claim is credential minimalism.
 *
 * **No Check is published**, and that is recorded rather than omitted.
 * `CONTEXT.md` requires every Refusal to be visible on a Check, which looks like
 * it forces `Checks: write` into the grant; it does not, because no Refusal is
 * reachable in Phase 0 - a control-plane Refusal arises from configuration that
 * is invalid or cannot be resolved, and Phase 0 Runs are built from fixed inputs
 * with no repository configuration, while a Worker-side Refusal needs a Worker.
 * The Check lands with the first phase that can actually produce a Refusal, and
 * must land at the same time as it.
 *
 * The App subscribes to exactly `pull_request`. GitHub additionally delivers
 * `installation`, `installation_repositories` and `github_app_authorization` to
 * every App by default and **they cannot be subscribed to or unsubscribed
 * from**, so they are absent here and still recorded: the handler normalizes
 * whatever event it is sent rather than assuming an unsubscribed one never
 * arrives, and the event name is a column on the ledger row that `trigger.ts`
 * dispatches on.
 */
/** The permission levels GitHub accepts in a manifest. */
export type ManifestPermission = "read" | "write" | "admin";
/**
 * The complete grant, and the only place it is written. It is a value rather
 * than prose in a runbook so that a test can hold it to ADR 0013 and a widening
 * shows up as a diff beside the decision that forbids it.
 */
export declare const APP_PERMISSIONS: {
    readonly metadata: "read";
    readonly pull_requests: "read";
};
/** The one explicit subscription. The other three arrive unconditionally. */
export declare const APP_EVENTS: readonly ["pull_request"];
/** The webhook path the App's single hook URL points at. */
export declare const WEBHOOK_PATH = "/api/github/webhook";
/** The deployment-specific facts a manifest needs and this package cannot know. */
export interface ManifestOptions {
    /** The App's display name. */
    readonly name: string;
    /** The origin the control plane is deployed at, with no trailing slash. */
    readonly baseUrl: string;
    /** Whether the App may be installed by accounts other than its owner. */
    readonly public?: boolean;
}
/**
 * A GitHub App manifest, in the shape `POST /app-manifests/{code}/conversions`
 * is reached through.
 */
export interface GitHubAppManifest {
    readonly name: string;
    readonly url: string;
    readonly hook_attributes: {
        readonly url: string;
        readonly active: true;
    };
    readonly redirect_url: string;
    readonly public: boolean;
    readonly default_events: readonly string[];
    readonly default_permissions: Readonly<Record<string, ManifestPermission>>;
}
/**
 * Builds the manifest a registration is created from.
 *
 * @param options The App name and the origin it is deployed at.
 * @returns The manifest, carrying exactly ADR 0013's grant.
 */
export declare const githubAppManifest: (options: ManifestOptions) => GitHubAppManifest;
```

## dist/github/processing.d.ts

```ts
/**
 * What happens after the `200`, and the one transaction it happens in.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * ends the webhook handler at "return 200 -> kick asynchronous processing", and
 * this is what the kick reaches. It maps the critical section's decision onto
 * the ledger's own vocabulary, which is deliberately neither Refusal nor Failure
 * vocabulary - "nothing was refused and nothing executed":
 *
 * ```text
 * Run created                                  -> done
 * canonical state ineligible - closed, draft   -> discarded: ineligible
 * a Run already exists at the canonical head   -> discarded: duplicate_head
 * grant definitively gone                      -> discarded: grant_gone
 * not a delivery that acts                     -> discarded: inert
 * lock contention                              -> received, contended
 * network failure, 5xx, 429, rate limiting     -> received, transient
 * auth or App configuration                    -> received, operator_attention
 * ```
 *
 * **The settlement is in the same transaction as the decision**, which is the
 * one structural choice here. Settling afterwards would leave a window in which
 * a Run exists and the delivery that created it still reads `received`, and a
 * re-drive reaching that window would take the lock, observe its own Run at the
 * canonical head, and conclude `duplicate_head` for the delivery that is
 * actually `done`. One transaction makes the Run and the conclusion about it a
 * single fact.
 *
 * The rejected alternative for the whole module is a sweeper that discovers
 * `received` rows on a timer. ADR 0013 requires an automatic re-drive path for
 * `contended` and `transient` as a Phase 0 exit condition and hands the
 * *mechanism* to [#38](https://github.com/nick-neely/reprove/issues/38), which
 * chose the platform's own step retry. Building a second one here would be a
 * recovery system nobody asked for, competing with the durable one - so
 * `processDelivery` is exposed as a function instead, and the kick that calls it
 * is fire-and-forget precisely because it is not the thing that recovers.
 */
import type { RuntimeDb } from "../db/runtime.js";
import type { DeliveryToProcess, ProcessedDelivery } from "./delivery.js";
import type { Phase0RunProfile } from "./profile.js";
import type { RunCreationConfig } from "./run-creation.js";
/** What the processor is composed over. */
export interface DeliveryProcessorConfig {
    readonly withOwner: RuntimeDb["withOwner"];
    readonly canonicalPullRequest: RunCreationConfig["canonicalPullRequest"];
    readonly profile: Phase0RunProfile;
    /** Defaults to the system clock. */
    readonly now?: () => Date;
}
/**
 * Composes the processor over a runtime client, the canonical fetch and the
 * injected profile.
 *
 * @param config The tenant transaction factory, the fetch and the profile.
 * @returns A function from a committed delivery to what it concluded.
 */
export declare const createDeliveryProcessor: (config: DeliveryProcessorConfig) => ((delivery: DeliveryToProcess) => Promise<ProcessedDelivery>);
```

## dist/github/profile.d.ts

```ts
import type { ResolvedConfig, RunSpec } from "@reprove/protocol/v1";
/** ADR 0014's Phase 0 unclaimed window, which ADR 0016 restates as a fixture. */
export declare const PHASE_0_CLAIMABLE_FOR_MS: number;
/**
 * The half of a Run's spec no pull request can influence.
 *
 * Every field is named from `RunSpec` rather than respelled, so a value this
 * profile can hold is exactly a value the Worker protocol accepts. There is no
 * second vocabulary for a harness or an autonomy level to drift against.
 */
export interface Phase0RunProfile {
    readonly harness: RunSpec["harness"];
    readonly model: string;
    readonly strategy: RunSpec["strategy"];
    readonly autonomy: RunSpec["autonomy"];
    readonly placement: RunSpec["placement"];
    readonly allowHostedFallback: boolean;
    /** A real bounded normalized config, not a placeholder. */
    readonly resolvedConfig: ResolvedConfig;
    /** How long a created Run stays claimable. Written into the spec. */
    readonly claimableForMs: number;
}
/**
 * JSON, as a value rather than as `unknown`.
 *
 * A configuration is JSON before it is a `ResolvedConfig` - today from a
 * literal, and from `.reprove.yml` once [#21](https://github.com/nick-neely/reprove/issues/21)
 * reads one - so the parse below takes the shape it actually arrives in.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
/**
 * The digest of one resolved configuration.
 *
 * @param resolvedConfig The bounded normalized config that governs a Run.
 * @returns `sha256:` followed by the hex digest of its canonical form.
 */
export declare const configDigest: (resolvedConfig: ResolvedConfig) => string;
/**
 * Parses a profile's configuration, so a profile carrying something the Worker
 * protocol would reject fails at composition rather than at the Run insert.
 *
 * @param resolvedConfig The configuration to normalize.
 * @returns The parsed configuration, with every default filled in.
 * @throws {TypeError} Naming what the configuration broke.
 */
export declare const normalizeResolvedConfig: (resolvedConfig: JsonValue) => ResolvedConfig;
/**
 * The Phase 0 fixture, as one named value.
 *
 * It is exported so `apps/control-plane` can inject it by name instead of
 * writing these literals into route wiring, and it is **not** a default: nothing
 * reaches for it unless a caller passes it.
 */
export declare const PHASE_0_RUN_PROFILE: Phase0RunProfile;
```

## dist/github/provenance.d.ts

```ts
/**
 * Where the code under review came from, computed rather than configured.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * states the rule and the reason it is computed **from the canonical response
 * fetched inside the critical section**, "so it is fresh rather than
 * event-stale":
 *
 * ```text
 * internal  iff  head.repo.id is present
 *           and  head.repo.id === base.repo.id
 *           and  author_association in { OWNER, MEMBER, COLLABORATOR }
 * external  otherwise
 * ```
 *
 * Repository **numeric ids, never names**, so a rename cannot flip a
 * classification, and a deleted fork - `head.repo == null` - is `external`
 * along with `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER` and `NONE`.
 * Anything GitHub adds to that vocabulary later is `external` too, because the
 * allowlist is the safe direction to be wrong in.
 *
 * **The live collaborator-permission endpoint is the rejected alternative, and
 * its absence is an accepted consequence rather than a gap.** It would
 * additionally distinguish a read-only collaborator from one who can push, and
 * ADR 0008 establishes that it needs only `Metadata: read`, so it is available.
 * It is not used because `CONTEXT.md` says collaborator, not write-capable
 * collaborator, and Provenance "classifies risk rather than conferring safety".
 * If it should later mean "could push the head branch", that is a new
 * {@link PROVENANCE_RULE_VERSION} and old Runs stay explainable - which is the
 * entire reason ADR 0007 kept `provenanceBasis`.
 *
 * The basis persists the **inputs** rather than prose reconstructed later, for
 * the same reason: a sentence explaining a decision is written against today's
 * rule, and the rule is the thing that changes.
 */
import type { CanonicalPullRequest } from "./canonical.js";
/**
 * Which rule produced a classification. It is on every basis so that a Run
 * classified under an older rule is still readable as what it was, rather than
 * being reinterpreted under whatever the rule became.
 */
export declare const PROVENANCE_RULE_VERSION = 1;
/** ADR 0007's `provenanceBasis`, which is the inputs and the two matches. */
export interface ProvenanceBasis {
    readonly ruleVersion: number;
    readonly baseRepositoryId: number;
    readonly headRepositoryId: number | null;
    readonly authorAssociation: string;
    readonly authorId: number;
    readonly matchedSameRepository: boolean;
    readonly matchedAssociation: boolean;
}
/** The classification and everything it was reached from. */
export interface ProvenanceDecision {
    readonly provenance: "internal" | "external";
    readonly basis: ProvenanceBasis;
}
/**
 * Classifies one pull request's canonical state.
 *
 * @param pullRequest Canonical state, as the fetch inside the lock read it.
 * @returns The classification and the basis to persist beside it.
 */
export declare const provenanceOf: (pullRequest: CanonicalPullRequest) => ProvenanceDecision;
```

## dist/github/run-creation.d.ts

```ts
import type { TenantTransaction } from "../db/runtime.js";
import type { RunCancellationReason } from "../db/schema-values.js";
import type { CanonicalOutcome, CanonicalRequest } from "./client.js";
import type { Phase0RunProfile } from "./profile.js";
import type { DeliveryIntent } from "./trigger.js";
/**
 * The backstop ADR 0013 puts behind the client timeout, and it is set **higher**
 * on purpose: "with the client timeout set lower so application code normally
 * aborts cleanly before Postgres kills the session". Two GitHub requests at the
 * client's own budget still fit inside this.
 */
export declare const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15000;
/** Which pull request, in which tenant, reached through which grant. */
export interface PullRequestLocator extends CanonicalRequest {
    readonly ownerId: number;
    readonly repositoryId: number;
}
/** What the critical section is composed over. */
export interface RunCreationConfig {
    readonly canonicalPullRequest: (request: CanonicalRequest) => Promise<CanonicalOutcome>;
    readonly profile: Phase0RunProfile;
    readonly now: () => Date;
}
/**
 * What the critical section decided, in enough detail that the ledger outcome
 * and a test can both be written from it. Every shape names what happened to
 * existing Runs as well as to any new one, because "supersede the old Run and
 * insert its replacement happen in the same `withOwner` transaction" is the
 * claim, and a decision that reported only the insert could not state it.
 */
export type RunDecision =
/** A Run exists at the canonical head, and it is this one. */
{
    readonly kind: "created";
    readonly runId: string;
    /** The live Run at an older head that this one replaced, if any. */
    readonly supersededRunId: string | null;
}
/** Canonical state is closed or draft. Any live Run was ended. */
 | {
    readonly kind: "ineligible";
    readonly reason: RunCancellationReason;
    readonly cancelledRunId: string | null;
}
/** A Run already exists at the canonical head, in some status. */
 | {
    readonly kind: "duplicate_head";
    readonly supersededRunId: string | null;
}
/** A cancelling delivery whose pull request is, canonically, still open. */
 | {
    readonly kind: "no_action";
}
/** Another processor holds this pull request. Nothing was read or written. */
 | {
    readonly kind: "contended";
} | {
    readonly kind: "grant_gone";
    readonly reason: string;
} | {
    readonly kind: "transient";
    readonly reason: string;
} | {
    readonly kind: "operator_attention";
    readonly reason: string;
};
/**
 * Resolves canonical state and settles one pull request, inside the caller's
 * tenant transaction.
 *
 * The transaction is the caller's for the same reason the ledger's is: the lock
 * is transaction-scoped, so a function that opened one of its own would release
 * it before the caller recorded what it decided.
 *
 * @param tx A tenant transaction already scoped to the delivery's Owner.
 * @param config The canonical fetch, the injected profile and the clock.
 * @param locator Which pull request, reached through which grant.
 * @param intent What the delivery is asking for.
 * @returns What was decided, and what it did to existing Runs.
 */
export declare const settlePullRequest: (tx: TenantTransaction, config: RunCreationConfig, locator: PullRequestLocator, intent: Exclude<DeliveryIntent, "inert">) => Promise<RunDecision>;
```

## dist/github/signature.d.ts

```ts
/**
 * The header GitHub carries the signature on, lower-cased because that is how
 * `Headers.get` normalizes it and how every comparison here is written.
 */
export declare const SIGNATURE_HEADER = "x-hub-signature-256";
/**
 * The algorithm prefix GitHub prepends to the digest. It is part of the signed
 * comparison rather than something to strip and discard: leaving it in is what
 * makes `sha1=...`, the retired scheme GitHub still sends on
 * `X-Hub-Signature`, fail here rather than being read as a bare digest.
 */
export declare const SIGNATURE_PREFIX = "sha256=";
/** The header value GitHub computes for a body, in full. */
export declare const signDelivery: (secret: string, body: Uint8Array) => string;
/** A delivery's raw bytes and the signature offered for them. */
export interface OfferedSignature {
    /** The webhook secret the App was registered with. */
    readonly secret: string;
    /** The exact bytes received, before any parse. */
    readonly body: Uint8Array;
    /** The `X-Hub-Signature-256` header as it arrived, or null when absent. */
    readonly signature: string | null;
}
/**
 * Whether the offered signature is the one this secret produces over these
 * bytes.
 *
 * Every malformed shape - an absent header, an empty one, a bare digest, the
 * retired `sha1` scheme, a truncated digest - is a `false` rather than a throw,
 * because the caller turns this into a status and has nothing to do with an
 * exception.
 *
 * @param offered The bytes received and the signature offered for them.
 * @returns True only when the signature matches the bytes exactly.
 */
export declare const isSignatureValid: (offered: OfferedSignature) => boolean;
```

## dist/github/trigger.d.ts

```ts
/**
 * Which deliveries act, and what each of them is asking for.
 *
 * [ADR
 * 0013](../../../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md)
 * fixes the table:
 *
 * | `pull_request` action | effect |
 * | --- | --- |
 * | `opened` | create a Run, if not draft |
 * | `synchronize` | supersede the live Run and create one at the canonical head, if not draft |
 * | `reopened` | create if not draft and no Run exists at that head |
 * | `ready_for_review` | create if no Run exists at that head |
 * | `closed` | cancel the live Run; create none |
 * | `converted_to_draft` | cancel the live Run; create none |
 * | everything else | inert |
 *
 * The per-action conditions are deliberately **not** repeated here, because
 * every one of them is a statement about canonical state rather than about the
 * action, and ADR 0013 resolves canonical state inside the critical section
 * precisely so that the action stops being the authority. "If not draft" and "if
 * no Run exists at that head" are the same two checks in all four rows, so
 * `run-creation.ts` makes them once. What survives here is the only distinction
 * the action really carries: whether the delivery could produce a Run at all.
 *
 * **`edited` is inert deliberately**, and it is the row worth stating twice.
 * [ADR 0012](../../../../docs/adr/0012-author-controlled-narrative-input.md)
 * classifies the title and description as Author-controlled narrative, so
 * letting an edit re-trigger would hand the Author an unlimited free re-roll of
 * the review at no cost.
 *
 * The switch is **explicit and closed** rather than an allowlist over
 * `pull_request` alone: GitHub delivers `installation`,
 * `installation_repositories` and `github_app_authorization` to every App by
 * default and they "cannot be subscribed to or unsubscribed from", so the
 * handler "may not assume that an unsubscribed event never arrives".
 */
/** What a delivery is asking the critical section to consider doing. */
export type DeliveryIntent =
/** Create a Run at the canonical head, if canonical state allows one. */
"review"
/** End the live Run, if canonical state agrees the pull request is over. */
 | "cancel"
/** Nothing. No lock is taken and no canonical fetch is made. */
 | "inert";
/**
 * Reads one delivery's event and action.
 *
 * @param event `X-GitHub-Event`, as the envelope recorded it.
 * @param action The payload's action, or `null` where it carried none.
 * @returns What this delivery is asking for.
 */
export declare const intentOf: (event: string, action: string | null) => DeliveryIntent;
```

## dist/github/webhook.d.ts

```ts
import type { DeliveryToProcess } from "./delivery.js";
import type { IngressEnvelope } from "./envelope.js";
export declare const EVENT_HEADER = "x-github-event";
export declare const DELIVERY_HEADER = "x-github-delivery";
/**
 * GitHub's own documented cap on a webhook payload. The default is that number
 * rather than a smaller guess so the bound is a backstop against a body GitHub
 * could not have sent, never a reason a legitimate delivery is turned away.
 */
export declare const MAXIMUM_DELIVERY_BYTES: number;
/**
 * One status per reason, because ADR 0013's recovery story is different for
 * each of them and a single `400` would collapse the three.
 *
 * `notCommitted` is the one that matters most and is the counterintuitive half
 * of the decision: it is a failure Reprove *wants* GitHub to see, so the
 * delivery stays manually redeliverable. The other three are rejections of
 * something Reprove will never be able to use, and re-sending them would only
 * produce the same answer.
 */
export declare const WEBHOOK_STATUS: {
    /** The envelope is durable. Processing has not necessarily started. */
    readonly acknowledged: 200;
    /** No valid signature over these exact bytes. */
    readonly unsigned: 401;
    /** Over the cap, and refused before being hashed. */
    readonly oversized: 413;
    /** Signed, and still not something an envelope can be built from. */
    readonly unusable: 422;
    /** The envelope could not be committed, so nothing may be acknowledged. */
    readonly notCommitted: 503;
};
/**
 * What durably commits an envelope. It resolves only once the row is committed,
 * and rejects otherwise; there is no third answer, because the handler turns
 * the distinction straight into an acknowledgement or the absence of one.
 *
 * It resolves with the ledger row's id, which is what the kick below needs and
 * the only thing later processing resumes from.
 */
export type CommitEnvelope = (envelope: IngressEnvelope) => Promise<string>;
/**
 * What starts processing a committed delivery, and it is **not** awaited.
 *
 * ADR 0013's order ends "return 200 -> kick asynchronous processing", and the
 * arrow is one-way on purpose: "once the envelope is committed, a failed
 * asynchronous kick still returns `200`, because Reprove now holds the intent
 * and the ledger is what recovers it." Awaiting it would spend GitHub's
 * ten-second wall on the canonical fetch and the advisory lock, and would turn
 * a contended delivery - the one case that is *expected* to fail - into a
 * non-2xx for a delivery that is already durable.
 *
 * It is therefore synchronous and returns nothing. A port that returned a
 * promise would invite a caller to await it, which is the mistake this shape
 * exists to make unavailable.
 */
export type KickProcessing = (delivery: DeliveryToProcess) => void;
/** What the handler is composed over. No value here is read from anywhere. */
export interface WebhookConfig {
    /** The webhook secret the App was registered with. */
    readonly secret: string;
    /** The largest body to accept. Defaults to {@link MAXIMUM_DELIVERY_BYTES}. */
    readonly maximumBytes?: number;
    readonly commit: CommitEnvelope;
    /** Optional: a handler with no kick records deliveries and processes none. */
    readonly kick?: KickProcessing;
}
/**
 * Builds the handler.
 *
 * @param config The webhook secret, the body cap and the commit port.
 * @returns A function from a delivery to its acknowledgement or rejection.
 */
export declare const createGitHubWebhookHandler: (config: WebhookConfig) => ((request: Request) => Promise<Response>);
```

## dist/index.d.ts

```ts
export { protocolSchemas as workerProtocolSchemas } from "@reprove/protocol/v1";
/**
 * The persistence surface a consumer may hold, and deliberately no more.
 *
 * ADR 0010's matrix forbids `apps/control-plane` - the only consumer - from
 * depending on `drizzle-orm`, `pg` or any other Postgres driver, so nothing
 * exported here names a type from one. That is the same boundary ADR 0005 draws
 * against `@ai-sdk/*`, applied to the database: an upstream type leaks through
 * an exported signature even when the importer never names the package.
 *
 * The schema, the classification, `createRuntimeDb()` and its tenant transaction
 * therefore stay inside the package, reachable from `./db/index.js` by the
 * control-plane code that owns them. Composition reaches the app as
 * `createControlPlane(config)`, which is where the runtime client is built from
 * configuration the app parsed - not as a Drizzle handle the app assembles for
 * itself.
 */
export type { ControlPlane, ControlPlaneConfig, ControlPlaneDatabaseConfig, ControlPlaneGitHubConfig, } from "./control-plane.js";
export { createControlPlane } from "./control-plane.js";
export type { BootstrapConfig } from "./db/bootstrap.js";
export { bootstrap } from "./db/bootstrap.js";
export type { MigrateConfig } from "./db/migrate.js";
export { migrate } from "./db/migrate.js";
export type { CommittedMigration } from "./db/migrations.js";
export { MIGRATIONS_FOLDER, readCommittedMigrations } from "./db/migrations.js";
export type { CheckName, CheckOutcome } from "./db/refusal.js";
export { BootRefusalError } from "./db/refusal.js";
export { RUNTIME_ROLE } from "./db/roles.js";
export type { DeliveryToProcess, IngressOutcome, ProcessedDelivery, } from "./github/delivery.js";
export type { IngressEnvelope } from "./github/envelope.js";
export type { GitHubAppManifest, ManifestOptions, ManifestPermission, } from "./github/manifest.js";
export type { Phase0RunProfile } from "./github/profile.js";
export { PHASE_0_CLAIMABLE_FOR_MS, PHASE_0_RUN_PROFILE, } from "./github/profile.js";
export { APP_EVENTS, APP_PERMISSIONS, githubAppManifest, WEBHOOK_PATH, } from "./github/manifest.js";
export { WEBHOOK_STATUS } from "./github/webhook.js";
export declare const packageName: "@reprove/control-plane";
/**
 * Shell. The control plane validates every Worker submission against the same
 * authoritative schema the Worker emits with, because a hostile or buggy Worker
 * can skip its own code and POST arbitrary bytes (ADR 0010).
 */
export declare const accepts: {
    readonly protocolVersion: 1;
};
```
