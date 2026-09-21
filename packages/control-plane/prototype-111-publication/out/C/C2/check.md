<!-- name: Reprove config -->
<!-- external_id: reprove.config.412.9f1c4d2 -->
<!-- status: completed conclusion: failure -->
<!-- title: invalid · .reprove.yml:9 -->

## summary

| | |
| --- | --- |
| file | `.reprove.yml` at `9f1c4d2` |
| key | `review.autonmy` |
| line | 9 |
| applied | never - this Check reads the head, it does not apply it |
| external_id | `reprove.config.412.9f1c4d2` |

## text

## Error

unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?

## Effect if merged

Every review on the default branch would end in a control-plane Refusal until this key is fixed or removed.


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
