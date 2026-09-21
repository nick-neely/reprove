<!-- apps/control-plane/src/app/api/webhook/route.ts:57-57 -->

**[3] The webhook body is read before the signature is checked**

| | |
| --- | --- |
| severity | 🟨 `medium` |
| verification | `static` |
| location | `apps/control-plane/src/app/api/webhook/route.ts:57` |
| disposition | `inline_comment` |
| reconciliation | `new` |

`ingest` receives the raw body and the delivery id, and the signature header is never read on this path. Reasoned from the call graph only: no request was executed against a running app, because the stack would not start (see the recorded Limitation).

_No Evidence. This claim was reasoned, not executed._
