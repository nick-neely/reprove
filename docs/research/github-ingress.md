# GitHub ingress: `vercel/chat` adapter or direct webhooks?

Research for [#5](https://github.com/nick-neely/reprove/issues/5) (child of [#1](https://github.com/nick-neely/reprove/issues/1)).
Resolves PRD open question 6 and the `[Needs Validation]` marker in PRD §15.

- **Researched:** 2026-08-29
- **Package versions examined:** `chat@4.39.0`, `@chat-adapter/github@4.39.0` (published 2026-08-28)
- **Evidence convention:** every claim is tagged **[VERIFIED]** (with a URL, a command output, or a quoted source excerpt) or **[INFERRED]** (reasoning from verified facts). Nothing here is from model training data; all package and doc facts were fetched during this session.

---

## Verdict

**Both, with a strict split - but the chat SDK is optional and should be deferred.**

Direct webhooks on Octokit are **mandatory**, not optional. Two independent hard blockers, each individually sufficient:

1. `@chat-adapter/github` does not route the `pull_request` webhook event at all. Reprove's MVP trigger (`pull_request.opened` / `.synchronize`) is not merely undocumented - the event is silently dropped. **[VERIFIED]**
2. The SDK's send path cannot post a line-anchored review. It calls exactly two write endpoints, neither of which is `POST /pulls/{n}/reviews`. **[VERIFIED]**

Octokit is therefore required regardless of what else is adopted. The chat SDK's remaining value is conversational follow-up on `issue_comment` / `pull_request_review_comment` threads - a Phase 2+ concern, not a Phase 0 one.

**Recommendation: build Phase 0 as direct-webhooks-only. Revisit the chat SDK when conversational follow-up becomes a real requirement.** Costs of each option are in [§8](#8-options-and-what-each-costs).

The PRD's technology table should change `GitHub integration: Chat SDK GitHub adapter` to a direct Octokit webhook layer, and §15's diagram should drop the Chat SDK box.

---

## 1. What `@chat-adapter/github` actually routes (ticket Q1)

**[VERIFIED]** Source: [`packages/adapter-github/src/index.ts`](https://github.com/vercel/chat/blob/main/packages/adapter-github/src/index.ts), method `handleWebhook` (lines 599-702 of the 1757-line file, fetched raw from the GitHub contents API on 2026-08-29).

The entire event dispatch is:

```ts
// Handle events
const ctx = { installationId };
if (eventType === "issue_comment") {
  const issuePayload = payload as IssueCommentWebhookPayload;
  if (issuePayload.action === "created") {
    this.requestContext.run(ctx, () => {
      this.handleIssueComment(issuePayload, installationId, options);
    });
  }
} else if (eventType === "pull_request_review_comment") {
  const reviewPayload = payload as PullRequestReviewCommentWebhookPayload;
  if (reviewPayload.action === "created") {
    this.requestContext.run(ctx, () => {
      this.handleReviewComment(reviewPayload, installationId, options);
    });
  }
}

return new Response("ok", { status: 200 });
```

That is the complete list. Plus `ping`, special-cased earlier with a `200 "pong"`.

**Consequences, all [VERIFIED] from that excerpt:**

- **`pull_request` is not handled.** Not `opened`, not `synchronize`, not any action. A `pull_request` delivery falls straight through both branches to the unconditional `return new Response("ok", { status: 200 })`. It is acknowledged and discarded.
- Even for the two handled events, only `action === "created"` is processed. `edited` and `deleted` are parsed and dropped.
- The payload union type is literally `IssueCommentWebhookPayload | PullRequestReviewCommentWebhookPayload` - the adapter's type system does not model any other GitHub event.

**On the mention question specifically.** The premise in the ticket ("its documented high-level API is mention-driven") is *half* right, and the half that is wrong does not help:

- **[VERIFIED]** The adapter does *not* filter on mentions. `handleIssueComment` / `handleReviewComment` normalize every created comment and call `chat.processMessage(...)` unconditionally; the only filter is a self-message check against the bot's own user id. Mention-matching happens one layer up, in the core `chat` dispatcher.
- **[VERIFIED]** `chat` exposes `onNewMessage(pattern, handler)`, documented in the packaged `docs/handling-events.mdx` as: *"`onNewMessage` fires for messages matching a regex pattern in threads the bot is **not** subscribed to. Use it for keyword-triggered responses without requiring an @-mention."* So a non-mention *comment* can reach a handler.
- **[VERIFIED]** But this is irrelevant to the blocker. `onNewMessage` can only fire for events the adapter routed into `processMessage` in the first place. `pull_request.opened` never gets there.

**Is there an escape hatch?** **[VERIFIED]** `handleWebhook` is public and `handleIssueComment` / `handleReviewComment` are `protected`, and the packaged `docs/platform-adapters.mdx` documents subclassing as the sanctioned way to handle a payload type a base adapter does not cover (its worked example overrides `TelegramAdapter.processUpdate`). So overriding `handleWebhook` to add a `pull_request` branch is *possible*.

**[VERIFIED]** But the same doc warns: *"The `protected` extension surface is intentionally broader than the public API but is not yet considered fully stable... Method signatures may evolve in minor releases."*

**[INFERRED]** Subclassing to add the single most important trigger in the product, against an explicitly unstable surface, on a package that ships a minor roughly every week, is a worse position than writing the handler directly. You would own the `pull_request` parsing anyway; the subclass buys you nothing but coupling.

**[VERIFIED]** No built-in support, config flag, or documented recipe for `pull_request` events exists in the adapter source, its README, or the packaged docs.

---

## 2. What the abstraction actually provides (ticket Q2)

**[VERIFIED]** `npm view @chat-adapter/github dependencies --json`:

```json
{
  "@octokit/auth-app": "^8.2.0",
  "@octokit/rest": "^22.0.1",
  "@chat-adapter/shared": "4.39.0",
  "chat": "4.39.0"
}
```

It wraps Octokit; it does not reimplement HTTP. Everything it does for GitHub, it does *through* the same libraries Reprove would use directly.

| Capability | Provided? | Evidence |
|---|---|---|
| Installation token minting (JWT -> installation token) | Yes | **[VERIFIED]** `new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId } })`. This is `@octokit/auth-app` verbatim - the same three lines you would write yourself. |
| Per-installation client caching (multi-tenant) | Yes | **[VERIFIED]** `getOctokit(installationId)` caches one Octokit per installation, resolved per-request from an `AsyncLocalStorage` store set in `handleWebhook`. Genuinely convenient. |
| HMAC-SHA256 `x-hub-signature-256` verification | Yes | **[VERIFIED]** Hand-rolled with `node:crypto` `createHmac` + `timingSafeEqual`, ~8 lines. Correct, and trivially replicable. |
| Thread / message modelling | Yes | **[VERIFIED]** Encodes three thread-id shapes (`github:{owner}/{repo}:{pr}`, `:issue:{n}`, `:{pr}:rc:{reviewCommentId}`) into a normalized cross-platform `Message`. This is the SDK's actual product. |
| Markdown normalization across platforms | Yes | **[VERIFIED]** Core `chat` deps are entirely remark/unified/mdast - it is a markdown-normalization engine with platform adapters bolted on. |
| Retry / backoff | **No** | **[VERIFIED]** No retry logic in `index.ts`. `docs/error-handling.mdx` surfaces a typed `AdapterRateLimitError` with `retryAfterMs` that the *caller* is told to catch and sleep on. |
| Delivery-level dedupe (`x-github-delivery`) | **No** | **[VERIFIED]** The adapter never reads that header. See [§5](#5-idempotency-and-retry-ticket-q5). |
| Line-anchored PR review | **No** | See [§3](#3-can-it-post-a-line-anchored-review-ticket-q3). |

**[INFERRED]** Net assessment: for Reprove specifically, the abstraction provides an `AsyncLocalStorage`-based per-installation Octokit cache and ~8 lines of HMAC. The thread/message modelling and markdown normalization - the parts that represent real engineering - exist to make one bot work across Slack, Teams, Discord, and Telegram simultaneously. Reprove is GitHub-only. It pays the abstraction's coupling cost and collects almost none of its benefit.

### Serverless caveat if the SDK is ever adopted

**[VERIFIED]** `handleWebhook` invokes handlers fire-and-forget - `this.requestContext.run(ctx, () => { this.handleIssueComment(...) })` with no `await` - then immediately returns `200`. `handleIssueComment` is declared `Promise<void>`.

**[VERIFIED]** This is intentional and is made safe by `WebhookOptions.waitUntil`, documented in `packages/chat/src/types.ts`:

```ts
/**
 * chat.webhooks.slack(request, { waitUntil: (p) => after(() => p) });
 * import { waitUntil } from "@vercel/functions";
 * chat.webhooks.slack(request, { waitUntil });
 */
waitUntil?: (task: Promise<unknown>) => void;
```

**[INFERRED]** On Vercel this is not optional. Omit `waitUntil` and the function may be frozen the instant the `200` is returned, silently dropping in-flight review work. This is a footgun with no type-level enforcement - `waitUntil` is optional in the interface.

---

## 3. Can it post a line-anchored review? (ticket Q3 - hard requirement)

**No. [VERIFIED], and this is decisive.**

`grep -c "createReview" adapter.ts` returns **0**. The string does not appear in the adapter source.

The complete set of Octokit write calls in the adapter, extracted from the source:

```
octokit.issues.createComment                      (line 982)
octokit.issues.updateComment                      (line 1061)
octokit.issues.deleteComment                      (line 1125)
octokit.pulls.createReplyForReviewComment         (line 953)
octokit.pulls.updateReviewComment                 (line 1037)
octokit.pulls.deleteReviewComment                 (line 1119)
octokit.reactions.createForIssueComment           (line 1157)
octokit.reactions.createForPullRequestReviewComment (line 1150)
```

`postMessage()` - the implementation behind the unified `thread.send()` - branches exactly two ways:

```ts
if (reviewCommentId) {
  // Review comment thread - reply with in_reply_to
  const { data: comment } = await octokit.pulls.createReplyForReviewComment({
    owner, repo, pull_number: prNumber, comment_id: reviewCommentId, body,
  });
  ...
}
// PR-level or issue-level thread - issue comment
const { data: comment } = await octokit.issues.createComment({
  owner, repo, issue_number: prNumber, body,
});
```

So the SDK can:
- post a conversation-tab comment (`POST /repos/{o}/{r}/issues/{n}/comments`), or
- reply *inside a review-comment thread a human already created* (`POST /repos/{o}/{r}/pulls/{n}/comments/{id}/replies`).

It **cannot** originate a line-anchored comment, and it cannot batch comments into a single review submission. **[INFERRED]** This is not an oversight - it follows from the cross-platform thread abstraction. "Reply to a thread" is the universal primitive; "attach a comment to line 47 of `src/auth.ts` on the RIGHT side of the diff" has no Slack or Discord analogue, so it cannot exist in a unified surface.

### What Reprove actually needs

**[VERIFIED]** from GitHub's OpenAPI description (`github/rest-api-description`, `api.github.com.deref.json`, fetched 2026-08-29), `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`:

- `comments[]` item required fields: `["path", "body"]`
- item properties: `path`, `body`, `position` (integer), `line` (integer), `side` (string), `start_line` (integer), `start_side` (string)
- `event` enum: `["APPROVE", "REQUEST_CHANGES", "COMMENT"]`, and *"By leaving this blank, you set the review action state to `PENDING`."*

**[VERIFIED]** The `line` / `side` semantics are documented on the sibling endpoint `POST /repos/{o}/{r}/pulls/{n}/comments`, whose schema carries the descriptive text (the `reviews` endpoint's copies are blank in the dereferenced spec):

- `line`: *"**Required unless using `subject_type:file`**. The line of the blob in the pull request diff that the comment applies to. For a multi-line comment, the last line of the range."*
- `side`: enum `["LEFT", "RIGHT"]` - *"Use `LEFT` for deletions that appear in red. Use `RIGHT` for additions that appear in green or unchanged lines."*
- `start_line` / `start_side`: *"**Required when using multi-line comments unless using `in_reply_to`**."*
- `position`: *"**This parameter is closing down. Use `line` instead**."*
- `subject_type`: enum `["line", "file"]`

**[INFERRED]** Two design notes worth carrying into implementation:

1. Use `line` + `side`, not `position`. GitHub marks `position` as closing down; anchoring by diff-hunk offset is also far more fragile to recompute.
2. Prefer the single `createReview` call with a `comments[]` array over N individual `pulls.createComment` calls. **[VERIFIED]** GitHub's docs warn on the per-comment endpoint: *"Creating content too quickly using this endpoint may result in secondary rate limiting,"* with published secondary limits of *"no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour."* A 30-finding review is 1 request in the batched form and 30 in the per-comment form. No documented cap on `comments[]` array length was found.

### Escape hatch

**[VERIFIED]** The adapter exposes the raw authenticated client, and documents it as the intended path for anything outside the unified surface:

```ts
/**
 * The underlying Octokit REST client, authenticated with the credentials
 * this adapter was configured with. Use this for any GitHub API call that
 * isn't covered by the unified Chat SDK surface.
 */
get octokit(): Octokit {
  const ctx = this.requestContext.getStore();
  return this.getOctokit(
    ctx?.installationId ?? this.fixedInstallationId ?? undefined
  );
}
```

**[VERIFIED]** Caveat from its docstring: in multi-tenant mode the getter *"returns the client for the current webhook request's installation, resolved from `AsyncLocalStorage`. Calling this getter outside a webhook handler throws, since there is no installation to authenticate as."*

**[INFERRED]** This matters for Reprove's architecture specifically: review results come back from a worker *minutes* after the webhook returns, far outside the request's `AsyncLocalStorage` scope. So even in a chat-SDK-adopting design, the code that posts the review must construct its own installation-scoped Octokit from a stored installation id. The escape hatch does not reach the place Reprove needs it.

**Answer to Q3: Octokit is needed regardless.** The chat SDK cannot post a review, and its escape hatch is just Octokit with an extra scoping constraint.

---

## 4. Two handlers on one GitHub App (ticket Q4)

This is the question that matters most, so here is the concrete answer.

### The constraint

**[VERIFIED]** A GitHub App has exactly one webhook URL. From [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps): *"you will need to specify **a** webhook URL. The webhook URL is the address of a web server that will receive the webhook event payloads sent to your GitHub App."* The App registration form has a single "Webhook URL" field and a single "Subscribe to events" checkbox list, with no per-event URL field.

**[INFERRED, but structurally certain]** GitHub does not publish a negative statement ("you cannot have two"), but there is no UI or API surface for a second one. Note the distinction: *repository* webhooks (repo Settings > Webhooks) can be many, each with its own URL, but those are a different mechanism and are not tied to an App installation - using them would forfeit installation tokens entirely.

### So: do they conflict?

**No duplicate deliveries.** **[INFERRED from the single-URL fact]** GitHub sends exactly one HTTP POST per event to the one configured URL. Having two handlers behind that URL cannot cause GitHub to send two deliveries. The duplication risk is entirely internal - two handlers both acting on one delivery - and is eliminated by a strict event-type switch.

**No competing signature verification.** **[VERIFIED]** An App has one webhook secret. Both the adapter's `verifySignature` and a direct `@octokit/webhooks-methods` `verify()` compute `HMAC-SHA256(secret, rawBody)` and compare against the same `x-hub-signature-256` header. Same secret, same body, same algorithm - both pass or both fail. There is no scenario where one accepts and the other rejects. The cost is one redundant HMAC per delivery, which is negligible.

**One real conflict: the request body can only be read once.** **[VERIFIED]** `handleWebhook` begins with `const body = await request.text();`. The Fetch `Request` body is a single-use stream. If your route reads the body first (which you must, to switch on event type before deciding where to send it), passing that same `Request` to `handleWebhook` throws.

**[INFERRED]** The fix is mechanical - `request.clone()` before either consumer reads, or better, structure the route so only one handler ever touches a given request:

```ts
// app/api/github/webhooks/route.ts
export async function POST(req: Request) {
  const event = req.headers.get("x-github-event");

  // Conversational surface -> chat SDK (if adopted at all)
  if (event === "issue_comment" || event === "pull_request_review_comment") {
    return bot.webhooks.github(req, { waitUntil });
  }

  // Everything Reprove actually triggers on -> direct handler
  return handleReproveWebhook(req);
}
```

Reading only the *header* to route leaves the body stream untouched, so no clone is needed and each handler owns verification for the requests it receives. **[INFERRED]** This is clean because the two surfaces are disjoint by event type: the adapter handles exactly `issue_comment` and `pull_request_review_comment`; Reprove's automatic trigger is exactly `pull_request`. There is no overlap to arbitrate.

**Split installation-token handling: real, but a cost rather than a conflict.** **[VERIFIED]** The adapter maintains its own per-installation Octokit cache keyed off `AsyncLocalStorage`. A direct path would maintain its own. **[INFERRED]** Consequences:

- Two independent installation-token caches means up to 2x token mints per installation. Not a correctness problem - GitHub issues multiple concurrently valid installation tokens - but wasteful.
- More significant: the App private key is now configured in two places, and there are two code paths that can mint credentials. For a project whose central architectural claim is credential isolation (map issue #1), a second, less-visible credential path is a real cost, not a cosmetic one.
- **[VERIFIED]** The adapter also *writes* on every multi-tenant webhook: `await this.storeInstallationId(owner, name, installationId)` plus a lazy `detectBotUserId` call. That is SDK-owned state in your state adapter, duplicating installation mapping Reprove will already keep in its own database.

**Verdict on Q4:** running both on one App is technically safe - no duplicate deliveries, no signature conflict, and the body-stream issue is solved by routing on the header. The genuine costs are a duplicated credential path and duplicated installation state. **[INFERRED]** Those costs are acceptable *if* the chat SDK earns its place. Given [§1](#1-what-chat-adapter-github-actually-routes-ticket-q1) and [§3](#3-can-it-post-a-line-anchored-review-ticket-q3), for Phase 0 it does not.

---

## 5. Idempotency and retry (ticket Q5)

**The ticket's premise is wrong, and the correction changes the design.**

> "GitHub redelivers on non-2xx" - ticket #5

**[VERIFIED]** It does not. From [Redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks), fetched and quoted directly:

> "You can redeliver webhook deliveries that occurred in the past 3 days. **GitHub does not automatically redeliver failed deliveries.**"

Redelivery is manual only - the web UI, or `POST /app/hook/deliveries/{delivery_id}/attempts`. GitHub's own [best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) frames it as the developer's job: *"If your server goes down, you should redeliver missed webhooks once your server is back up."*

**[INFERRED]** This inverts the risk profile. The danger is not duplicate work from automatic retries; it is **silent permanent event loss**. A handler that 500s on a `pull_request.opened` has dropped that review, and nothing will bring it back within 3 days unless a human notices. Reprove needs delivery *durability* (accept, persist, ack fast, process out of band) far more than it needs aggressive dedupe.

**[VERIFIED]** The 10-second budget, from the same best-practices page:

> "Your server should respond with a 2XX response within 10 seconds of receiving a webhook delivery. If your server takes longer than that to respond, then GitHub terminates the connection and considers the delivery a failure."

and

> "In order to respond in a timely manner, you may want to set up a queue to process webhook payloads asynchronously."

**[VERIFIED]** Vercel function duration limits (Hobby 300s max; Pro/Enterprise 300s default, 800s max, 1800s in beta) are far above 10s, so **[INFERRED]** Vercel's limits are not the binding constraint - GitHub's 10s wall is. The handler must verify, persist, ack, and enqueue; nothing else.

### The `X-GitHub-Delivery` subtlety

**[VERIFIED]**, quoted from the best-practices page:

> "To protect against replay attacks, you can use the `X-GitHub-Delivery` header to ensure that each delivery is unique per event."
>
> **Note:** "If you request a redelivery, the `X-GitHub-Delivery` header will be the same as in the original delivery."

**[INFERRED]** So the GUID identifies the *logical delivery*, not the HTTP attempt. Keying dedupe on it alone is a trap: after a partial failure (row written, job never enqueued), a manual redelivery arrives with the identical GUID and a naive `INSERT ... ON CONFLICT DO NOTHING` dedupe would swallow the recovery attempt - defeating the only recovery mechanism GitHub offers.

### Who is responsible for dedupe

**Reprove. Unambiguously.**

**[VERIFIED]** The chat SDK does not do it. Its `ChatConfig.dedupeTtlMs` (default 600000) is described only as *"TTL in ms for message deduplication"* and operates on message ids inside the core `chat` package - it never reads `x-github-delivery`. And `@chat-adapter/github`'s own README says so explicitly:

> "there is no built-in nonce/delivery-id de-duplication. Keep your webhook handlers idempotent (GitHub may also redeliver events)."

**[VERIFIED]** `@octokit/webhooks` does not do it either - it verifies and dispatches; there is no delivery store.

**[INFERRED]** Recommended two-layer model:

1. **Transport layer** - record `x-github-delivery` with a processing state (`received` / `done`), not a bare uniqueness constraint. A repeat GUID in `done` state is a true duplicate and can be dropped; a repeat GUID in `received` state is a redelivery of something that failed, and must be reprocessed.
2. **Semantic layer** - the real idempotency key for "have I already reviewed this?" is `(installation_id, repository_id, pull_request_number, head_sha)`. This is what makes the system correct under redelivery, manual re-runs, dashboard-triggered reviews, and `synchronize` storms alike. It aligns with PRD §33 ("each run binds to base SHA / head SHA") and satisfies "handle duplicate webhooks idempotently."

**[INFERRED]** The semantic layer is the one that actually matters; the transport layer is cheap insurance. Note that `synchronize` fires on every push, so the design must also *supersede* an in-flight run for a stale `head_sha` rather than merely deduping - PRD §33 already calls for this.

---

## 6. Maturity (ticket Q6)

All **[VERIFIED]** via `npm view` and `gh api` on 2026-08-29.

| Metric | Value |
|---|---|
| `chat` / `@chat-adapter/github` version | `4.39.0` (both, lockstep, published 2026-08-28) |
| Repo | `vercel/chat`, MIT, created 2025-12-22. `vercel-labs/chat` resolves to it - the move is confirmed. |
| First real publish | `chat@4.4.0` on 2026-01-20. (The npm name `chat` dates to 2013 under an unrelated owner - name reuse, not project age.) |
| `@chat-adapter/github` first publish | `0.0.1` on 2026-02-05, then joins lockstep at `4.7.2` on 2026-02-06 |
| Release cadence | Weekly to biweekly: 4.30.0 (Jun 2) ... 4.38.1 (Aug 17), 4.39.0 (Aug 28) |
| Weekly downloads | `chat`: ~2.50M. `@chat-adapter/github`: ~40.4k. |
| Repo activity | 2,326 stars, 294 forks, 21 open issues, 0 open PRs, last push 2026-08-29 |
| Open issues touching the GitHub adapter | None among the 21 open |
| Self-declared stability | No "experimental"/"alpha"/"beta" label anywhere in the README. Also **no 1.0** - public versioning starts at 4.x. |

**[INFERRED]** It is not an abandoned experiment: real download volume, an active release train, a formal adapter-tiering governance doc, typed error hierarchies, Changesets. But it is ~7 months old publicly, ships a minor most weeks, and explicitly marks the `protected` subclassing surface - the exact surface a `pull_request` workaround would depend on - as *"not yet considered fully stable."*

**[INFERRED]** Maturity is not the reason to decline it. Fit is. Even at a hypothetical 1.0 with a stability guarantee, it would still not route `pull_request` and still could not post a review.

---

## 7. What direct webhooks actually cost

**[VERIFIED]** current versions, cross-checked against `gh api repos/octokit/*/releases/latest`:

| Package | Version |
|---|---|
| `@octokit/webhooks` | 14.2.0 |
| `@octokit/webhooks-methods` | 6.0.0 |
| `@octokit/auth-app` | 8.3.0 |
| `octokit` | 5.0.5 |
| `@octokit/app` | 16.1.4 |
| `@octokit/core` | 7.0.7 |

**[VERIFIED]** Raw body in a Next.js App Router Route Handler - from Next.js's own Route Handler docs, which ship a webhook example:

```ts
export async function POST(request: Request) {
  try {
    const text = await request.text()
    // Process the webhook payload
  } catch (error) {
    return new Response(`Webhook error: ${error.message}`, { status: 400 })
  }
  return new Response('Success!', { status: 200 })
}
```

with the note *"unlike API Routes with the Pages Router, you do not need to use `bodyParser`."*

**[VERIFIED]** `X-Hub-Signature-256` is *"the HMAC hex digest of the request body"* - so verification must run against the exact bytes GitHub sent. **[INFERRED]** Never `JSON.parse` then re-serialize before hashing; key order and unicode escaping will differ and every signature will fail.

**[VERIFIED]** `@octokit/webhooks` exports `createNodeMiddleware`, but its README describes it as usable *"as an `Express.js` middleware directly"* - it is Node `http`-shaped and takes `IncomingMessage`/`ServerResponse`, not a Fetch `Request`. **[INFERRED]** It does not fit App Router; use `verify()` from `@octokit/webhooks-methods` against `await req.text()` instead.

**[VERIFIED]** Token minting is three lines of `@octokit/auth-app` config, and the README confirms lifecycle is handled: *"Installation tokens expire after one hour. By default, tokens are cached and returned from cache until expired,"* and it *"transparently creates an installation access token the first time it is needed and refreshes it when it expires."*

**[INFERRED] Honest build estimate for the Phase 0 ingress:** roughly 80-150 lines of first-party code across four pieces - (a) raw-body read + `verify()` + 401, (b) an event-type switch, (c) an installation-scoped Octokit factory, (d) persist delivery + enqueue job + 200. Three dependencies. **[INFERRED]** The genuinely expensive parts of Phase 0 are the queue/worker split and the review-posting logic (diff-position mapping, finding-to-comment translation) - and *neither is avoided by the chat SDK*, since it cannot post the review either.

### Probot, considered and rejected

**[VERIFIED]** `probot@14.3.2` (published 2026-04-03), 9,597 stars, 60 open issues, last push 2026-08-26 - alive and maintained. It depends on `@octokit/webhooks ^14.1.2` and bundles the App/auth/webhook stack.

**[INFERRED]** It is the mature framework answer, but it is built around a long-lived Node server with its own lifecycle, logging (`pino`, `pino-http`), and config loading. On Next.js/Vercel Route Handlers that framing fights the platform, and the ~80-150 lines it replaces are not worth adopting an opinionated server framework. Worth naming so the decision is explicit rather than overlooked.

---

## 8. Options and what each costs

### A. chat-SDK-only - **not viable**

Cost: **cannot ship the MVP.** No `pull_request` routing ([§1](#1-what-chat-adapter-github-actually-routes-ticket-q1)) and no line-anchored review ([§3](#3-can-it-post-a-line-anchored-review-ticket-q3)). Both would have to be worked around by subclassing an explicitly unstable `protected` surface and by dropping to raw Octokit - at which point you have written the direct layer anyway, plus a dependency. Not a close call.

### B. direct-webhooks-only - **recommended for Phase 0**

Cost: ~80-150 lines of first-party ingress code and 3 Octokit dependencies ([§7](#7-what-direct-webhooks-actually-cost)). You own signature verification, event dispatch, dedupe, and enqueue - but [§5](#5-idempotency-and-retry-ticket-q5) shows you own dedupe under every option anyway. One credential path, one installation-state store, full control of the 10-second budget. Gives up: conversational `@reprove` follow-up threads, which the SDK would model for you and which Phase 0 does not need.

### C. both - **the eventual shape, once conversation is a requirement**

Cost: option B's cost, plus a second credential path, a second per-installation token cache, SDK-owned installation state duplicating Reprove's own ([§4](#4-two-handlers-on-one-github-app-ticket-q4)), a mandatory-but-optional-typed `waitUntil` footgun ([§2](#2-what-the-abstraction-actually-provides-ticket-q2)), and a weekly-minor dependency on a pre-1.0 package. Buys: cross-platform thread/message modelling and markdown normalization for conversational replies. Technically safe to run - the two surfaces are disjoint by event type and a header-based route switch avoids the body-stream conflict entirely.

**[INFERRED]** Option C is defensible *later*, and only if Reprove wants conversational review discussion across more than GitHub. If it stays GitHub-only, C never pays off: the abstraction's entire value proposition is portability Reprove is not buying.

---

## 9. Recommendation

**Adopt B (direct-webhooks-only) for Phase 0. Keep the door open to C; do not plan on it.**

Concretely:

1. **PRD §14 technology table:** change `GitHub integration: Chat SDK GitHub adapter` to a direct Octokit-based webhook layer. **[INFERRED]** The current row is not a preference the research narrowly overturned - it names a component that cannot perform either of Reprove's two required GitHub operations.
2. **PRD §15:** drop the Chat SDK box from the ingress diagram. Replace the `[Needs Validation]` marker with this decision.
3. **PRD §41 Phase 0:** "integrate Chat SDK / GitHub webhooks" becomes "integrate GitHub App webhooks (Octokit)."
4. **PRD §16:** the likely-MVP trigger (`PR opened / synchronize`) is unblocked and can be confirmed as the default.
5. **Dedupe ownership is Reprove's** - record `x-github-delivery` with processing state *and* enforce semantic idempotency on `(installation, repo, pr, head_sha)`. This is a schema-shaping decision and belongs in the core schema ticket, not deferred.
6. **Correct the retry assumption everywhere it appears.** GitHub does not auto-redeliver. The ingress must be durable-on-receive, and operational tooling should include a "replay missed deliveries" path against the 3-day window and the `/app/hook/deliveries` API.
7. **[INFERRED]** Worth an ADR, since it reverses a stated PRD technology choice and its rationale (the SDK's mention/thread model is structurally incompatible with automatic, line-anchored review) is not self-evident from the code that results.

---

## 10. Residual uncertainty

- **[INFERRED]** "Exactly one webhook URL per GitHub App" rests on the absence of any UI or API affordance for a second, not on an explicit negative statement in GitHub's docs. The claim is structurally certain but is not a direct quotation.
- **[VERIFIED as a gap]** The `line` / `side` / `start_line` / `start_side` descriptions on the `reviews` endpoint are empty in GitHub's dereferenced OpenAPI spec; the semantics quoted in [§3](#3-can-it-post-a-line-anchored-review-ticket-q3) come from the sibling `pulls/comments` endpoint where GitHub does document them. The field *names and types* on `reviews` are verified directly. Confirm exact behavior against a live PR during implementation.
- **[INFERRED]** No documented cap on `comments[]` array length in a single `createReview` call was found. Probe empirically before assuming a 50+ finding review posts in one request.
- **[INFERRED]** `octokit.rest.pulls.createReview(...)` as the method name follows Octokit's OpenAPI-generated 1:1 naming convention; it was not separately verified against the live typings this session. Risk is negligible but it is inference, not verification.
- **[VERIFIED]** Whether GitHub silently drops unsubscribed event types (rather than delivering them for the App to ignore) could not be confirmed from a direct quote. Immaterial here - subscribe only to what is needed, and the handler switch ignores the rest.

---

## Sources

**Primary source excerpts** were fetched during this session, not recalled:

- `vercel/chat` adapter source: [`packages/adapter-github/src/index.ts`](https://github.com/vercel/chat/blob/main/packages/adapter-github/src/index.ts) (1757 lines, read in full via the GitHub contents API), `packages/chat/src/types.ts`, and the docs shipped inside the `chat@4.39.0` npm tarball (`docs/usage.mdx`, `docs/handling-events.mdx`, `docs/platform-adapters.mdx`, `docs/vercel-connect.mdx`, `docs/error-handling.mdx`), plus `@chat-adapter/github`'s README.
- npm registry: `npm view` for versions, publish times, dependencies; `api.npmjs.org/downloads/point/last-week` for download counts.
- GitHub REST OpenAPI: [`github/rest-api-description`](https://github.com/github/rest-api-description) `descriptions/api.github.com/dereferenced/api.github.com.deref.json`.
- GitHub docs: [best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [redelivering webhooks](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks), [using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps), [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews), [rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- Octokit: READMEs for [`octokit/webhooks.js`](https://github.com/octokit/webhooks.js), [`octokit/auth-app.js`](https://github.com/octokit/auth-app.js), [`octokit/app.js`](https://github.com/octokit/app.js), [`octokit/octokit.js`](https://github.com/octokit/octokit.js).
- Next.js: [Route Handlers API reference](https://nextjs.org/docs/app/api-reference/file-conventions/route). Vercel: [function duration](https://vercel.com/docs/functions/configuring-functions/duration).
