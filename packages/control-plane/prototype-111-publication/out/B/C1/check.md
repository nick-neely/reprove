<!-- name: Reprove config -->
<!-- external_id: reprove.config.412.9f1c4d2 -->
<!-- status: completed conclusion: success -->
<!-- title: This file would load -->

## summary

`.reprove.yml` on this branch parses and every value it names is supported. Merging it changes how the next review runs, not this one.

## text

## What would apply

review.enabled would be true (configured); review.harness would be codex (configured); review.model would be gpt-5.6-sol (configured); review.autonomy would be verify (default); review.deadline would be 20m (configured); review.event would be COMMENT (default); review.threshold.severity would be high (configured, was medium); review.threshold.verification would be any (default); review.ignore would be generated/**, vendor/** (configured); review.budget would be USD 5.00 (configured).

## Narrowed values

You asked for `security.maxExposure: account`, and the effective value would be `scoped`, capped by the Reprove boundary for hosted placement, which never puts an account credential in a Sandbox. That is a narrowing rather than a refusal: it moves toward the safe position, so the file is accepted and the cap is reported.

<sub>external_id `reprove.config.412.9f1c4d2`</sub>
