<!-- name: Reprove config -->
<!-- external_id: reprove.config.c1d7e402-88a6-4f31-b05c-7a2e9d641f30 -->
<!-- status: completed conclusion: success -->
<!-- title: Valid: 10 keys, 1 narrowed -->

## summary

**`.reprove.yml` would load.** This reports what would apply if merged, and is never applied to this pull request.

**`security.maxExposure`:** requested `account`, effective `scoped` (Reprove boundary).

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
| `security.maxExposure` | `account` | `scoped` | Reprove boundary |

<sub>`external_id: reprove.config.c1d7e402-88a6-4f31-b05c-7a2e9d641f30`</sub>
