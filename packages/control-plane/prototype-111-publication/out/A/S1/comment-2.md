<!-- packages/control-plane/src/github/publish.ts:88-88 -->

`high` · `inconclusive` **Comments past the cap are dropped without a record, so a Finding disappears**

`comments.slice(0, MAX_COMMENTS)` truncates silently. A Finding whose Comment is dropped here keeps `publicationDisposition: inline_comment` in the database, so the stored disposition asserts a Comment that GitHub never received.

<details><summary>Evidence: <code>pnpm vitest run packages/control-plane/src/github/publish.test.ts</code> (no exit code, 120s)</summary>

```text
stderr | publish.test.ts > submitReview > drops comments past the cap
connect ECONNREFUSED 127.0.0.1:56532
(no assertion reached before the 120s cap)
```

</details>
