<!-- event: COMMENT -->

### Findings index - 1 made, 1 commented, 0 not

| # | sev | verif | location | finding | where |
| --- | --- | --- | --- | --- | --- |
| 1 | 🟧 high | `static` | [`packages/worker-hosted/src/slice.ts:144`](https://github.com/nick-neely/reprove/blob/9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2/packages/worker-hosted/src/slice.ts#L144) | The cursor is advanced before the append is durable | [comment 1](https://github.com/nick-neely/reprove/pull/412#discussion_r900000000) |

> ⚠️ **Unfinished.** The index above is not a whole-diff result. Not reviewed: I did not review packages/control-plane/src/accounting/** or the Workflow step that drives the Slices. The append path is the only thing I examined closely enough to make a claim about.

| limitation | detail |
| --- | --- |
| `service_unavailable` | the local Postgres stack on 56532 refused connections, so nothing touching the database could be executed |
| `scope_limit` | packages/control-plane/src/accounting/** was left out; see `unfinished` |

<sub>Run `3c41ad88` at `9f1c4d2` · threshold `medium`/`any` · ignore none · full ledger and terminal facts in the **Checks** tab</sub>
