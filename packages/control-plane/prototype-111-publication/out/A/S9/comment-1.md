<!-- packages/worker-hosted/src/slice.ts:166-169 -->

`high` · `verified` **The retry backoff is unbounded, so a stuck Slice pins a Sandbox for the whole deadline**

The new retry loop multiplies the delay without a ceiling and without a total attempt budget, so a Sandbox stays alive until the hard deadline collects it.

<details><summary>Evidence: <code>pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'backoff'</code> (exit 1, 9s)</summary>

```text
FAIL  driveSlice > backoff is bounded
AssertionError: expected 524288 to be less than or equal to 30000
```

</details>
