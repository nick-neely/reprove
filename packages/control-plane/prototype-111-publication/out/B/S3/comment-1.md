<!-- packages/worker-hosted/src/slice.ts:144-144 -->

**The cursor is advanced before the append is durable**

`appendMaterializationLog` resolves on enqueue rather than on write, so a Slice that dies between the enqueue and the flush loses the chunk and still moves the cursor.

I reached this by reading the code. Nothing was executed to prove it.

<sub>high · static · packages/worker-hosted/src/slice.ts:144</sub>
