<!-- name: Reprove -->
<!-- external_id: reprove.refusal.8f2a61d0-4c8b-49e3-a71f-05b3d9e8c247 -->
<!-- status: completed conclusion: failure -->
<!-- title: Refused before any Run was created: config_unsupported -->

## summary

**Refused before any Run was created: config_unsupported.**

`review.strategy` asks for something Reprove does not have. Required: review.strategy is one of: standard. Found: review.strategy: adversarial.

**Next:** Fix `review.strategy` (line 12 of `.reprove.yml`) on `1a2b3c4`, the base of this pull request, then re-run this Check.

**No Review published.** There is no Run, so there is nothing to publish a Review from.

## text

## Refusal

| | |
| --- | --- |
| reason | `config_unsupported` |
| key | `review.strategy` (line 12) |
| required | review.strategy is one of: standard |
| found | review.strategy: adversarial |
| read from | `1a2b3c4`, the base of this pull request |

<sub>`external_id: reprove.refusal.8f2a61d0-4c8b-49e3-a71f-05b3d9e8c247`</sub>
