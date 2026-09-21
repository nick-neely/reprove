<!-- packages/control-plane/src/github/publish.ts:88-88 -->

**[2] Comments past the cap are dropped without a record, so a Finding disappears**

| | |
| --- | --- |
| severity | 🟧 `high` |
| verification | `inconclusive` |
| location | `packages/control-plane/src/github/publish.ts:88` |
| disposition | `inline_comment` |
| reconciliation | `new` |

`comments.slice(0, MAX_COMMENTS)` truncates silently. A Finding whose Comment is dropped here keeps `publicationDisposition: inline_comment` in the database, so the stored disposition asserts a Comment that GitHub never received.

| command | exit | duration | output |
| --- | --- | --- | --- |
| `pnpm vitest run packages/control-plane/src/github/publish.test.ts` | none | 120s | 214B |

```text
stderr | publish.test.ts > submitReview > drops comments past the cap
connect ECONNREFUSED 127.0.0.1:56532
(no assertion reached before the 120s cap)
```
