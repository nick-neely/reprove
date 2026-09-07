# `@reprove/protocol`

The versioned Reprove wire contract and nothing else. Zod schemas are authoritative; TypeScript types are inferred from them. It depends on `zod` and nothing more, and **Adapters may not depend on it**.

## Support tier

**Published infrastructure with a supported wire contract** ([ADR 0010](../../docs/adr/0010-package-graph-and-open-core-boundary.md)).

The _wire contract_ under `/v1` is compatibility-governed by [ADR 0006](../../docs/adr/0006-worker-protocol.md) and cannot be called unstable while a four-month-old official Worker depends on it. The _package API_ is not a supported general-purpose SDK - importing a helper from it earns no long-term API promise. The wire is a contract; the library is not.

Version families are subpath exports, not a growing union: import `@reprove/protocol/v1`. There is deliberately no `.` export.

Protocol v1 exports the shared Zod schemas and inferred TypeScript types for the
three payloads crossing the Worker boundary: `RunSpec`, `Result` and `Refusal`.
`protocolSchemas` groups exactly those payload schemas for consumers that need
the whole boundary. Nested schemas are exported for composition, but Adapter
output is intentionally absent because it stays inside the Worker core.

`claimSchemas` is the scheduling exchange - `ClaimRequest` and `ClaimGrant` -
and it sits beside `protocolSchemas` rather than inside it, because that
constant is the three payloads a Run's *content* crosses on and ADR 0006 says a
hosted Worker never exercises scheduling at all. Two details of the pair are
decisions rather than shape. A request's `protocolVersion` is a plain positive
integer and **not** `z.literal(protocolVersion)`, because ADR 0006 requires a
Worker below the served window to receive a structured `upgrade_required` naming
the minimum: a literal would turn that Worker's honest self-description into a
malformed request. A grant's is the literal, because a grant is this control
plane speaking. And the grant carries `executionToken` and `executionExpiresAt`
beside the `RunSpec` rather than inside it
([ADR 0015](../../docs/adr/0015-execution-ownership-and-worker-liveness.md)):
the spec is fixed at Run creation, and execution ownership is created by the
claim, so a Run claimed twice would have one spec and two executions.

`submissionSchemas` is the other half of that exchange, and it sits outside
`protocolSchemas` for the same reason. A submission is an envelope: the
`executionToken` the claim handed back, an optional `idempotencyKey`, a plain
integer `protocolVersion`, and the `Result` itself left **unparsed**. That last
part is the decision. `resultSchema` pins `protocolVersion` to this family with a
literal, so parsing the Result as part of the envelope would report a Worker
outside the served window as malformed rather than as `upgrade_required`; the
control plane therefore reads the envelope, checks the window, and runs
`resultSchema` afterwards. The key is optional and enforces nothing:
[ADR 0006](../../docs/adr/0006-worker-protocol.md) makes it "a convenience for
network retry" and says in the same sentence that it "must not" be what enforces
at most one accepted terminal Result.
