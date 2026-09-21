<!-- apps/control-plane/src/app/api/webhook/route.ts:57-57 -->

`medium` · `static` **The webhook body is read before the signature is checked**

`ingest` receives the raw body and the delivery id, and the signature header is never read on this path. Reasoned from the call graph only: no request was executed against a running app, because the stack would not start (see the recorded Limitation).
