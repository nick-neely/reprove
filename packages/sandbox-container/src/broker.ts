/**
 * How a real credential is kept out of a brokered Sandbox.
 *
 * On the Brokered Route the credential is substituted *outside* the boundary,
 * on the outbound request, after it has left the Sandbox. Inside there is only
 * a non-secret placeholder. `@ai-sdk/harness` will forward the real credential
 * into the sandboxed process environment when a provider declines to transform
 * the request, and the only thing it says about that is a `console.warn` - so
 * this package states the same posture as a Refusal instead, and states it on
 * the request rather than on the provider that happened to be wired up.
 *
 * There are three structural facts here, and none of them is a lint rule:
 *
 * 1. `SandboxRequest` has no credential member. There is nothing to pass one
 *    through.
 * 2. A credential-shaped environment *name* may hold the placeholder and
 *    nothing else.
 * 3. A denied environment name may hold nothing at all.
 */

/**
 * What a brokered Sandbox holds where a credential would be.
 *
 * Deliberately not secret-shaped: it is not a redaction of a real value, and
 * anything that treats it as one is looking at the wrong layer. A Harness that
 * reads it and sends it upstream gets a rejection from the provider, which is
 * the loud failure this design wants.
 */
export const BROKERED_PLACEHOLDER = "reprove-brokered-placeholder";

/** Whether a value is exactly the placeholder, and therefore not a credential. */
export const isBrokeredPlaceholder = (value: string): boolean =>
  value === BROKERED_PLACEHOLDER;

/**
 * The whole tokens that make an environment variable's name credential-shaped.
 *
 * Compared as tokens rather than as substrings, deliberately. A substring match
 * refuses `GITHUB_AUTHOR` for containing `AUTH` and `KEYBOARD` for containing
 * `KEY`, and a guard that refuses correct requests is a guard operators learn
 * to route around - which costs more than the false negative it was buying.
 */
const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  "TOKEN",
  "SECRET",
  "KEY",
  "APIKEY",
  "PASSWORD",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "AUTH",
  "COOKIE",
  "SESSION",
]);

/** Splits on `_`, which is the only separator an environment name has. */
const NAME_SEPARATOR = /_+/u;

/**
 * Whether a name reads as the place a credential goes.
 *
 * Case-insensitive, because `npm_password` and `NPM_PASSWORD` are the same
 * mistake.
 */
export const isCredentialName = (name: string): boolean =>
  name
    .toUpperCase()
    .split(NAME_SEPARATOR)
    .some((token) => CREDENTIAL_TOKENS.has(token));

/**
 * Environment names a Sandbox may not carry at any value, including the
 * placeholder.
 *
 * ADR 0004 bans a container-runtime socket reachable from inside the Sandbox,
 * and an environment variable is the cheapest way to reach one: `DOCKER_HOST`
 * and `CONTAINER_HOST` name it outright, and `XDG_RUNTIME_DIR` names the
 * directory a rootless runtime keeps it in.
 *
 * The list is wider than a socket. `LD_PRELOAD` and `LD_LIBRARY_PATH` reach no
 * socket at all - they change what the code inside the boundary *is*, before it
 * runs - and `SSH_AUTH_SOCK` and `DOCKER_CONFIG` hand out authority rather than
 * a route to the daemon. They are refused beside the socket names rather than
 * under a requirement of their own, because they are the same request: an
 * environment entry that redefines the boundary instead of configuring the
 * process inside it.
 */
export const DENIED_ENVIRONMENT_NAMES: readonly string[] = [
  "DOCKER_HOST",
  "CONTAINER_HOST",
  "DOCKER_CONFIG",
  "XDG_RUNTIME_DIR",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "SSH_AUTH_SOCK",
];

const DENIED: ReadonlySet<string> = new Set(DENIED_ENVIRONMENT_NAMES);

/** Whether a name is on the denied list, whatever it was going to hold. */
export const isDeniedEnvironmentName = (name: string): boolean =>
  DENIED.has(name.toUpperCase());

/** What a name may be made of, which is what POSIX allows and nothing else. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Whether a name is a name at all.
 *
 * Both guards above read the name they were given, and an entry is rendered as
 * `name=value` - so a *name* holding an `=` sets a variable neither guard ever
 * saw. `{ name: "ANTHROPIC_API_KEY=sk-live", value: "" }` renders
 * `--env ANTHROPIC_API_KEY=sk-live=`, which sets `ANTHROPIC_API_KEY`, and the
 * credential guard splits `ANTHROPIC_API_KEY=sk-live` on `_` into a last token
 * of `KEY=SK-LIVE`, which is not `KEY`. Every guard downstream of a name that
 * is not a name is reading the wrong string.
 *
 * So the shape is required rather than sanitised. It also refuses the empty
 * name, which renders `--env =value`.
 */
export const isEnvironmentName = (name: string): boolean =>
  ENVIRONMENT_NAME.test(name);
