# PROTOTYPE for #137 - never merged

Answers [Measure a deadline wrap-up on a long review thread](https://github.com/nick-neely/reprove/issues/137).
Findings are in [RESULTS.md](RESULTS.md).

`wrapup.mjs` drives ADR 0032's handoff on a real Vercel Sandbox with the #135 image (Codex 0.156.1, patched bridge,
allowlist wrapper, Reviewer uid 2000). The steps are: abort, `doStop()`, the quiescence proof, a custody transaction on
the #114 rig's Neon database (`p137_*` tables), a generation-2 bridge, the ADR 0031 §7 checks, the wrap-up turn,
validation and persistence. Each step is timed from A.

- `repair`: slices the initial turn three times, with the third attach on a rewound cursor. It lets the turn finish,
  then aborts the repair turn.
- `long`: seeds the thread to 160-200K tokens with paced reference turns under the same instructions, lets the TPM
  bucket refill, then aborts the review turn.
- `fixture.mjs`: the fixture pull request. `sandbox/`: the image's wrapper scripts and the root-side probes (`rollout.mjs`,
  `procs.sh`, `quiesce.sh`, `plant.sh`, plus #135's checks).
- Not part of the pnpm workspace. `npm i` here.
