<!-- packages/worker-hosted/src/slice.ts:166-169 -->

**The retry backoff is unbounded, so a stuck Slice pins a Sandbox for the whole deadline**

The new retry loop multiplies the delay without a ceiling and without a total attempt budget, so a Sandbox stays alive until the hard deadline collects it.

I proved this by running something; the output is below.

I ran:

```console
$ pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'backoff'
```

It exited 1 after 9s.
```text
FAIL  driveSlice > backoff is bounded
AssertionError: expected 524288 to be less than or equal to 30000
```

<sub>high · verified · packages/worker-hosted/src/slice.ts:166-169</sub>
