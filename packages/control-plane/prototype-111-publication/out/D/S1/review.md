<!-- event: COMMENT -->

**1 critical, 2 high, 1 medium.** 3 commented, 1 outside the diff.

| sev | verification | location | finding |
| --- | --- | --- | --- |
| 🟥 critical | ✅ verified | [`packages/worker-hosted/src/slice.ts:142-146`](https://github.com/nick-neely/reprove/pull/412#discussion_r900000000) | A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files |
| 🟧 high | ❌ inconclusive | [`packages/control-plane/src/github/publish.ts:88`](https://github.com/nick-neely/reprove/pull/412#discussion_r900000001) | Comments past the cap are dropped without a record, so a Finding disappears |
| 🟧 high | static | [`packages/worker-core/src/run.ts:311`](https://github.com/nick-neely/reprove/pull/412/checks) | The untouched authorization line now runs after materialization can still fail - outside the diff |
| 🟨 medium | static | [`apps/control-plane/src/app/api/webhook/route.ts:57`](https://github.com/nick-neely/reprove/pull/412#discussion_r900000002) | The webhook body is read before the signature is checked |

**Outside the diff:** 1. GitHub cannot anchor a Comment there, so it is annotated at its exact line in the Checks tab.

**Below threshold:** 1 Finding (1 low), kept out by `threshold.severity: medium`. Full rows are in the Check.

**Limitation** `dependency_unavailable`: git submodules under vendor/ did not resolve in the Workspace, so vendor/harness-bridge was read as an empty directory

<sub>Run `1f0c8a5e` at `9f1c4d2` · threshold `medium`/`any` · terminal facts and full ledger in the Checks tab</sub>
