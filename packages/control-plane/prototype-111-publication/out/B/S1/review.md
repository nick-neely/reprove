<!-- event: COMMENT -->

Reviewed the materialization streaming path end to end. The resume contract is the load-bearing change and it does not hold: a lost stream is reported as a clean close. Two further defects sit on the publication and ingress paths.

I am reporting 1 critical, 2 high, 1 medium and 1 low. 3 of them are left as comments on the lines they concern.

**The untouched authorization line now runs after materialization can still fail** - this one is in `packages/worker-core/src/run.ts:311`, which this pull request does not touch, so GitHub has nowhere to anchor a comment and it has to live here instead. I rated it high and reached it by reading only. `authorizeExecution` is called from the new streaming path while materialization is still polled, so a Refusal raised after this point would be recorded as an execution Failure instead. The file is not in this pull request's diff.

One thing about the environment rather than the code: git submodules under vendor/ did not resolve in the Workspace, so vendor/harness-bridge was read as an empty directory. That is recorded as a `dependency_unavailable` Limitation. It did not by itself leave the review unfinished.

1 further Finding sits below this repository's threshold of `medium` and is kept out of this review. Lowering the threshold shows them without needing another run.

<sub>codex (configured) driving gpt-5.6-sol (configured) at autonomy verify (default), deadline 20m (configured), for 8m 41s. Usage in 184,220 / out 12,905 / cached 96,300 / reasoning 7,400 (complete), estimated $1.42 under price-catalogue-2026-09-02, whose lineage is unqualified. The Provider served gpt-5.6-sol-2026-08-19.</sub>
