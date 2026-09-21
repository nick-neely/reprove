<!-- packages/worker-hosted/src/slice.ts:142-146 -->

`critical` · `verified` **A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files**

`driveSlice` returns `done: stream.closedCleanly`, but `openLogStream` sets `closedCleanly` on any close it did not itself abort, including an upstream reset. A Slice that reads `done: true` advances the cursor, so the next Slice starts a turn on a Workspace that is still missing files, and ADR 0024's closure sequence never runs.

<details><summary>Evidence: <code>pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'resumes after a lost stream'</code> (exit 1, 21s · truncated from 18442 bytes)</summary>

```text
FAIL  packages/worker-hosted/src/slice.test.ts > driveSlice > resumes after a lost stream
AssertionError: expected { done: false } to match { done: true }
  at slice.test.ts:64:22

Test Files  1 failed (1)
```

</details>
