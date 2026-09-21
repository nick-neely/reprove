<!-- name: Reprove -->
<!-- external_id: reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26 -->
<!-- status: completed conclusion: failure -->
<!-- title: The Worker refused to execute: policy_unenforceable -->

## summary

**The Worker refused to execute: policy_unenforceable.**

Required: autonomy=inspect enforced by the Harness. Actual: codex 0.61.2 (artifact fingerprint sha256:4c19…a7) advertises no tool restriction below `verify`.

**Next:** Change `review.autonomy`, or pin a Harness that can enforce it, then re-run this Check. Nothing is retried automatically: the attempt already spent a probe turn and a Sandbox.

**No Review published.** Nothing executed past the authorization line, so there is no Result and no Review.

| | |
| --- | --- |
| Harness | `codex` (configured) |
| Model | `gpt-5.6-sol` (configured) |
| Autonomy | `inspect` (configured) |
| Deadline | `20m` (configured) |
| Duration | 41s |
| Usage | in 1,204 / out 96 / cached unknown / reasoning unknown (incomplete) |
| Estimated cost | unknown under `price-catalogue-2026-09-02` |
| Lineage qualification | `unqualified` |
| Provider drift | none |

## text

## Refusal

| | |
| --- | --- |
| reason | `policy_unenforceable` |
| required | autonomy=inspect enforced by the Harness |
| actual | codex 0.61.2 (artifact fingerprint sha256:4c19…a7) advertises no tool restriction below `verify` |
| origin | the Worker, after dispatch and before authorization |

<sub>`external_id: reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26`</sub>
