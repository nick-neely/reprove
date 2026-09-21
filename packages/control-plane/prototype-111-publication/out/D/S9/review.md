<!-- event: COMMENT -->

**1 critical, 1 high.** 1 commented, 1 carried over.

| sev | verification | location | finding |
| --- | --- | --- | --- |
| 🟥 critical | ✅ verified | [`packages/worker-hosted/src/slice.ts:142-146`](https://github.com/nick-neely/reprove/pull/412#discussion_r2411903776) | A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files - still open from the previous review |
| 🟧 high | ✅ verified | [`packages/worker-hosted/src/slice.ts:166-169`](https://github.com/nick-neely/reprove/pull/412#discussion_r900000000) | The retry backoff is unbounded, so a stuck Slice pins a Sandbox for the whole deadline |

**No longer reported:** 2 earlier Findings.

<details><summary>Which ones</summary>

- `packages/control-plane/src/github/publish.ts` - Comments past the cap are dropped without a record, so a Finding disappears
- `apps/control-plane/src/app/api/webhook/route.ts` - The webhook body is read before the signature is checked

</details>

<sub>Run `9a15c7e3` at `b7d02e4` · threshold `medium`/`any` · terminal facts and full ledger in the Checks tab</sub>
