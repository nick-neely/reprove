<!-- packages/worker-hosted/src/slice.ts:144-144 -->

**[1] The cursor is advanced before the append is durable**

| | |
| --- | --- |
| severity | 🟧 `high` |
| verification | `static` |
| location | `packages/worker-hosted/src/slice.ts:144` |
| disposition | `inline_comment` |
| reconciliation | `new` |

`appendMaterializationLog` resolves on enqueue rather than on write, so a Slice that dies between the enqueue and the flush loses the chunk and still moves the cursor.

_No Evidence. This claim was reasoned, not executed._
