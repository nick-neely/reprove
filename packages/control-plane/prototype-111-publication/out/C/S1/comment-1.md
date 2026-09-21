<!-- packages/worker-hosted/src/slice.ts:142-146 -->

**[1] A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files**

| | |
| --- | --- |
| severity | 🟥 `critical` |
| verification | `verified` |
| location | `packages/worker-hosted/src/slice.ts:142-146` |
| disposition | `inline_comment` |
| reconciliation | `new` |

`driveSlice` returns `done: stream.closedCleanly`, but `openLogStream` sets `closedCleanly` on any close it did not itself abort, including an upstream reset. A Slice that reads `done: true` advances the cursor, so the next Slice starts a turn on a Workspace that is still missing files, and ADR 0024's closure sequence never runs.

| command | exit | duration | output |
| --- | --- | --- | --- |
| `pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'resumes after a lost stream'` | 1 | 21s | truncated from 18442B |

```text
FAIL  packages/worker-hosted/src/slice.test.ts > driveSlice > resumes after a lost stream
AssertionError: expected { done: false } to match { done: true }
  at slice.test.ts:64:22

Test Files  1 failed (1)
```
