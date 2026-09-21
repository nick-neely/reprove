<!-- name: Reprove config -->
<!-- external_id: reprove.config.c1d7e402-88a6-4f31-b05c-7a2e9d641f30 -->
<!-- status: completed conclusion: success -->
<!-- title: Valid; this is what would apply -->

## summary

**Valid.** If this merges, the next review runs under:

| key | value | |
| --- | --- | --- |
| `review.enabled` | true | configured |
| `review.harness` | codex | configured |
| `review.model` | gpt-5.6-sol | configured |
| `review.autonomy` | verify | default |
| `review.deadline` | 20m | configured |
| `review.event` | COMMENT | default |
| `review.threshold.severity` | high | configured, was medium |
| `review.threshold.verification` | any | default |
| `review.ignore` | generated/**, vendor/** | configured |
| `review.budget` | USD 5.00 | configured |

| narrowed | requested | effective | by |
| --- | --- | --- | --- |
| `security.maxExposure` | requested `account` | **effective `scoped`** | Reprove boundary |

Not applied to this pull request: a pull request cannot change the configuration used to review itself.

## text

_(none)_
