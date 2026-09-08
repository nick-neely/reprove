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
import type {
  ControlPlaneConfig,
  KickProcessing,
  Phase0RunProfile,
} from "@reprove/control-plane";

/**
 * The variables a deployment sets. Named once, so the app's README, the build
 * gate and this parser cannot drift on a spelling.
 */
export const ENVIRONMENT = {
  /** The **pooled** endpoint, as the restricted runtime role. */
  databaseUrl: "REPROVE_DATABASE_URL",
  /** The webhook secret the App was registered with. */
  webhookSecret: "REPROVE_GITHUB_WEBHOOK_SECRET",
  /** GitHub's numeric App id, which is the App JWT's issuer. */
  appId: "REPROVE_GITHUB_APP_ID",
  /**
   * The App's PEM private key. A PEM carries newlines, which a `.env` file and
   * most secret stores do not, so the escaped form `\n` is accepted too; a real
   * PEM passes through unchanged, because it contains no backslash.
   */
  privateKey: "REPROVE_GITHUB_PRIVATE_KEY",
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
  githubApiUrl: "REPROVE_GITHUB_API_URL",
  /**
   * Optional. How long a created Run stays claimable, in milliseconds. Unset
   * means the injected profile's own value, which is
   * `PHASE_0_CLAIMABLE_FOR_MS`.
   *
   * See {@link livenessForMs} for why the two windows are separate variables.
   */
  claimableForMs: "REPROVE_RUN_CLAIMABLE_FOR_MS",
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
  livenessForMs: "REPROVE_RUN_LIVENESS_FOR_MS",
} as const;

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

const ESCAPED_NEWLINE = String.raw`\n`;

/**
 * A whole number of milliseconds, with no other spelling of one admitted.
 *
 * The shape test in front of the coercion is what makes `Number()` safe to
 * reach for, which is the same argument `parseWorkerCredential`'s locator makes:
 * on its own it reads `0x1f4`, `1e3`, `1.5`, whitespace and the empty string as
 * numbers, and none of those is a duration anybody meant to write. A leading
 * zero is refused with them rather than quietly accepted.
 */
const WHOLE_MILLISECONDS = /^[1-9]\d*$/u;

/**
 * One duration override, or the profile's own value where none was set.
 *
 * Unlike every other value here, an unusable one is **refused rather than
 * passed through**. The rule above - absent values pass through, because
 * `createControlPlane()` names the missing field - does not reach this case:
 * the profile is injected by name, so `normalizeRunProfile` would name
 * `Phase0RunProfile.livenessForMs` for something no code set, and send a reader
 * looking at a literal in a package instead of at their own deployment.
 *
 * @param env The environment being read.
 * @param variable Which variable carries the override.
 * @param fallback The injected profile's own duration.
 * @returns The duration to use.
 * @throws {TypeError} Naming the variable, when it is set to anything but a
 *   positive whole number of milliseconds.
 */
const durationOverride = (
  env: Environment,
  variable: string,
  fallback: number
): number => {
  const raw = env[variable];
  // Absent and empty both mean "the profile's own", because a platform that
  // writes every declared variable writes an empty string for the ones with no
  // value, and refusing that would refuse a deployment that set nothing.
  if (raw === undefined || raw === "") {
    return fallback;
  }
  // The safe-integer half matters as much as the shape: a duration past 2^53
  // passes the pattern, survives `normalizeRunProfile`'s "finite and positive",
  // and lands as a deadline arithmetic can no longer move.
  if (!(WHOLE_MILLISECONDS.test(raw) && Number.isSafeInteger(Number(raw)))) {
    throw new TypeError(
      `${variable} is ${JSON.stringify(raw)}, which is not a positive whole number of milliseconds`
    );
  }
  return Number(raw);
};

const reportToStderr = (error: Error): void => {
  // The pool discards the failed client itself, so there is nothing to do but
  // observe, and `@reprove/control-plane` holds no logger.
  process.stderr.write(
    `reprove: idle database connection failed: ${error.message}\n`
  );
};

/**
 * Parses the deployment's configuration.
 *
 * @param env The environment to read, usually `process.env`.
 * @param options What the deployment passes by name.
 * @returns What `createControlPlane()` is composed over.
 */
export const configFromEnvironment = (
  env: Environment,
  options: CompositionOptions
): ControlPlaneConfig => {
  const runProfile: Phase0RunProfile = {
    ...options.runProfile,
    claimableForMs: durationOverride(
      env,
      ENVIRONMENT.claimableForMs,
      options.runProfile.claimableForMs
    ),
    livenessForMs: durationOverride(
      env,
      ENVIRONMENT.livenessForMs,
      options.runProfile.livenessForMs
    ),
  };
  const github: ControlPlaneConfig["github"] = {
    webhookSecret: env[ENVIRONMENT.webhookSecret] ?? "",
    appId: env[ENVIRONMENT.appId] ?? "",
    privateKey: (env[ENVIRONMENT.privateKey] ?? "").replaceAll(
      ESCAPED_NEWLINE,
      "\n"
    ),
    runProfile,
  };
  // Absent and empty both mean GitHub's own root, so the default is not spelled
  // a second time here.
  const apiUrl = env[ENVIRONMENT.githubApiUrl];
  const config: ControlPlaneConfig = {
    database: {
      connectionString: env[ENVIRONMENT.databaseUrl] ?? "",
      onConnectionError: options.onConnectionError ?? reportToStderr,
    },
    github: apiUrl ? { ...github, apiUrl } : github,
  };
  return options.kick ? { ...config, kick: options.kick } : config;
};
