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
  const github: ControlPlaneConfig["github"] = {
    webhookSecret: env[ENVIRONMENT.webhookSecret] ?? "",
    appId: env[ENVIRONMENT.appId] ?? "",
    privateKey: (env[ENVIRONMENT.privateKey] ?? "").replaceAll(
      ESCAPED_NEWLINE,
      "\n"
    ),
    runProfile: options.runProfile,
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
