<!-- name: Reprove config -->
<!-- external_id: reprove.config.412.9f1c4d2 -->
<!-- status: completed conclusion: failure -->
<!-- title: This file would not load -->

## summary

`.reprove.yml` on this branch has an unknown key at line 9: `review.autonmy`. Unknown keys are rejected rather than ignored, so if this merged, every review on the default branch would refuse until it is fixed.

## text

## What is wrong

unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?

## What it does not affect

This pull request is still being reviewed, under the configuration on the base branch. A pull request cannot change the configuration used to review itself, so a broken file here never silently reviews itself under its own new rules.

<sub>external_id `reprove.config.412.9f1c4d2`</sub>


<!-- annotations -->

```json
[
  {
    "path": ".reprove.yml",
    "start_line": 9,
    "end_line": 9,
    "annotation_level": "failure",
    "title": "unknown key `review.autonmy`",
    "message": "unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?"
  }
]
```
