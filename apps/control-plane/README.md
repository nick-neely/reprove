# `@reprove/control-plane-app`

The thin Next.js composition shell for the control plane. It is **a deployable application, not a package** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)): a self-hoster deploys it, and nobody writes code against it.

It owns route wiring, environment parsing and deployment configuration, and nothing else. Control-plane substance lives in `@reprove/control-plane`; every workflow and step definition lives in `@reprove/control-plane-workflow`. The dependency matrix in `tools/verify-workspace.mjs` enforces that: this app cannot import a Postgres driver, Octokit or Better Auth, so it cannot accumulate control-plane logic.

## Routes

| Route | What it is |
|---|---|
| `POST /api/github/webhook` | The App's single hook URL. Wiring and environment parsing only; the handler, the signature check, the envelope and the commit are all `@reprove/control-plane`. |

It reads two environment variables, because the package reads none:
`REPROVE_DATABASE_URL` (the **pooled** endpoint as the restricted runtime role) and
`REPROVE_GITHUB_WEBHOOK_SECRET`.

Two things about that route are deliberate and would otherwise read as accidents.

**The control plane is composed once per process, not per request.** `createControlPlane()` opens a
connection pool and runs [ADR 0008](../../docs/adr/0008-persistence-tenancy-and-retention.md) rule
6's seven tenancy assertions, and repeating that per delivery would spend GitHub's ten-second wall
on work whose answer cannot change between two requests. A composition that throws is **not**
memoized as a failure: a boot refusal is usually a deployment being repaired, and until it succeeds
every delivery gets a non-2xx, which is the answer
[ADR 0013](../../docs/adr/0013-github-ingress-and-run-creation-idempotency.md) wants - the delivery
stays manually redeliverable rather than being acknowledged by a process that cannot store it.

**`@reprove/control-plane` is loaded through Node's own resolution rather than bundled into the
route.** [ADR 0017](../../docs/adr/0017-authoring-time-tenancy-boundary.md) makes its `drizzle/`
folder a runtime asset - the boot assertion joins the hashes Drizzle stored against the committed
files that produced them - so the package resolves that folder relative to its own module. Bundled,
the relative base becomes the bundle's location and the files are not beside it. Next's
`serverExternalPackages` is the configuration built for this and cannot express it: it matches the
**resolved** path against `/node_modules/<package>/`, and a pnpm workspace link resolves through to
`packages/control-plane`, where that pattern never matches. The per-import opt-out is what is left,
and it is narrower anyway.

Beyond that route this is still a shell - one layout and one page - and carries no product
behaviour.
