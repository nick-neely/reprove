<!-- name: Reprove config -->
<!-- external_id: reprove.config.c2a91b6f-30d4-4e17-9c88-6b0f5e2d7a43 -->
<!-- status: completed conclusion: failure -->
<!-- title: Invalid: review.autonmy (line 9) -->

## summary

**`.reprove.yml` would not load.** unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?

**Next:** fix `review.autonmy` (line 9 of `.reprove.yml`) on this branch.

This pull request is still reviewed under the base branch's configuration; a pull request cannot change the configuration used to review itself.

## text

## Effect if merged

Every review on the default branch ends in a control-plane Refusal until this key is fixed or removed.

<sub>`external_id: reprove.config.c2a91b6f-30d4-4e17-9c88-6b0f5e2d7a43`</sub>


<!-- annotations -->

```json
[
  {
    "path": ".reprove.yml",
    "start_line": 9,
    "end_line": 9,
    "annotation_level": "failure",
    "title": "unknown key review.autonmy",
    "message": "unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?"
  }
]
```
