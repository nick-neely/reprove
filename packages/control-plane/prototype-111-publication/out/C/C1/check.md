<!-- name: Reprove config -->
<!-- external_id: reprove.config.412.9f1c4d2 -->
<!-- status: completed conclusion: success -->
<!-- title: valid · 10 keys, 1 narrowed -->

## summary

| | |
| --- | --- |
| file | `.reprove.yml` at `9f1c4d2` |
| verdict | valid |
| narrowed | 1 |
| applied | never - this reports what would apply if merged |
| external_id | `reprove.config.412.9f1c4d2` |

## text

## Would apply if merged

| key | effective | source |
| --- | --- | --- |
| `review.enabled` | `true` | configured |
| `review.harness` | `codex` | configured |
| `review.model` | `gpt-5.6-sol` | configured |
| `review.autonomy` | `verify` | default |
| `review.deadline` | `20m` | configured |
| `review.event` | `COMMENT` | default |
| `review.threshold.severity` | `high` | configured, was medium |
| `review.threshold.verification` | `any` | default |
| `review.ignore` | `generated/**, vendor/**` | configured |
| `review.budget` | `USD 5.00` | configured |

## Requested versus effective

| key | requested | effective | narrowed by |
| --- | --- | --- | --- |
| `security.maxExposure` | `account` | `scoped` | the Reprove boundary for hosted placement, which never puts an account credential in a Sandbox |
