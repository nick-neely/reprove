<!-- packages/worker-hosted/src/slice.ts:166-169 -->

**[1] The retry backoff is unbounded, so a stuck Slice pins a Sandbox for the whole deadline**

| | |
| --- | --- |
| severity | 🟧 `high` |
| verification | `verified` |
| location | `packages/worker-hosted/src/slice.ts:166-169` |
| disposition | `inline_comment` |
| reconciliation | `new` |

The new retry loop multiplies the delay without a ceiling and without a total attempt budget, so a Sandbox stays alive until the hard deadline collects it.

| command | exit | duration | output |
| --- | --- | --- | --- |
| `pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'backoff'` | 1 | 9s | 142B |

```text
FAIL  driveSlice > backoff is bounded
AssertionError: expected 524288 to be less than or equal to 30000
```
