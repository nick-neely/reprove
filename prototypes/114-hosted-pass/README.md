# PROTOTYPE for #114 - never merged; kept as the standing hosted-Pass rig

This branch lives in its own worktree (`../reprove-rig`) so the main checkout stays clean. Reuse it
for later prototypes that need a real Vercel Sandbox, the deployed broker, or Workflow steps. It is
backed by the Vercel project `reprove-proto-114` (https://reprove-proto-114.vercel.app, deploy from
`app/` with `npx vercel deploy --prod`) and the Neon project `reprove-proto-114` (schema in
`app/lib/schema.sql`). `run.mjs` starts a hosted Pass on the deployment and polls it.

Answers [Prototype one real Codex Pass in a Vercel Sandbox from a Workflow step](https://github.com/nick-neely/reprove/issues/114).
Not part of the pnpm workspace (`prototypes/**` is excluded). `npm i` here.

Credentials: `~/.config/reprove-proto-114/env` (`VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `OPENAI_API_KEY`,
`DATABASE_URL`), the Vercel CLI login, and the #111 scratch App under `~/.config/reprove-proto-111`.

- `phase-a.mjs <probe>` - Sandbox SDK semantics (names, timeout, race, users, fetch, history).
- `b0.mjs start|continue` - same-turn resumption across two local processes (scaffold).
- `out/` - raw logs of every run; `out/ledger.jsonl` - spend ledger.
