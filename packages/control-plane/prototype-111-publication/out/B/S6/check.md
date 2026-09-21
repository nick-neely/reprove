<!-- name: Reprove -->
<!-- external_id: reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26 -->
<!-- status: completed conclusion: failure -->
<!-- title: The Worker refused to execute: policy_unenforceable -->

## summary

The Worker refused to execute: policy_unenforceable.

Required: autonomy=inspect enforced by the Harness. Actual: codex 0.61.2 (artifact fingerprint sha256:4c19…a7) advertises no tool restriction below `verify`.

**What to do:** Change `review.autonomy`, or pin a Harness that can enforce it, then re-run this Check. Nothing is retried automatically: the attempt already spent a probe turn and a Sandbox.

No Review was published. Nothing executed past the authorization line, so there is no Result and no Review.

## text

## What ran

A codex Harness, named in `.reprove.yml`, driving gpt-5.6-sol (configured) at autonomy inspect (configured). Its deadline was 20m (configured) and it ran for 41s.

## What it cost

Usage was in 1,204 / out 96 / cached unknown / reasoning unknown (incomplete). The cost is **unknown**, not zero: `price-catalogue-2026-09-02` does not price this Model, and reporting an unpriced run as $0.00 would be a lie about spend. The aggregate is `incomplete`, so the real figure is at least this and possibly more.

## Provenance

This lineage's qualification status is `unqualified`, which means it has never passed the adversarial gate. Provider drift: none.

## The refusal

The Worker was dispatched and stopped before it was authorized to execute. It required autonomy=inspect enforced by the Harness, and found codex 0.61.2 (artifact fingerprint sha256:4c19…a7) advertises no tool restriction below `verify`. It named the requirement rather than quietly doing something narrower, which is the point of a Refusal. Nothing is re-offered automatically: the attempt already spent a probe turn and a Sandbox.

<sub>external_id `reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26`</sub>
