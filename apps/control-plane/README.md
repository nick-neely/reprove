# `@reprove/control-plane-app`

The thin Next.js composition shell for the control plane. It is **a deployable application, not a package** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)): a self-hoster deploys it, and nobody writes code against it.

It owns route wiring, environment parsing and deployment configuration, and nothing else. Control-plane substance lives in `@reprove/control-plane`; every workflow and step definition lives in `@reprove/control-plane-workflow`. The dependency matrix in `tools/verify-workspace.mjs` enforces that: this app cannot import a Postgres driver, Octokit or Better Auth, so it cannot accumulate control-plane logic.

At Phase 0 this is a shell - one layout and one page - and carries no product behaviour.
