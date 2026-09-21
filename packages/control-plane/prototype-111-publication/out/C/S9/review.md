<!-- event: COMMENT -->

### Findings index - 2 made, 1 commented, 1 not

| # | sev | verif | location | finding | where |
| --- | --- | --- | --- | --- | --- |
| 1 | 🟥 critical | `verified` | [`packages/worker-hosted/src/slice.ts:142-146`](https://github.com/nick-neely/reprove/blob/b7d02e4a1c93f85062ba4d7e19c05f3a8e2d6b41/packages/worker-hosted/src/slice.ts#L142) | A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files | [already reported](https://github.com/nick-neely/reprove/pull/412#discussion_r2411903776) |
| 2 | 🟧 high | `verified` | [`packages/worker-hosted/src/slice.ts:166-169`](https://github.com/nick-neely/reprove/blob/b7d02e4a1c93f85062ba4d7e19c05f3a8e2d6b41/packages/worker-hosted/src/slice.ts#L166) | The retry backoff is unbounded, so a stuck Slice pins a Sandbox for the whole deadline | [comment 1](https://github.com/nick-neely/reprove/pull/412#discussion_r900000000) |

<sub>Run `9a15c7e3` at `b7d02e4` · threshold `medium`/`any` · ignore none · full ledger and terminal facts in the **Checks** tab</sub>
