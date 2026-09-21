<!-- event: COMMENT -->

**1 high.** 1 commented. **Unfinished.**

| sev | verification | location | finding |
| --- | --- | --- | --- |
| 🟧 high | static | [`packages/worker-hosted/src/slice.ts:144`](https://github.com/nick-neely/reprove/pull/412#discussion_r900000000) | The cursor is advanced before the append is durable |

**Not reviewed:** I did not review packages/control-plane/src/accounting/** or the Workflow step that drives the Slices. The append path is the only thing I examined closely enough to make a claim about.

**Limitation** `service_unavailable`: the local Postgres stack on 56532 refused connections, so nothing touching the database could be executed

**Limitation** `scope_limit`: packages/control-plane/src/accounting/** was left out; see `unfinished`

<sub>Run `3c41ad88` at `9f1c4d2` · threshold `medium`/`any` · terminal facts and full ledger in the Checks tab</sub>
