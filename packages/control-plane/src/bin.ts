#!/usr/bin/env node
/**
 * The operator entry point, and the **only** place in this package that reads
 * the environment. ADR 0010 keeps `@reprove/control-plane` free of environment
 * reads: the app parses deployment configuration and passes it explicitly, and
 * `bootstrap()` and `migrate()` are exported so a consumer is never forced to
 * shell out.
 *
 * The credentials arrive as environment variables rather than as arguments
 * because argv is world-readable on most systems: a password on the command
 * line leaks into every process listing on the host.
 */
import { bootstrap, migrate, RUNTIME_ROLE } from "./db/index.js";

const ADMIN_URL = "REPROVE_DATABASE_ADMIN_URL";
const RUNTIME_PASSWORD = "REPROVE_DATABASE_RUNTIME_PASSWORD";

const USAGE = `usage: reprove-control-plane <bootstrap|migrate>

  bootstrap   Provision the restricted runtime role "${RUNTIME_ROLE}" and the
              privileges the migrations hand it. Creates no table.
  migrate     Apply every committed migration that is not applied yet.

The two are ordered, not interchangeable: every migration grants the tenant
boundary to the runtime role, so the role has to exist first.

Both read the admin connection from ${ADMIN_URL}, and bootstrap reads the
runtime role's password from ${RUNTIME_PASSWORD}. Neither is an argument,
because argv leaks a secret to every process listing on the host.
`;

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set.\n\n${USAGE}`);
  }
  return value;
};

const main = async (command: string | undefined): Promise<void> => {
  if (command === "bootstrap") {
    await bootstrap({
      connectionString: required(ADMIN_URL),
      runtimePassword: required(RUNTIME_PASSWORD),
    });
    process.stdout.write(
      `bootstrap: the runtime role "${RUNTIME_ROLE}" is provisioned. Run \`reprove-control-plane migrate\` next.\n`
    );
    return;
  }

  if (command === "migrate") {
    const applied = await migrate({ connectionString: required(ADMIN_URL) });
    process.stdout.write(
      applied.length === 0
        ? "migrate: already up to date.\n"
        : `migrate: applied ${applied.length} migration(s): ${applied.join(", ")}\n`
    );
    return;
  }

  throw new Error(
    command === undefined
      ? `no command given.\n\n${USAGE}`
      : `unknown command "${command}".\n\n${USAGE}`
  );
};

main(process.argv[2]).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
