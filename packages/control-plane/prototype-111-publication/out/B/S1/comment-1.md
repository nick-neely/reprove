<!-- packages/worker-hosted/src/slice.ts:142-146 -->

**A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files**

`driveSlice` returns `done: stream.closedCleanly`, but `openLogStream` sets `closedCleanly` on any close it did not itself abort, including an upstream reset. A Slice that reads `done: true` advances the cursor, so the next Slice starts a turn on a Workspace that is still missing files, and ADR 0024's closure sequence never runs.

I proved this by running something; the output is below.

I ran:

```console
$ pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'resumes after a lost stream'
```

It exited 1 after 21s. I have kept the relevant part of 18442 bytes of output.
```text
FAIL  packages/worker-hosted/src/slice.test.ts > driveSlice > resumes after a lost stream
AssertionError: expected { done: false } to match { done: true }
  at slice.test.ts:64:22

Test Files  1 failed (1)
```

<sub>critical · verified · packages/worker-hosted/src/slice.ts:142-146</sub>
