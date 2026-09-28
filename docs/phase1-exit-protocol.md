# Phase 1 exit protocol

The live half of the Phase 1 exit proof, decided by
[Fix the Phase 1 exit scenario and hand off the tracer bullets](https://github.com/nick-neely/reprove/issues/116).
The deterministic half is `tools/phase1-exit.mjs`, which doubles the Sandbox and Harness. That
scenario proves orchestration, the requested checkout SHAs and publication. Only this live run
proves a real Sandbox checkout and a real Codex review.

This document is the protocol, not the record. The live exit ticket executes it and writes the
record to `docs/phase1-exit.md`. Until that file exists, the Phase 1 exit has not happened.

## Preconditions

- Every handoff ticket this protocol depends on is closed, including the Phase 1 CI scenario, the
  ADR 0008 purge and ADR 0028 reaping proofs, and the adopter documentation.
- The real-Sandbox boundary job has passed on the exact commit being deployed. Rerun it if that
  commit changes.
- The deployment is the maintainer's own (reprove.stacklet.app), built by following the
  deploy-your-own guide from a clean start: Vercel project, Neon database, GitHub App registered
  with the Phase 1 write set (ADR 0026), OpenAI key.
- The App is installed on `nick-neely/reprove-fixture` only.
- The Sandbox `forwardURL` is the deployment's production domain (#114).

## Steps

1. **Automatic review.** Open a new pull request on the fixture repository. Expect a Review, its
   Comments and a concluded Check that agrees with the Review.
2. **Configuration.** The base ref's `.reprove.yml` resolves to the recorded `RunSpec`, and the
   `Reprove config` Check reports it. One pull request carries an unsupported value and must end
   in a named Refusal on its Check.
3. **Hand request.** Re-run the Check from GitHub's UI. Expect a new Run and a fresh Review.
4. **Supersession.** Push a second commit while the first Pass is live. Verify that no stale
   Review publishes, the old Check concludes `cancelled`, and the superseded Pass's Sandbox is
   reaped.
5. **Failure, then retry.** Force a Failure (for example an unreachable Provider for one Run).
   The Failure must reach the pull request by name on the Check. Then re-run the Check and expect a
   successful Review.

## Evidence the record must hold

- The deployed commit and the exact Revision identity (Harness, route, Provider, Model,
  Autonomy, policy digest, image).
- The App's granted permissions as GitHub reports them.
- Links to every visible GitHub artifact: pull requests, Reviews, Comments, Check runs and their
  conclusions.
- Database evidence per Run: status, terminal reason, Refusals or Failure detail, Usage, and the
  reaped Sandbox's provider state.
- The longest observed Provider request (ADR 0033).
- The qualification state of that exact Revision as of the exit: the Revision, a reference to the
  gate report or ledger entry, and the state (qualified, failed or not run). Qualification is
  advisory and does not block the exit.

## Who asserts what

The maintainer judges the published Review, Comments and Check by eye. An agent reads back the
database and the Provider timings, and assembles the record.
