<!-- packages/control-plane/src/github/publish.ts:88-88 -->

**Comments past the cap are dropped without a record, so a Finding disappears**

`comments.slice(0, MAX_COMMENTS)` truncates silently. A Finding whose Comment is dropped here keeps `publicationDisposition: inline_comment` in the database, so the stored disposition asserts a Comment that GitHub never received.

I tried to settle this by running something and it did not settle.

I ran:

```console
$ pnpm vitest run packages/control-plane/src/github/publish.test.ts
```

It never returned an exit code; I stopped it after 120s, which is why this is inconclusive rather than verified.
```text
stderr | publish.test.ts > submitReview > drops comments past the cap
connect ECONNREFUSED 127.0.0.1:56532
(no assertion reached before the 120s cap)
```

<sub>high · inconclusive · packages/control-plane/src/github/publish.ts:88</sub>
