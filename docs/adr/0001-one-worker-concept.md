# One Worker concept for both hosted and self-hosted execution

The PRD carried two abstractions for where a review executes: `ReviewExecutor`
(`HostedExecutor` / `SelfHostedExecutor`) in §18, and a worker protocol in §34. We are
collapsing them into a single concept, the **Worker**: the process that executes a Run and
returns its Result. Hosted and self-hosted are not two kinds of thing, only two answers to
who operates the Worker - Reprove operates hosted Workers and provisions them per Run inside
a Vercel Sandbox, while users operate self-hosted Workers, which are long-lived and register
their capabilities and health.

## Considered options

Keeping `ReviewExecutor` as a control-plane dispatch seam alongside Worker was defensible:
the two paths differ in real ways, since a hosted Worker has no registration, no heartbeat
and no advertised capabilities. We rejected it because that difference is about lifetime and
registration, not about being a different kind of participant, and because two executors mean
two implementations that drift - with the self-hosted path, the one that carries the harder
security requirements, drifting into second-class status.

## Consequences

- The hosted path runs the same Worker implementation as the self-hosted path, inside a
  Sandbox that Reprove provisions. This makes [#6](https://github.com/nick-neely/reprove/issues/6)'s
  single callback contract a structural property rather than a convention two code paths agree to honour.

  > **Amended by [ADR 0006](0006-worker-protocol.md).** "Inside a Sandbox" is wrong: ADR 0004 puts
  > the Worker outside the Sandbox and ADR 0005 puts the Adapter and Result validation outside it
  > too, so a hosted Worker inside one would co-locate the Adapter, the reconciliation step and the
  > GitHub token with repository code. The correct shape is **one Worker core with two execution
  > lifecycles** - a long-lived daemon self-hosted, Vercel Workflow steps hosted - which preserves
  > this ADR's substance: one core, so the self-hosted path cannot drift into second-class status.
  > What the two share is the Result and progress contract and the acceptance code path, not a
  > mandatory HTTP hop.
- `ReviewExecutor` is deleted from the vocabulary; "where it runs" is carried by the Worker's
  operator, expressed as `worker: hosted | self-hosted`.
- A hosted Worker is not a persisted entity. Only self-hosted Workers register, so the Worker
  record and the Worker protocol are not the same surface, and
  [#12](https://github.com/nick-neely/reprove/issues/12) has to say which parts of the protocol
  the hosted path exercises.
