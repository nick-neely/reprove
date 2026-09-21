<!-- name: Reprove config -->
<!-- external_id: reprove.config.412.9f1c4d2 -->
<!-- status: completed conclusion: failure -->
<!-- title: Invalid at line 9 -->

## summary

**`.reprove.yml` line 9: unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?**

Nothing here has been applied. This Check reads the head file only; the review below ran under the base branch's configuration.

## text

_(none)_


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
