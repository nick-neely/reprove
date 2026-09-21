<!-- event: COMMENT -->

### Findings index - 5 made, 3 commented, 2 not

| # | sev | verif | location | finding | where |
| --- | --- | --- | --- | --- | --- |
| 1 | 🟥 critical | `verified` | [`packages/worker-hosted/src/slice.ts:142-146`](https://github.com/nick-neely/reprove/blob/9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2/packages/worker-hosted/src/slice.ts#L142) | A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files | [comment 1](https://github.com/nick-neely/reprove/pull/412#discussion_r900000000) |
| 2 | 🟧 high | `inconclusive` | [`packages/control-plane/src/github/publish.ts:88`](https://github.com/nick-neely/reprove/blob/9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2/packages/control-plane/src/github/publish.ts#L88) | Comments past the cap are dropped without a record, so a Finding disappears | [comment 2](https://github.com/nick-neely/reprove/pull/412#discussion_r900000001) |
| 3 | 🟧 high | `static` | [`packages/worker-core/src/run.ts:311`](https://github.com/nick-neely/reprove/blob/9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2/packages/worker-core/src/run.ts#L311) | The untouched authorization line now runs after materialization can still fail | annotation, **Checks** tab |
| 4 | 🟨 medium | `static` | [`apps/control-plane/src/app/api/webhook/route.ts:57`](https://github.com/nick-neely/reprove/blob/9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2/apps/control-plane/src/app/api/webhook/route.ts#L57) | The webhook body is read before the signature is checked | [comment 3](https://github.com/nick-neely/reprove/pull/412#discussion_r900000002) |
| 5 | ⬜ low | `static` | [`packages/control-plane/src/accounting/usage.ts:204`](https://github.com/nick-neely/reprove/blob/9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2/packages/control-plane/src/accounting/usage.ts#L204) | `aggregateUsage` coerces an unreported step to zero tokens | below threshold |

> 1 Finding above is outside this pull request's diff. It is annotated at its exact line in the **Checks** tab rather than restated here.

| limitation | detail |
| --- | --- |
| `dependency_unavailable` | git submodules under vendor/ did not resolve in the Workspace, so vendor/harness-bridge was read as an empty directory |

<sub>Run `1f0c8a5e` at `9f1c4d2` · threshold `medium`/`any` · ignore `generated/**` · full ledger and terminal facts in the **Checks** tab</sub>
