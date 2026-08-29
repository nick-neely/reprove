# Long-running review jobs on Vercel: Queue, Workflow, or neither?

Research for [#6](https://github.com/nick-neely/reprove/issues/6) (child of [#1](https://github.com/nick-neely/reprove/issues/1)).
Research date: **2026-08-29**. All Vercel numbers were read from `vercel.com/docs` on that date.

Every claim below is tagged **VERIFIED** (with the URL it came from) or **INFERRED** (reasoning
from verified facts, not itself documented). Anything I could not confirm is marked **UNVERIFIED**
rather than guessed at.

---

## TL;DR

**Recommendation: orchestrate with Vercel Workflows, not Vercel Queues directly. Keep every step
short and let the Sandbox outlive the step that created it.**

- A review job is 5-30 minutes. No Vercel Function can span that reliably: the GA ceiling on Pro is
  **800s (13.3 min)**, and 1800s (30 min) is **beta**. Blocking one function for the whole review is
  therefore not viable as a primary design.
- **Vercel Workflows is GA** and has **no maximum run duration and no maximum sleep duration**. Its
  steps are ordinary Functions and inherit the Function ceiling, so the job must be decomposed - but
  the *run* can last as long as it needs.
- **A Vercel Sandbox outlives the function that created it.** It runs until its own timeout expires
  or you stop it, and any later invocation can reattach with `Sandbox.get({ sandboxId })`. This is
  the load-bearing fact that makes the whole pattern work.
- Completion comes back either by **short polling steps** (workflow does `sleep` then a cheap
  status-check step) or by **`createWebhook()`**, which mints a public URL the job POSTs to when it
  finishes. The webhook path is also the right protocol for the self-hosted worker.
- **Vercel Queues is still public beta** (since 2026-02-27, trigger type literally named
  `queue/v2beta`). It works, but it is the lower-level primitive *underneath* Workflows. Using it
  directly buys nothing here and costs the resumability we actually need.
- **Cost is not the blocker.** A 20-minute, 4-vCPU review costs roughly **$0.07-0.08** in Vercel
  infrastructure on Pro. LLM tokens will dominate unit economics by one to two orders of magnitude.

The settled choice of "Vercel Queue" in the map's stack list should be **amended to Vercel
Workflows** (which is built on Queues, so the vendor story is unchanged).

---

## 1. Vercel Queue: what it actually is today

**Status: public beta.** **VERIFIED** - announced "Vercel Queues now in public beta" on
**2026-02-27**, available to all teams.
<https://vercel.com/changelog/vercel-queues-now-in-public-beta>
The consumer trigger type in `vercel.json` is `queue/v2beta`, which is beta naming in the config
surface itself. **VERIFIED** <https://vercel.com/docs/queues/concepts>

It is not a work queue in the SQS sense; it is a **durable append-only log with consumer groups** -
closer to Kafka in shape. Producers publish to a *topic*; each *consumer group* tracks its own
position and gets its own copy of every message. **VERIFIED**
<https://vercel.com/docs/queues/concepts>

### Delivery semantics

- **At-least-once.** "Every accepted message is delivered to each consumer group at least one time."
  Consumers must be idempotent. **VERIFIED** <https://vercel.com/docs/queues/concepts>
- **Durability:** every message is synchronously written to **three separate availability zones**
  before `publish` returns. **VERIFIED** (same URL)
- **Ordering: approximate write order only.** No FIFO guarantee, even with a single consumer at max
  concurrency 1. Retried messages are deliberately deprioritized below new ones. **VERIFIED** (same URL)
- **Idempotency keys** are supported on publish; the dedupe window is the message's full TTL.
  **VERIFIED** (same URL)

### Limits (the table that matters)

**VERIFIED** <https://vercel.com/docs/queues/pricing>

| Resource | Min | Max | Default |
| --- | --- | --- | --- |
| Message retention (TTL) | 60 seconds | 7 days | 24 hours |
| Delay before visible | 0 seconds | 7 days (capped at TTL) | 0 seconds |
| **Visibility timeout** | 0 seconds | **60 minutes** | **60 seconds** |
| Messages per receive | 1 | 10 | 1 |
| Max concurrency per consumer group | 1 | Unlimited | Unlimited |
| Max message size | - | 100 MB | - |
| Topics per project | - | Unlimited | - |
| Consumer groups per topic | - | Unlimited | - |

### Visibility timeout and maximum processing duration

This is the crux of sub-question 1, and the answer has two layers.

- The **queue** tolerates a 60-minute lease. Max visibility timeout is 60 minutes, and the JS SDK
  **auto-extends the lease while your handler is still running**, plus there is an explicit
  `ExtendLease` API. **VERIFIED** <https://vercel.com/docs/queues/concepts>,
  <https://vercel.com/docs/queues/pricing>
- The **consumer** does not. In push mode the consumer is an ordinary Vercel Function on fluid
  compute, so it dies at the Function ceiling - 800s GA / 1800s beta on Pro (see §3). When it dies
  mid-message, "the message automatically returns to the queue and gets delivered to the next
  available consumer." **VERIFIED** <https://vercel.com/docs/queues/concepts>

**INFERRED:** so the effective maximum message processing duration for a *push-mode on-Vercel
consumer* is the Function max duration, not the 60-minute visibility timeout. A naive "consume the
message, block on the sandbox for 25 minutes" design does not fail loudly - it fails by timing out
the function, returning the message to the queue, and **re-running the review from scratch**, over
and over, until the message TTL expires. That is the specific failure mode to design against.

### Concurrency control

Push mode supports **max concurrency per consumer group**: a cap on in-flight messages for that
group, with delivery held back when the cap is hit. **VERIFIED**
<https://vercel.com/docs/queues/concepts>
Note the pricing wrinkle: "push deliveries with max concurrency are billed at 2x units for that
operation." **VERIFIED** <https://vercel.com/docs/queues/pricing>

### Retries and dead-letter handling

- Retries run **until the message expires**. For the first **32 delivery attempts** Vercel honors
  your configured retry delay; after 32 attempts it **forces exponential backoff**. **VERIFIED**
  <https://vercel.com/docs/queues/concepts>
- **There is no built-in dead-letter queue.** Vercel's documented answer is application-level: use
  the SDK's `retry` callback, inspect `metadata.deliveryCount`, and `acknowledge: true` a poisoned
  message to stop retrying it. **VERIFIED** (same URL)

  ```ts
  export const POST = handleCallback(
    async (message, metadata) => { await fulfillOrder(message); },
    {
      retry: (error, metadata) => {
        if (metadata.deliveryCount > 10) return { acknowledge: true };
        return { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 5) };
      },
    },
  );
  ```

  **INFERRED:** for Reprove this means poison-message handling is *our* code and *our* schema - a
  `review_runs` row needs an attempt counter and a terminal `failed` state, because the platform
  will not park a bad job anywhere for us.

### Pricing

**VERIFIED** <https://vercel.com/docs/queues/pricing>

- Billed **per API operation**, five operation types (Send, Receive, Delete, Visibility change,
  Notify), **$0.60 per 1M operations**, regionally priced.
- Messages metered in **4 KiB chunks** - a 12 KiB message counts as three operations.
- Sends with an idempotency key and push deliveries with max concurrency bill at **2x**.
- Functions invoked in push mode are billed separately at normal compute rates.

**INFERRED:** at ~$0.60/1M operations and maybe a few dozen operations per review, queue operations
are rounding error - on the order of $0.00005 per review. Queue pricing is not a decision input.

### Deployment partitioning - a real gotcha

"On Vercel, topics are **partitioned by deployment ID** by default. In push mode, Vercel delivers
messages back to the same deployment that published them." **VERIFIED**
<https://vercel.com/docs/queues/concepts>

**INFERRED:** this is good for schema safety but means a message enqueued by deployment A is
consumed by deployment A's code. For a review that may be enqueued minutes before it runs, and for a
control plane that deploys frequently, this is a behavior to be deliberate about rather than
surprised by. Workflows has the equivalent property as **Skew Protection**: "Workflows keep running
on the deployment they were created on." **VERIFIED** <https://vercel.com/docs/workflows/concepts>

---

## 2. Vercel Workflow: yes, it exists, and it is GA

**It exists as a distinct product and it is generally available.** **VERIFIED** - Vercel Workflows
went GA on **2026-04-16**, after a beta that began in October 2025.
<https://vercel.com/blog/a-new-programming-model-for-durable-execution>

Two things share the name and it is worth keeping them apart:

- **Workflow Development Kit / Workflow SDK** - the open-source TypeScript framework (`npm i
  workflow`), documented at <https://workflow-sdk.dev>. Portable: it runs against pluggable "Worlds"
  (event log + compute + queue), including a **Postgres reference implementation for self-hosting**
  and community adapters for MongoDB, Redis, Turso, and Cloudflare. **VERIFIED**
  <https://vercel.com/blog/a-new-programming-model-for-durable-execution>
- **Vercel Workflows** - the managed platform. "**Vercel Functions** execute your workflow and step
  code. **Vercel Queues** enqueue and execute those routes with reliability. **Managed persistence**
  stores all state and event logs." **VERIFIED** <https://vercel.com/docs/workflows>

Vercel's own docs state the relationship plainly: "Vercel Queues is the lower-level primitive that
powers Vercel Workflows." **VERIFIED** <https://vercel.com/docs/queues>

### The programming model

Two directives. `'use workflow'` marks a durable, resumable orchestrator function; `'use step'`
marks a unit of work that gets automatic retries. Each step compiles into an isolated API route, and
**"while the step executes, the workflow suspends without consuming resources."** `sleep()` pauses
without holding compute. `createHook()` / `createWebhook()` suspend until an external system sends
data back. **VERIFIED** <https://vercel.com/docs/workflows/concepts>

### Limits

**VERIFIED** <https://vercel.com/docs/workflows/pricing>

| Limit | Value |
| --- | --- |
| **Maximum run duration** | **No limit** |
| **Maximum `sleep` duration** | **No limit** |
| **Max runtime of individual step** | Vercel Functions limits (see §3) |
| Events per run | 25,000 |
| Steps per run | 10,000 |
| Event creations per run per second | 200 |
| Hook creations per second | 200 |
| Run creations per second | 1,000 |
| Max payload size | 50 MB |
| Max total entity storage per run | 2 GB |
| Max workflow replay duration | 240s |
| Max stream chunk size | 10 MB |
| Hook token size | 255 bytes |

Run-state retention after completion: **Hobby 1 day, Pro 7 days, Enterprise 30 days**, not
configurable by default. **VERIFIED** (same URL)

Performance note from the docs: "Runs that exceed 2,000 events or 1 GB of total entity storage have
slower replay times ... we recommend creating child workflows to break long-running workflows into
smaller pieces." **VERIFIED** (same URL)

### Pricing

**VERIFIED** <https://vercel.com/docs/workflows/pricing>

| Resource | Hobby included | On-demand rate |
| --- | --- | --- |
| Workflow Events | 50,000/month | **$0.02 per 1K events** |
| Workflow Data Written | 1 GB | **$0.50 per GB** |
| Workflow Data Retained | not available on Hobby | **$0.50 per GB-month** |

A normal step produces three events (`step_created`, `step_started`, `step_completed`), plus a
`step_retrying` event per retry. Functions invoked by Workflows bill at normal compute rates, and
Queues usage underneath bills at standard Queues rates. **VERIFIED** (same URL)

**INFERRED cost per review:** a review workflow with, say, 15 steps plus 40 polling iterations lands
around 200-400 events. At $0.02/1K that is **$0.004-$0.008 per review** - about 5-10% of the sandbox
cost, and still negligible against LLM tokens. If we choose a *polling* completion strategy, though,
event count scales with poll frequency, and a webhook-based completion strategy avoids that
entirely. This is the one place where the polling-vs-webhook choice has a (small) cost consequence.

### Is Workflow a better fit than Queue here?

**Yes, decisively, and Vercel says so themselves.** From the Functions duration docs: "For workloads
that require unlimited execution time, use **Vercel Workflows**, which allow your code to pause,
resume, and maintain state for minutes to months without duration limits." **VERIFIED**
<https://vercel.com/docs/functions/configuring-functions/duration>

And from their own background-jobs guide: "For stateful, multi-step background jobs in Next.js, use
Workflows. You get retries, durable state, and observability without writing queue or
state-management code." They reserve raw Queues for cases where "performance is critical" or you
need "fine-grained control over consumer groups, concurrency, or message-level delivery behavior
that the Workflow abstraction doesn't expose." **VERIFIED**
<https://vercel.com/kb/guide/how-to-run-background-jobs-in-nextjs-on-vercel>

A review job is exactly the shape Workflows is for: multi-step, minutes-long, resumable, with
per-step retries and a durable record of what already succeeded. Their own comparison table puts it
this way - Queues is for "event delivery, fan-out consumers, and routing control"; Workflows is for
"stateful, multi-step application logic." **VERIFIED** <https://vercel.com/docs/queues/concepts>

---

## 3. Function duration ceilings

**Fluid compute is the default for all new projects.** **VERIFIED**
<https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing>

### Fluid compute (Node.js, Bun, Python)

**VERIFIED** <https://vercel.com/docs/functions/limitations>,
<https://vercel.com/docs/functions/configuring-functions/duration>

| | Default | Maximum | Extended maximum |
| --- | --- | --- | --- |
| Hobby | 300s (5 min) | 300s (5 min) | - |
| **Pro** | 300s (5 min) | **800s** | **1800s (30 min)** |
| Enterprise | 300s (5 min) | 800s | 1800s (30 min) |

- The **800s maximum is GA** for Pro and Enterprise. **VERIFIED**
- The **1800s extended maximum is beta.** During the beta, values above 800s must be configured
  **per function** in code or `vercel.json` - project-level defaults above 800s are not supported.
  Supported runtimes are `nodejs20.x`, `nodejs22.x`, `nodejs24.x`, Bun `1.x`/`1.4.x`, and
  `python3.12`/`3.13`/`3.14`. **Secure Compute and Static IPs do not support durations above 800s
  during the beta.** **VERIFIED**
  <https://vercel.com/docs/functions/configuring-functions/duration>
- **Workflow steps** specifically got extended durations on **2026-07-24**: up to 1800s, up from
  800s, gated behind setting `VERCEL_ENABLE_WORKFLOW_EXTENDED_MAX_DURATION=1` as a project
  environment variable and redeploying. Requires fluid compute; not available on Hobby. **VERIFIED**
  <https://vercel.com/changelog/workflow-steps-now-support-extended-function-durations>
- Edge runtime is separate and irrelevant here: must start responding within 25s, can stream up to
  300s. **VERIFIED** <https://vercel.com/docs/functions/limitations>

Memory/vCPU: Hobby 2 GB / 1 vCPU max; **Pro and Enterprise 4 GB / 2 vCPU max**, 2 GB / 1 vCPU
default. Request and response body cap **4.5 MB**. **VERIFIED**
<https://vercel.com/docs/functions/limitations>

### Non-fluid (legacy) compute

**UNVERIFIED as a number.** The legacy pricing page describes the legacy *billing* model (wall-clock
GB-hours) but does not publish a separate duration table; the current duration tables on both
`/docs/functions/limitations` and `/docs/functions/configuring-functions/duration` are stated for
fluid compute. The only legacy-page duration reference is Enterprise "increased maximum duration up
to 800 seconds." **VERIFIED** <https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing>

**INFERRED:** this is not worth chasing. Fluid compute is the default for new projects, is required
for extended durations, for large functions, and for Workflow steps' extended durations, and bills
strictly better for I/O-bound work. Reprove's control plane should be on fluid compute
unconditionally, and the legacy ceilings are then irrelevant.

### Does a function awaiting a 20-minute sandbox stay alive and billed?

**Alive: only if it fits under the ceiling, and 20 minutes does not fit under the GA ceiling.**
1200s > 800s. It requires opting into the 1800s beta. **VERIFIED** (duration docs above)

**Billed: yes for memory, no for CPU.** The mechanism is explicit:

> "Vercel bills Active CPU only while your code is actually running. If the request is waiting on
> I/O, CPU billing pauses but memory billing continues." **VERIFIED**
> <https://vercel.com/docs/functions/usage-and-pricing>

Also: "Memory is reserved for your function even when it's waiting for I/O. Billing continues until
the last in-flight request completes." **VERIFIED** (same URL)

So a 1 GB orchestrator function idling 20 minutes on `iad1` costs
`1 GB x 0.3333 hr x $0.0106/GB-hr = $0.0035`. Cheap. **INFERRED** (arithmetic over verified rates)

**Is it a supported pattern or an abuse of one?** **INFERRED, but with strong documented signal:**
it is not abuse - fluid compute is explicitly designed so a function can sit on I/O without burning
CPU billing, and optimized concurrency lets one instance serve many such waits. But Vercel just as
explicitly routes this workload elsewhere: "For workloads that require unlimited execution time, use
Vercel Workflows." **VERIFIED** <https://vercel.com/docs/functions/configuring-functions/duration>

The real objection is not billing, it is **fragility**. A blocking function gives you a single
un-checkpointed 20-minute unit of work, whose failure at minute 19 discards everything, whose
lifetime is capped by a beta flag, and which cannot survive a deploy. Betting hosted mode's core
loop on a beta duration limit that is 33% larger than the job's median duration is a bad trade when
a GA product exists that removes the ceiling entirely.

---

## 4. The orchestration pattern

### Can a Sandbox outlive the function that created it?

**Yes. VERIFIED, and this is the key fact.**

> "When you create a sandbox, it continues running until it times out or you explicitly stop it."
> <https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox>

The sandbox's lifetime is governed by **its own `timeout`**, not by the caller's:

- Default sandbox timeout: **5 minutes**, set via the `timeout` option on `Sandbox.create()`,
  extendable at runtime with `sandbox.extendTimeout()` up to the plan maximum. **VERIFIED**
  <https://vercel.com/docs/sandbox/pricing>, <https://vercel.com/docs/sandbox/working-with-sandbox>
- Max **session** duration: **Hobby 45 minutes, Pro/Enterprise 24 hours**. **VERIFIED**
  <https://vercel.com/docs/sandbox/pricing>
- Critically: "The maximum duration applies to a single **session**, not to the sandbox itself. The
  limit resets every time a sandbox stops and resumes, so the total lifetime of a persistent sandbox
  is effectively unbounded." **VERIFIED** (same URL)

Sandbox is **GA since 2026-01-30**. **VERIFIED**
<https://vercel.com/changelog/vercel-sandboxes-ga>,
<https://vercel.com/blog/vercel-sandbox-is-now-generally-available>

### Reattaching from a later invocation

**VERIFIED** <https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox>,
<https://vercel.com/docs/sandbox/sdk-reference>

```ts
// invocation 1
const sandbox = await Sandbox.create({ name: runId, timeout: 30 * 60 * 1000 });

// invocation 2, minutes later, different function, different instance
const sandbox = await Sandbox.get({ sandboxId });
// or, keyed by a stable name:
const sandbox = await Sandbox.getOrCreate({ name: runId, onCreate, onResume });
```

Sandboxes are **persistent by default**: stopping one snapshots its filesystem and the next resume
restores it. Pass `persistent: false` for genuinely one-shot work. **VERIFIED**
<https://vercel.com/docs/sandbox/working-with-sandbox>

And work can be launched *detached*, so the caller does not have to block:

```ts
const cmd = await sandbox.runCommand({ cmd: 'reprove-review', args: [...], detached: true });
cmd.cmdId;            // persist this
await cmd.wait();     // or wait later
for await (const log of cmd.logs()) { /* stream */ }
```

**VERIFIED** <https://vercel.com/docs/sandbox/sdk-reference>

**UNVERIFIED:** whether a detached command can be re-looked-up by `cmdId` from a *different* process
after reattaching with `Sandbox.get()`. The reconnect guide covers reattaching to the sandbox but
does not document command lookup by id. Worth a 30-minute spike before committing to a design that
depends on it; the workaround (have the in-sandbox process write a status/result file, and poll that
file - or better, call back, see below) does not depend on it at all.

### Does Vercel document a pattern for this?

Yes, two of them, and they differ - which is itself informative.

**Pattern A - blocking step, from "How to build a durable AI code agent on Vercel":** the step
creates a sandbox, runs commands synchronously, collects stdout, and cleans up in a `finally` block.
The sandbox does *not* outlive the step. Vercel's own guidance there: "Use a finally block to call
`sandbox.stop()`. Sandboxes have a default 5-minute timeout, but stopping them explicitly keeps costs
down and avoids hitting concurrency limits." **VERIFIED**
<https://vercel.com/kb/guide/how-to-build-a-durable-ai-code-agent-on-vercel>

**Pattern B - sandbox spans the run, from "How to run a multi-step research agent on Vercel":**
`Sandbox.getOrCreate` is keyed to the run's identifier so "every analysis call in a run reuses one
sandbox," and "a retried step reattaches instead of provisioning another." The sandbox persists for
the whole workflow. Completion is surfaced via workflow run status (`getRun` by run id, independent
of the originating request) and via an artifact landing in Blob. `start()` "enqueues the run and
returns immediately while the agent works." **VERIFIED**
<https://vercel.com/kb/guide/how-to-run-a-multi-step-research-agent-on-vercel>

Pattern A is fine when the work fits comfortably inside one step. Pattern B is the one that matches
Reprove: a long-lived sandbox, many short steps against it, the workflow as the durable spine.

### How completion gets reported

Three mechanisms, all documented; they are not mutually exclusive.

1. **Polling from the workflow.** `await sleep('30s')` then a short step that reattaches and checks
   status. Sleep consumes no compute and has no max duration. **VERIFIED**
   <https://vercel.com/docs/workflows/concepts>, <https://vercel.com/docs/workflows/pricing>

2. **Webhook callback into the control plane - `createWebhook()`.** The workflow mints a public,
   token-authorized URL and suspends until something POSTs to it:

   ```ts
   using webhook = createWebhook();
   console.log('Send HTTP requests to:', webhook.url);
   const request = await webhook;   // suspends; no compute held
   ```

   The endpoint is wired at `/.well-known/workflow/v1/webhook/:token`; the token is the sole
   authorization. Default response is `202 Accepted`; `{ respondWith: 'manual' }` lets you control
   the response. **VERIFIED** <https://workflow-sdk.dev/docs/foundations/hooks>,
   <https://workflow-sdk.dev/docs/api-reference/workflow/create-webhook>

3. **Typed hooks - `createHook()` / `defineHook()` + `resumeHook(token, payload)`** from any route
   in your own app, with a zod schema on the payload. **VERIFIED**
   <https://workflow-sdk.dev/docs/foundations/hooks>, <https://vercel.com/docs/workflows/concepts>

**UNVERIFIED:** whether a hook or webhook has a maximum wait duration. Neither the hooks guide nor
the `createWebhook` API reference documents one, and the run-limits table says maximum run duration
is "No limit." **INFERRED:** hooks inherit the run's unbounded lifetime. Do not rely on this without
a bounded watchdog anyway (see below) - a hook that is never called is a run that never ends.

### Recommended shape for Reprove

**INFERRED** (design synthesis over the verified facts above):

```
POST /api/github/webhook          <- thin, returns fast
  -> start(reviewWorkflow, [{ installationId, repo, prNumber, sha }])

reviewWorkflow  ('use workflow')
  step  createRun()                 -> write review_runs row (Neon), status=queued
  step  provisionSandbox()          -> Sandbox.create({ name: runId,
                                          timeout: 45 * 60 * 1000,
                                          networkPolicy/allowed domains per §36 policy })
                                       clone + install; return sandboxId
  using webhook = createWebhook()   -> URL passed into the sandbox as REPROVE_CALLBACK_URL
  step  launchReview()              -> Sandbox.get({ sandboxId }); runCommand({ detached: true })
                                       the in-sandbox harness POSTs findings to the callback URL
  race: await webhook  ||  watchdog loop of sleep('60s') + short pollStatus() step
  step  persistFindings()           -> write findings, post GitHub review via Octokit
  step  teardown()                  -> sandbox.stop() (finally-equivalent)
```

Why this shape:

- Every step is seconds to low minutes, so the 800s GA Function ceiling is never a constraint and
  the 1800s beta is never a dependency. **INFERRED**
- The 20-minute wait is spent in `webhook`/`sleep`, which hold no compute and have no duration
  limit. **VERIFIED** that sleep holds no compute and has no max
  (<https://vercel.com/docs/workflows/concepts>, <https://vercel.com/docs/workflows/pricing>)
- A crash or a deploy mid-review resumes from the last completed step rather than restarting the
  review. **VERIFIED** (resumability + skew protection, <https://vercel.com/docs/workflows>)
- The callback is the *primary* completion path (cheap, immediate, no event inflation); the sleep
  loop is a **watchdog**, not the main mechanism, because a sandbox that dies never calls back. Both
  are needed. **INFERRED**

**UNVERIFIED:** the exact SDK idiom for racing a webhook against a timeout inside a workflow (i.e.
`Promise.race` over `await webhook` and a `sleep`) and whether it stays deterministic under replay.
This is the one API detail to confirm with a prototype before building on it. The fallback - poll
only, no webhook - is fully documented and definitely works, at the cost of more workflow events.

---

## 5. Cost: per-review unit economics

All rates below are **VERIFIED** for the default `iad1` region on the **Pro** plan.
Sandbox: <https://vercel.com/docs/sandbox/pricing>. Functions:
<https://vercel.com/docs/functions/usage-and-pricing>. Workflows:
<https://vercel.com/docs/workflows/pricing>. Queues: <https://vercel.com/docs/queues/pricing>.

| Dimension | Hobby included | Pro rate (iad1) |
| --- | --- | --- |
| Sandbox Active CPU | 5 hours/month | **$0.128/hour** |
| Sandbox Provisioned Memory | 420 GB-hours/month | **$0.0212/GB-hour** |
| Sandbox Creations | 5,000/month | **$0.60/1M** |
| Sandbox Data Transfer (egress) | 20 GB/month | **$0.15/GB** |
| Snapshot Storage | 15 GB lifetime | $0.08/GB-month |
| Function Active CPU | 4 hours/month | **$0.128/hour** |
| Function Provisioned Memory | 360 GB-hours/month | **$0.0106/GB-hour** |
| Function Invocations | 1M/month | **$0.60/1M** |

Two definitional facts that dominate the arithmetic, both **VERIFIED**
(<https://vercel.com/docs/sandbox/pricing>):

- **Active CPU excludes I/O wait.** "Time spent waiting for I/O (such as network requests, database
  queries, or AI model calls) does not count toward Active CPU." For an agent-driven review, most
  wall-clock time is LLM latency and is therefore not CPU-billed.
- **Inbound data is free.** "Data your sandbox downloads from the internet, such as packages, Git
  repositories, artifacts, and datasets, is free." So `git clone` and `npm install` cost nothing in
  transfer. Only data the sandbox *sends*, and traffic on exposed ports, is billable at $0.15/GB.
  (Corroborated by <https://vercel.com/changelog/data-downloaded-by-vercel-sandbox-is-now-free>.)

### One 20-minute review, 4 vCPU / 8 GB (2 GB per vCPU, **VERIFIED**)

**INFERRED** - arithmetic over verified rates.

```
Provisioned Memory (full wall-clock, regardless of CPU busy):
  8 GB x (20/60) hr x $0.0212/GB-hr                = $0.05653

Active CPU (only the CPU-busy fraction):
  30% busy = 6.0 min = 0.1000 hr x $0.128/hr       = $0.01280
  40% busy = 8.0 min = 0.1333 hr x $0.128/hr       = $0.01707
  50% busy = 10.0 min = 0.1667 hr x $0.128/hr      = $0.02133

Sandbox creation: 1 x $0.60/1M                      = $0.0000006  (negligible)
Ingress (clone + npm install)                       = $0          (free)
Egress (findings payload, few hundred KB)           < $0.0001     (negligible)

Orchestrating workflow, 1 GB instance, steps total ~60s of instance lifetime:
  1 GB x (60/3600) hr x $0.0106/GB-hr               = $0.00018
  (a *blocking* 20-min function instead would be    = $0.00353)

Workflow events, ~300 events x $0.02/1K             = $0.00600
Queue operations underneath, ~50 x $0.60/1M         = $0.00003
```

| Scenario | Sandbox memory | Sandbox CPU | Orchestration | **Total** |
| --- | --- | --- | --- | --- |
| Low (30% CPU busy) | $0.0565 | $0.0128 | $0.0062 | **~$0.076** |
| Mid (40% CPU busy) | $0.0565 | $0.0171 | $0.0062 | **~$0.080** |
| High (50% CPU busy) | $0.0565 | $0.0213 | $0.0062 | **~$0.084** |

Cross-check against Vercel's own published example: "Build and test, 30 min, 4 vCPUs, 8 GB" is
listed at **~$0.34** total assuming **100% CPU utilization**. Our number is lower because it is
20 minutes rather than 30 and because an agent-driven review is nowhere near 100% CPU-busy - it is
mostly waiting on model calls. **VERIFIED** (the $0.34 figure and the 100%-utilization caveat)
<https://vercel.com/docs/sandbox/pricing>

### What this means

**INFERRED:**

- **~$0.07-0.09 of Vercel infrastructure per review.** Hosted mode is viable on infrastructure cost.
- **Memory, not CPU, is the dominant term** - 67-74% of the total - because provisioned memory bills
  full wall-clock while CPU bills only busy time. Moving from 30% to 50% CPU-busy changes the total
  by ~11%. **The levers that matter are wall-clock duration and vCPU size, not CPU efficiency.**
  Dropping from 4 vCPU to 2 vCPU halves the memory term outright.
- **Stop the sandbox promptly.** Because memory bills to wall-clock, an abandoned sandbox left to
  hit a 45-minute timeout costs more than the review it ran. `sandbox.stop()` in a teardown step is
  a cost control, not just hygiene. Vercel says as much: "Stop sandboxes promptly: call
  `sandbox.stop()` when done rather than waiting for timeout." **VERIFIED**
  <https://vercel.com/docs/sandbox/pricing>
- **The Pro $20/month credit** covers roughly 250 reviews before on-demand billing starts.
  **VERIFIED** that the credit exists and Sandbox usage draws on it
  (<https://vercel.com/docs/sandbox/pricing>); the division is **INFERRED**.
- **LLM tokens will dominate.** A 20-minute agentic review across many turns is plausibly dollars of
  model spend against $0.08 of compute. Hosted-mode pricing is a model-cost question, not a Vercel
  question. **INFERRED.**

### Concurrency headroom

**VERIFIED** <https://vercel.com/docs/sandbox/pricing>: Pro allows **10,000 concurrent sandboxes**
(Hobby 10), with a **dynamic vCPU allocation quota** - Pro starts at 150 vCPUs/min when idle and
ramps by 500/min to a maximum of 5,000 vCPUs/min, decaying back to the starting rate after 10
minutes without creations. Control plane operations: 10,000 requests/minute on Pro.

**INFERRED:** at 4 vCPU per review, the cold-start rate limit is ~37 reviews in the first minute
after an idle period, ramping to 1,250/min. That is far beyond anything early Reprove will see, but
the *ramp* behavior is worth knowing: a sudden burst from cold (a monorepo opening 40 PRs at once)
can hit the starting quota. Queue depth in front of sandbox creation handles this naturally -
another argument for the queue/workflow layer rather than creating sandboxes directly from the
GitHub webhook handler.

---

## 6. Alternatives, if Vercel's primitives did not fit

Short version: **they all converge on the same architecture Vercel Workflows already gives us** -
decompose the job into short steps, chain them durably, and pause without holding compute. None of
them removes the Vercel Function ceiling; they just manage it for you. Since Vercel Workflows is GA,
first-party, and adds zero vendors, the alternatives are contingency options rather than live
contenders.

One correction worth recording, because it appears in third-party docs: **Inngest's own
provider-limits page states Vercel's function cap as 900s / 15 minutes.** That is stale - Vercel's
current GA cap is **800s** with a **1800s** beta. **VERIFIED** for Vercel's numbers
(<https://vercel.com/docs/functions/configuring-functions/duration>). Treat any non-Vercel page
quoting Vercel's limits as out of date.

### Inngest

**VERIFIED** <https://www.inngest.com/pricing>, <https://www.inngest.com/docs/usage-limits/inngest>,
<https://www.inngest.com/docs/reference/functions/step-wait-for-event>,
<https://www.inngest.com/docs/deploy/vercel>

- Max single `step.run`: **2 hours** on paper, but Inngest invokes your code over HTTP, so the real
  per-step cap is **your** Vercel Function ceiling.
- Max run lifetime: Free 30 days, Pro 366 days. `step.waitForEvent` durably pauses with a timeout up
  to **1 year** (7 days on Free) - the direct analogue of Vercel's `createWebhook`/`createHook`.
- Retries: **4 retries + initial attempt**, per step, configurable.
- Concurrency: `concurrency: { limit, key, scope }` per function; Hobby 5 concurrent steps, Pro 100+
  (+25 per $25/mo).
- Pricing: Hobby $0 (50K executions/mo); **Pro from $99/mo** with 1M executions included. An
  "execution" counts the run plus each step in it.
- Preserves the Vercel story: **yes.** Official Vercel Marketplace integration, `serve()` at
  `/api/inngest`, no worker to host.

**INFERRED assessment:** the closest functional match to Vercel Workflows, and the strongest
fallback if Workflows disappoints. The cost shape is different in a way that matters: Inngest has a
**$99/mo floor** on Pro, whereas Vercel Workflows is pure usage ($0.02/1K events) with no floor. At
Reprove's early volumes that floor is the entire infrastructure bill several times over.

### Trigger.dev

**VERIFIED** <https://trigger.dev/pricing>, <https://trigger.dev/docs/wait>,
<https://trigger.dev/docs/guides/frameworks/nextjs>, <https://trigger.dev/docs/open-source-self-hosting>

- **No execution-time ceiling** - "Tasks can run for as long as you need, with no timeouts" - because
  tasks run on *their* compute, not yours. Currently **v4** ("Run Engine 2"); **v3 deploys stop
  working 2026-04-01**, so a new project is on v4.
- `wait.for()` / `wait.forToken()`: short waits hold the machine slot; longer waits are snapshotted
  and stop billing compute.
- Pricing: Free $0 ($5 credit), Hobby $10/mo, Pro $50/mo, plus **per-second metered compute by
  machine size** (Micro $0.0000169/s to Large $0.00068/s) **plus $0.000025 per run**.
- Self-hostable (Docker Compose; Kubernetes/Helm in v4), with support explicitly disclaimed.
- Preserves the Vercel story: **partially.** Your Next.js app only calls `tasks.trigger()`, but the
  tasks themselves deploy to Trigger.dev via `npx trigger.dev deploy` - a second deploy target and a
  second place code lives.

**INFERRED assessment:** the only option with genuinely unbounded single-task duration, which would
let a review run as one uninterrupted task. But it duplicates the isolation layer we already get
from Vercel Sandbox, splits the deploy story, and its per-second compute billing would stack on top
of sandbox billing. Wrong shape for Reprove.

### Upstash QStash (and Upstash Workflow)

**VERIFIED** <https://upstash.com/pricing/qstash>, <https://upstash.com/docs/qstash/features/retry>,
<https://upstash.com/docs/qstash/features/dlq>, <https://upstash.com/docs/qstash/features/flowcontrol>,
<https://upstash.com/docs/workflow/getstarted>, <https://upstash.com/pricing/workflow>

- **QStash:** at-least-once delivery. Max HTTP response duration **15 min Free / 2 h PAYG / 6 h Fixed
  1M / 12 h Fixed 10M**. Default **3 retries**, overridable, exponential backoff capped at 1 day.
  **Real dead-letter queue** with plan-based retention (3 days to 3 months) - notably better than
  Vercel Queues, which has none. Flow control: `{ key, rate, period, parallelism }`. Pricing **$1 per
  100K messages** PAYG, every delivery attempt counted.
- **Upstash Workflow** is a separate durable-execution SDK on top of QStash, where each step is its
  own QStash-delivered HTTP request into your Next.js route. Same pricing structure, $1/100K steps.
- Preserves the Vercel story: **raw QStash, no** (Vercel's function cap binds before QStash's
  callback window does). **Upstash Workflow, yes** - it runs entirely inside your existing Vercel
  app.

**INFERRED assessment:** Upstash Workflow is the cheapest credible alternative and shares a vendor
with the already-settled Upstash rate limiting. Its architecture is the same as Vercel Workflows'.
It is the fallback to reach for if we want to keep durable execution but move off Vercel-managed
persistence. QStash raw is not a candidate.

### pg-boss on Neon

**VERIFIED** <https://pgboss.io/api/jobs>, <https://github.com/timgit/pg-boss/discussions/403>,
<https://registry.npmjs.org/pg-boss>, <https://neon.com/docs/connect/connection-pooling>,
<https://neon.com/docs/introduction/scale-to-zero>

- Current version **12.28.1** (published 2026-08-28), Node >= 22.12, **ESM-only** since v12.
- `expireInSeconds` default **15 minutes**, hard max **86400s (24 hours)**. Jobs can heartbeat via
  `job.touch()` / `heartbeatSeconds` to hold the lease - a real visibility-timeout equivalent.
- Architecture is **polling workers**, with optional LISTEN/NOTIFY for latency.
- Serverless: `send`/`fetch` work with `{ noSupervisor: true }`, but the maintainer states plainly
  that the maintenance/expiration loop must still run periodically somewhere with supervision on.
- Neon caveats: the **pooled** connection string (PgBouncer transaction mode) does **not** support
  `LISTEN`/`NOTIFY`, session advisory locks, or `SET`/`PREPARE` - LISTEN/NOTIFY requires the direct
  connection. Scale-to-zero suspends after 5 minutes idle by default (disable on paid plans).
- Preserves the Vercel story: **no.** Needs a separate always-on worker process.

**INFERRED assessment:** ruled out for the hosted control plane - it reintroduces exactly the
always-on process that the Vercel deployment story is meant to avoid, and Neon's pooler restrictions
make the LISTEN/NOTIFY fast path awkward. It stays interesting for one narrow reason: it is the same
database we already run, so it is the natural substrate if we ever need a queue the **self-hosted**
control plane can use without any SaaS dependency. Note that the **Workflow SDK's own self-hosted
"World" is a Postgres reference implementation**, which covers that case more directly.
**VERIFIED** <https://vercel.com/blog/a-new-programming-model-for-durable-execution>

### Comparison

| | Durable pause/resume | Real step ceiling on Vercel | Waits on external work | DLQ | Floor cost | Vercel-only |
| --- | --- | --- | --- | --- | --- | --- |
| **Vercel Workflows** | yes | 800s GA / 1800s beta | `createWebhook` / `createHook`, no documented max | no (app-level) | $0, pure usage | **yes** |
| Vercel Queues (raw) | no | 800s GA / 1800s beta | n/a | **no** | $0, pure usage | yes |
| Inngest | yes | your Vercel cap | `waitForEvent`, up to 1 year | yes (via failure handlers) | **$99/mo** Pro | yes |
| Trigger.dev | yes | none (their compute) | `wait.forToken` | yes | $10-50/mo + metered | partial (2nd deploy target) |
| Upstash Workflow | yes | your Vercel cap | via QStash callbacks | **yes** | $0, $1/100K steps | yes |
| pg-boss + Neon | partial (job state only) | n/a (own worker) | none built in | manual | Neon compute | **no** |

---

## 7. What this means for the self-hosted worker

The map notes that this decision shapes the worker protocol. It does, and the shape falls out
cleanly.

**INFERRED** (design synthesis; the primitives cited are verified above):

The self-hosted worker is a process on the user's machine that the control plane cannot reach,
cannot poll, and cannot restart. The only viable protocol is **worker pulls, worker pushes back** -
and Vercel Workflows already has both halves as first-class primitives:

1. **Hand-off:** the worker long-polls a control-plane endpoint (or consumes a Vercel Queue in
   **poll mode**, which is explicitly designed for "consumers running outside of Vercel" and
   authenticates with standard OIDC tokens - **VERIFIED**
   <https://vercel.com/docs/queues/poll-mode>, <https://vercel.com/docs/queues/concepts>).
2. **Progress and completion:** the workflow mints a `createWebhook()` URL for the run and hands it
   to the worker along with the job. The worker POSTs progress and the final findings to that URL.
   The workflow resumes on receipt. **VERIFIED** that this URL exists and is externally addressable
   at `/.well-known/workflow/v1/webhook/:token` with the token as sole authorization
   (<https://workflow-sdk.dev/docs/foundations/hooks>).

The consequence worth flagging now, while the schema is still open: **the hosted path and the
self-hosted path should use the same callback contract.** In hosted mode the caller is a process
inside a Vercel Sandbox; in self-hosted mode it is a process on the user's laptop. If both POST the
same run-result envelope to the same run-scoped URL, there is exactly one ingest path, one schema to
version, and one set of idempotency rules - and hosted mode becomes the self-hosted worker running
in a sandbox we happen to own. That is a much better factoring than two protocols, and it is only
free if we choose it before the interfaces are written.

Two cautions:

- **The webhook token is a bearer credential.** "The token serves as sole authorization."
  **VERIFIED** (<https://workflow-sdk.dev/docs/api-reference/workflow/create-webhook>). It is
  run-scoped and short-lived, which is the right property, but it must never be logged, and the
  payload it accepts must be schema-validated (zod) and size-bounded - the workflow payload cap is
  50 MB (**VERIFIED** <https://vercel.com/docs/workflows/pricing>) but findings should be orders of
  magnitude below that, with anything large going to Blob and referenced by URL.
- **A callback-only protocol has no liveness signal.** A worker that dies never calls back. Every
  run needs a watchdog - a bounded `sleep` loop, or a deadline after which the run is marked failed.
  This is the same watchdog the hosted path needs, which is another argument for one shared
  mechanism.

---

## 8. Verdict and what it changes

**Recommended orchestration pattern:**

> GitHub webhook -> thin route -> `start(reviewWorkflow)` -> Vercel Workflow with short steps ->
> `Sandbox.create` (long timeout, detached command) -> suspend on `createWebhook()` with a `sleep`
> watchdog -> in-sandbox harness POSTs findings -> persist + post review -> `sandbox.stop()`.

**Verified ceilings this pattern lives inside:**

| | Value | Source |
| --- | --- | --- |
| Workflow run duration | **no limit** | <https://vercel.com/docs/workflows/pricing> |
| Workflow `sleep` duration | **no limit** | same |
| Steps per run / events per run | 10,000 / 25,000 | same |
| Function max duration (Pro, fluid) | **800s GA**, 1800s beta | <https://vercel.com/docs/functions/configuring-functions/duration> |
| Sandbox session duration (Pro) | **24 hours** | <https://vercel.com/docs/sandbox/pricing> |
| Sandbox max vCPU / memory (Pro) | 8 vCPU / 16 GB | same |
| Concurrent sandboxes (Pro) | 10,000 | same |
| Queue visibility timeout (max) | 60 minutes | <https://vercel.com/docs/queues/pricing> |
| Cost per 20-min, 4-vCPU review | **~$0.08** | derived, §5 |

**Changes this implies for the map's "settled" list:**

- **"Vercel Queue" should become "Vercel Workflows."** Not a reversal - Workflows *is* Queues plus
  durable state, from the same vendor, in the same deploy. But the distinction is load-bearing:
  building on raw Queues would mean hand-rolling the resumability that Workflows gives for free, and
  would leave us on a **beta** product (`queue/v2beta`) where a **GA** one exists.
- **Fluid compute is mandatory**, not incidental. It gates extended step durations, large functions,
  and the CPU-pauses-on-I/O billing that makes the economics work.
- **The worker protocol should be callback-first**, with the run-scoped webhook URL as the single
  ingest path shared by hosted and self-hosted execution.

## Open questions worth a prototype before committing

These are the **UNVERIFIED** points above, in priority order:

1. **Racing a `createWebhook()` against a `sleep` watchdog inside a workflow** - is the idiom
   supported, and does it stay deterministic under replay? This is the single API detail the
   recommended pattern rests on. Fallback (poll-only) is fully documented and definitely works.
2. **Re-looking-up a detached command by `cmdId` after `Sandbox.get()` in a later invocation.**
   Documented for reattaching to the *sandbox*, not to the *command*. Workaround: have the in-sandbox
   process write a status file, or rely on the callback.
3. **Hook/webhook maximum wait duration** - not documented anywhere I could find. The watchdog makes
   this moot in practice, but it should be measured.
4. **Real CPU-busy fraction and wall-clock duration** for an actual `@ai-sdk/harness` review on a
   representative repo. Every cost number in §5 is sensitive to wall-clock duration and sandbox size,
   and to nothing else much.

---

## Sources

Vercel primary docs (all read 2026-08-29):

- <https://vercel.com/docs/queues> · <https://vercel.com/docs/queues/concepts> · <https://vercel.com/docs/queues/pricing> · <https://vercel.com/docs/queues/poll-mode>
- <https://vercel.com/docs/workflows> · <https://vercel.com/docs/workflows/concepts> · <https://vercel.com/docs/workflows/pricing>
- <https://vercel.com/docs/functions/limitations> · <https://vercel.com/docs/functions/configuring-functions/duration> · <https://vercel.com/docs/functions/usage-and-pricing> · <https://vercel.com/docs/functions/usage-and-pricing/legacy-pricing>
- <https://vercel.com/docs/sandbox> · <https://vercel.com/docs/sandbox/pricing> · <https://vercel.com/docs/sandbox/sdk-reference> · <https://vercel.com/docs/sandbox/working-with-sandbox>
- <https://workflow-sdk.dev/docs/foundations/hooks> · <https://workflow-sdk.dev/docs/api-reference/workflow/create-webhook>

Vercel changelog and blog:

- <https://vercel.com/changelog/vercel-queues-now-in-public-beta> (2026-02-27)
- <https://vercel.com/changelog/vercel-sandboxes-ga> (2026-01-30) · <https://vercel.com/blog/vercel-sandbox-is-now-generally-available>
- <https://vercel.com/blog/a-new-programming-model-for-durable-execution> (Workflows GA, 2026-04-16)
- <https://vercel.com/changelog/workflow-steps-now-support-extended-function-durations> (2026-07-24)
- <https://vercel.com/changelog/data-downloaded-by-vercel-sandbox-is-now-free>

Vercel guides:

- <https://vercel.com/kb/guide/how-to-run-background-jobs-in-nextjs-on-vercel>
- <https://vercel.com/kb/guide/how-to-build-a-durable-ai-code-agent-on-vercel>
- <https://vercel.com/kb/guide/how-to-run-a-multi-step-research-agent-on-vercel>
- <https://vercel.com/kb/guide/how-to-reconnect-to-a-running-sandbox>
- <https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence>

Alternatives:

- <https://www.inngest.com/pricing> · <https://www.inngest.com/docs/usage-limits/inngest> · <https://www.inngest.com/docs/deploy/vercel>
- <https://trigger.dev/pricing> · <https://trigger.dev/docs/wait> · <https://trigger.dev/docs/open-source-self-hosting>
- <https://upstash.com/pricing/qstash> · <https://upstash.com/docs/qstash/features/dlq> · <https://upstash.com/docs/workflow/getstarted>
- <https://pgboss.io/api/jobs> · <https://github.com/timgit/pg-boss/discussions/403> · <https://neon.com/docs/connect/connection-pooling>
