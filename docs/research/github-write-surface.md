# GitHub's write surface: Reviews, Comments, Checks and checkout

Research for [#105](https://github.com/nick-neely/reprove/issues/105) (child of
[Map: Review a real pull request end to end through a hosted Codex Worker](https://github.com/nick-neely/reprove/issues/102)).
Feeds [#108](https://github.com/nick-neely/reprove/issues/108), [#110](https://github.com/nick-neely/reprove/issues/110)
and [#111](https://github.com/nick-neely/reprove/issues/111).

- **Investigated:** 2026-09-14.
- **Evidence convention:** every claim is tagged **[VERIFIED]** (a GitHub-owned URL with a quoted
  excerpt, a schema property read directly, or a read-only command whose output is quoted),
  **[INFERRED]** (reasoning from verified facts, with the facts named), or **[UNKNOWN]** (GitHub
  documents nothing; said plainly rather than guessed). Non-GitHub sources are labelled as such
  and never carry a [VERIFIED] tag on their own.
- **Point-in-time.** Re-verify after ~2026-12.

| Thing | Version / ref | How established |
| --- | --- | --- |
| REST OpenAPI description | `api.github.com.json`, `info.version` **1.1.4** | fetched from [`github/rest-api-description`](https://github.com/github/rest-api-description) `main` |
| Rendered docs source | [`github/docs`](https://github.com/github/docs) `main`, `content/**` and the generated `src/rest/data`, `src/github-apps/data`, `src/webhooks/data` | fetched raw |
| GraphQL schema | live, via `gh api graphql` introspection | run this session |
| REST API version header | `2022-11-28` | already pinned by `client.ts` |

**No writes were made to GitHub.** Every `gh api` call quoted here is a `GET` (or a GraphQL query,
never a mutation). Where a fact could only be settled by writing, it is tagged [UNKNOWN] or
[INFERRED] and the write is named as the way to settle it.

---

## Verdict

Everything Phase 1 needs exists. Five findings move a decision the record has already made.

1. **A review comment cannot be anchored outside a diff hunk.** Not "outside the diff" - outside a
   `@@` **hunk**, which is narrower. The web UI gained the wider ability in 2025; the REST API has
   not. ADR 0007's "Findings outside the diff" rule is therefore **right but under-specified**: the
   body-rendered class includes findings in *changed* files, not only untouched ones (§1.2).
2. **Check Run annotations have none of that restriction.** They take any `path` and line, with no
   diff-membership requirement, and render in the Checks tab regardless of the diff. That is a real
   out-of-diff anchoring surface, and it is currently foreclosed by `CONTEXT.md`'s vocabulary rather
   than by a decision (§2.3).
3. **A shallow or partial Workspace silently breaks two things ADR 0004 promised.** With the remote
   stripped as ADR 0004 requires, `--filter=blob:none` cannot run `git blame` or a content-level
   `git diff` at all, and at `--depth=1` `git merge-base` returns **nothing** while `git blame`
   attributes every line to the graft commit without erroring. ADR 0013 derives `mergeBaseSha` in
   that Workspace (§3.3).
4. **`Checks: write` silently subscribes the App to `check_run` and `check_suite`**, including
   `check_suite.requested` on every push. ADR 0013's "one explicit subscription, three unconditional
   arrivals" becomes *five* the moment the grant widens (§4.6).
5. **A GitHub App can be a requested reviewer, but only Copilot demonstrably is one today.** The
   capability is real and live; third-party Apps have no pending requests on any pull request created
   after 2025-06-01, REST omits bot reviewers from its read path entirely, and whether the webhook
   carries a Bot reviewer is unverified. Promising for #108, not yet buildable (§5.4).

---

## 1. Pull request reviews

### 1.1 The anchoring fields, exactly

**[VERIFIED]** `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, from the OpenAPI
`requestBody`. The schema declares **no top-level `required` array**; `comments[]` items declare
`required: ["path", "body"]`.

| Field | Required | Meaning |
| --- | --- | --- |
| `commit_id` | no | "The SHA of the commit that needs a review. ... **Defaults to the most recent commit in the pull request when you do not specify a value.**" |
| `body` | conditional | "**Required** when using `REQUEST_CHANGES` or `COMMENT` for the `event` parameter." |
| `event` | no | `APPROVE` / `REQUEST_CHANGES` / `COMMENT`; blank means `PENDING` |
| `comments[].path` | **yes** | "The relative path to the file that necessitates a review comment." |
| `comments[].body` | **yes** | "Text of the review comment." |
| `comments[].line` | no* | last line of the range |
| `comments[].side` | no* | `LEFT` / `RIGHT` |
| `comments[].start_line` | no* | first line of a multi-line range |
| `comments[].start_side` | no* | `LEFT` / `RIGHT` / the literal `"side"` |
| `comments[].position` | no | legacy hunk offset |

**[VERIFIED]** `line`, `side`, `start_line` and `start_side` carry **no descriptions at all** on the
reviews endpoint - only examples (`28`, `"RIGHT"`, `26`, `"LEFT"`). This re-confirms the gap
[`github-ingress.md`](github-ingress.md) recorded a year ago; it has not been filled. The semantics
have to be read off the sibling `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`, where
GitHub does document them:

- `side` - "In a split diff view, the side of the diff that the pull request's changes appear on.
  Can be `LEFT` or `RIGHT`. Use `LEFT` for deletions that appear in red. Use `RIGHT` for additions
  that appear in green **or unchanged lines that appear in white and are shown for context**. For a
  multi-line comment, side represents whether the last line of the comment range is a deletion or
  addition."
- `line` - "**Required unless using `subject_type:file`**. The line of the blob in the pull request
  diff that the comment applies to. For a multi-line comment, the last line of the range that your
  comment applies to."
- `start_line` / `start_side` - "**Required when using multi-line comments unless using
  `in_reply_to`**."

**[VERIFIED]** Multi-line anchoring is `start_line` + `start_side` (first line) and `line` + `side`
(last line); a single-line comment omits the `start_*` pair. Confirmed against live data on this
repository: `gh api repos/nick-neely/reprove/pulls/89/comments` returns a comment with
`start_line: 5, start_side: "RIGHT", line: 12, side: "RIGHT"` on `tools/phase0-exit.test.ts`.

**[VERIFIED]** `start_side`'s request enum is `["LEFT", "RIGHT", "side"]` - the literal string
`"side"` is a third accepted value meaning "same as `side`". That is in GitHub's schema, not a
transcription error.

**[VERIFIED]** `position` is **not** flagged `deprecated` on the *reviews* endpoint, unlike the
comments endpoint where it carries `"deprecated": true`, `x-github.deprecationDate: "2022-11-01"`
and the text "**This parameter is closing down. Use `line` instead**". The response schema
`pull-request-review-comment.position` does say "This field is closing down; use `line` instead."
**[INFERRED]** Use `line`; the reviews endpoint is simply behind on annotation.

**[INFERRED]** `position` and the `line` family are mutually exclusive in practice. Nothing in the
schema declares `oneOf`, but the comments endpoint's prose says "If you use `position`, the `line`,
`side`, `start_line`, and `start_side` parameters are not required."

### 1.2 A comment cannot target a line outside the **hunk**

This is the sharpest correction in this document.

**[VERIFIED]** GitHub defines the addressable region arithmetically, in the `position` description:
"The `position` value equals the number of lines down from the first "@@" hunk header in the file
you want to add a comment. The line just below the "@@" line is position 1, the next line is
position 2, and so on. The position in the diff continues to increase through lines of whitespace
and additional hunks until the beginning of a new file."

**[INFERRED]** from that definition plus the `side` description above: the commentable set is
every line inside a `@@` hunk, **including the unchanged context lines inside it**, and nothing
else. A changed file's lines that fall outside every hunk are not addressable. "Outside the diff"
in ADR 0007 therefore under-states the constraint - a finding on line 900 of a file whose only hunk
is at lines 10-20 is just as unanchorable as a finding in a file the pull request never touched.

**[VERIFIED, non-GitHub observation]** The rejection is a `422` and GitHub does not say which
comment it rejected. Reported message strings, consistent across independent reports:

- "Pull request review thread line must be part of the diff" and "Pull request review thread diff
  hunk can't be blank" - [community discussion 32859](https://github.com/orgs/community/discussions/32859)
- `"pull_request_review_thread.line" is not part of the diff` -
  [community discussion 145141](https://github.com/orgs/community/discussions/145141), an open
  feature request titled "Support adding a review comment on a line not part of the diff", filed
  2024-11-20, with **no GitHub staff reply**.
- "Review comments is invalid and Review threads is invalid" -
  [actions/github-script#318](https://github.com/actions/github-script/issues/318).

These are GitHub-hosted but user-authored, so they are observations, not documentation. The exact
envelope could only be confirmed by writing, which this research did not do. **[UNKNOWN]** as a
documented fact; **[INFERRED]** as behaviour, with high confidence.

**[VERIFIED]** The error **shape** differs between the two endpoints and both must be parsed:
`POST /pulls/{n}/reviews` returns `errors` as an array of plain **strings**; `POST /pulls/{n}/comments`
returns an array of **objects** (`resource` / `code` / `field` / `message`). A live example of the
string form appears in [fleetdm/fleet#38750](https://github.com/fleetdm/fleet/issues/38750):
`"errors": ["Review Can not approve your own pull request"]`.

**[INFERRED]** Because a single bad comment fails the whole review and GitHub will not name it,
Reprove must compute anchorability **locally, before publishing**, from the hunk headers. The input
for that is `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`, whose `patch` field carries the
`@@` headers verbatim - verified live on this repository:

```text
$ gh api "repos/nick-neely/reprove/pulls/89/files?per_page=1" --jq '.[0].patch'
@@ -19,7 +19,10 @@ jobs:
     name: verify
     runs-on: ubuntu-latest
...
```

**[VERIFIED]** That endpoint requires only `"Pull requests" repository permissions (read)`, with no
additional permission - so **Reprove can compute the anchorable set without `Contents: read`.**
It caps at 3000 files: "Responses include a maximum of 3000 files. The paginated response returns 30
files per page by default."

### 1.3 The UI moved; the API did not

**[VERIFIED]** [GitHub changelog, 2025-09-25](https://github.blog/changelog/2025-09-25-pull-request-files-changed-public-preview-now-supports-commenting-on-unchanged-lines/):
the new Files changed page lets a human "comment on any line within modified files", with two
qualifications quoted verbatim:

> API support is currently limited, but comments on unchanged lines will be returned by existing
> APIs and in webhook events.

> These comments can only be added to files already changed (i.e., not unchanged files).

**[VERIFIED]** [GitHub changelog, 2026-01-22](https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/)
made that page the default experience: "You can now comment on any line of a changed file, not just
the lines surrounding a change." It says nothing about API support.

**[INFERRED]** No changelog since announces a write API for unchanged-line comments, and the
feature request above is still open and unanswered, so **the asymmetry is live**: a human reviewer
can anchor where Reprove cannot. This is a competitive fact, not just a technical one - it will be
visible to any user who compares Reprove's placement against their own.

**[VERIFIED]** File-level comments are not a way out of it either. `subject_type` (`"line"` /
`"file"`) exists **only** on `POST /pulls/{n}/comments` and on the comment *response* schema. The
`comments[]` item schema of `POST /pulls/{n}/reviews` contains exactly
`path, position, body, line, side, start_line, start_side` - no `subject_type`. A file-level comment
is therefore a separate request that creates its own standalone review, and cannot be batched into
the one review a Run publishes. **[UNKNOWN]** whether a file-level comment can target a file that is
not part of the diff; GitHub does not say, and the changelog's "not unchanged files" sentence is
about the UI.

**[VERIFIED]** GraphQL is not an escape hatch either, on the evidence available. Live introspection
of `AddPullRequestReviewThreadInput` gives exactly `clientMutationId, path, body, pullRequestId,
pullRequestReviewId, line, side, startLine, startSide, subjectType` - the same anchoring vocabulary
as REST, plus `subjectType` (`LINE` / `FILE`). **[UNKNOWN]** whether it relaxes the hunk constraint;
nothing in the schema descriptions says so and no write was performed to find out.

### 1.4 Limits

| Limit | Value | Tag |
| --- | --- | --- |
| Review `body` max length | no `maxLength` in the schema; no documented figure | **[UNKNOWN]** |
| `comments[]` max items | no `maxItems` in the schema; no documented figure | **[UNKNOWN]** |
| Content-generating secondary limit | "no more than 80 content-generating requests per minute and no more than 500 content-generating requests per hour" | **[VERIFIED]** |
| Secondary points | REST `GET`/`HEAD`/`OPTIONS` = 1 point, `POST`/`PATCH`/`PUT`/`DELETE` = **5 points**, ceiling "no more than 900 points per minute" | **[VERIFIED]** |
| Concurrency | "No more than 100 concurrent requests are allowed." | **[VERIFIED]** |
| Primary, installation token | "5,000 requests per hour", "+50 requests per hour for each repository" past 20 repos and per user past 20 users, "cannot increase beyond 12,500 requests per hour"; "15,000 requests per hour" on a GitHub Enterprise Cloud organization | **[VERIFIED]** |

All from [rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28).

**[INFERRED]** The 65,536-character body ceiling that circulates for GitHub bodies is real but is
only ever *observed* against the `IssueComment` resource
(`body is too long (maximum is 65536 characters)`). No observation naming `PullRequestReview` was
found. Treat 65,536 as the budget, not as a verified review limit. For calibration, the largest
review body observed live in this repository is 10,482 characters (CodeRabbit).

**[VERIFIED]** The endpoint warns about itself: "This endpoint triggers notifications. Creating
content too quickly using this endpoint may result in secondary rate limiting."

**[INFERRED]** and decisive for publication design: one `POST /pulls/{n}/reviews` carrying N inline
comments is **one** content-generating request; N standalone `POST /pulls/{n}/comments` calls are
**N**. At 500 content-generating requests per hour the batched form caps Reprove at ~500 published
Reviews per hour per installation token, the unbatched form at ~500 *Comments*. Batch, and reserve
the standalone endpoint for file-level comments and replies.

**[INFERRED, weakly]** Non-GitHub reports describe reviews with ~20 comments failing
([PyGithub#3038](https://github.com/PyGithub/PyGithub/issues/3038),
[actions/github-script#318](https://github.com/actions/github-script/issues/318)), with no
maintainer root cause in either. There is no documented cap, so this is a reason to make publication
retry-aware and idempotent, not a number to design to.

### 1.5 `event`, and who may `REQUEST_CHANGES` on their own pull request

**[VERIFIED]** REST enum: `APPROVE`, `REQUEST_CHANGES`, `COMMENT`. Omitting it: "By leaving this
blank, you set the review action state to `PENDING`, which means you will need to submit the pull
request review when you are ready." A pending review "does not include the `submitted_at` property".
Submitting is `POST /pulls/{n}/reviews/{review_id}/events`, where `event` is `required`.

**[VERIFIED]** GraphQL carries a **fourth** value REST does not. Live introspection of
`PullRequestReviewEvent`:

```text
COMMENT          Submit general feedback without explicit approval.
APPROVE          Submit feedback and approve merging these changes.
REQUEST_CHANGES  Submit feedback that must be addressed before merging.
DISMISS          Dismiss review so it now longer effects merging.
```

**[VERIFIED]** GitHub states the self-review rule flatly:
"[Pull request authors cannot approve their own pull requests.](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)"
The observed API failure is `422` with `"errors": ["Review Can not approve your own pull request"]`
(fleetdm#38750, authenticated as a bot *user* with OAuth scopes, not an installation token).

**[INFERRED]** The restriction is keyed on actor identity, not token type, so an App that opened a
pull request with an installation token - `user.login = "<app-slug>[bot]"` - is the same actor when
it reviews and should hit the same `422`. On a **human-authored** pull request the App is a distinct
actor and `APPROVE` works: **[VERIFIED]** live, `github-actions[bot]` (id `41898282`, an installation
identity) holds review `5201519263` with `state: "APPROVED"` on a human-authored `elastic/kibana`
pull request.

**[UNKNOWN]** Whether `REQUEST_CHANGES` is separately blocked on your own pull request. Both the
documented sentence and the observed error say *approve*. **[INFERRED]** Guard identically: compare
`pull_request.user.id` against the App's own bot user id and degrade to `COMMENT` rather than
relying on a `422`. This matters because Reprove will eventually review pull requests it opened
under `fix` autonomy.

**[VERIFIED]** `REQUEST_CHANGES` does **not** block merge by itself:
"[The **Request changes** option is purely informational and will not prevent merging unless a
ruleset or classic branch protection rule is configured with the 'require a pull request' option.](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)"
Where required reviews **are** configured, it blocks "until the same collaborator submits another
review approving the changes", and it is a **separate gate** from a required check -
`required_pull_request_reviews` versus `required_status_checks`, surfaced independently in GraphQL
as `PullRequest.reviewDecision` (`APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`).

**[INFERRED]** Whether an App's `CHANGES_REQUESTED` counts toward `reviewDecision` exactly as a
human's does is not documented - GitHub's prose says "collaborator" throughout - but since an App's
`APPROVED` demonstrably counts, the symmetric claim is likely. ADR 0002's default of `COMMENT`
is confirmed as the right one, and this is the reason to keep `REQUEST_CHANGES` opt-in: only a
write-capable human can clear a blocking review Reprove leaves behind.

### 1.6 How the App's identity appears on a Review

Read live from `nick-neely/reprove` and three large public repositories. **[VERIFIED]** observed
values across every bot-authored Review inspected:

| Field | Observed |
| --- | --- |
| `user.login` | `coderabbitai[bot]`, `greptile-apps[bot]`, `github-actions[bot]`, `copilot-pull-request-reviewer[bot]` - always `<app-slug>[bot]` |
| `user.type` | `"Bot"` |
| `user.id` | stable per App (CodeRabbit `136622811`, Greptile `165735046`, github-actions `41898282`) |
| `user.node_id` | `BOT_kgDOCCSy2w` (CodeRabbit), `BOT_kgDOCeDqhg` (Greptile) |
| `user.html_url` | `https://github.com/apps/<slug>` - note `/apps/`, not `/users/` |
| `author_association` | present; varies (`NONE` in this repository, `CONTRIBUTOR` elsewhere) |
| `performed_via_github_app` | **absent** |

**[VERIFIED]** `performed_via_github_app` is not a property of the `pull-request-review` or
`pull-request-review-comment` schemas at all, though it *is* a property of `issue-comment`. So a
Review carries no explicit App attribution: **identify the author by `user.id`**, which is stable,
rather than by `login` or by an App field that does not exist.

**[VERIFIED]** The complete top-level key set of a Review, identical across every payload observed:
`_links, author_association, body, commit_id, html_url, id, node_id, pull_request_url, state,
submitted_at, user`. `submitted_at` is not in the schema's `required` list - that is the pending case.

**[VERIFIED]** One live behaviour worth designing around: on PR 89 of this repository, outdated
review comments carry `line: null` and `start_line: null` while `original_line`,
`original_start_line` and `original_position` retain the anchor (for example `original_line: 601` on
`tools/gate-fixtures.mjs`). A prior Comment's location survives a force-push in the `original_*`
fields only.

### 1.7 Update, dismiss, delete

**[VERIFIED]** from the OpenAPI. Every one of these is `Pull requests: write`, with
`additional-permissions: false` - no `Contents` anywhere in the review write surface.

| Operation | Endpoint | What it changes |
| --- | --- | --- |
| Update review | `PUT /repos/{o}/{r}/pulls/{n}/reviews/{review_id}` | "Updates the contents of a specified review summary comment." Body: `{body}`, **required**. **Body only.** |
| Delete pending review | `DELETE /repos/{o}/{r}/pulls/{n}/reviews/{review_id}` | "Deletes a pull request review that has not been submitted. **Submitted reviews cannot be deleted.**" |
| Dismiss review | `PUT /repos/{o}/{r}/pulls/{n}/reviews/{review_id}/dismissals` | `{message}` **required**, `{event: "DISMISS"}` optional |
| Submit pending | `POST /repos/{o}/{r}/pulls/{n}/reviews/{review_id}/events` | `{event}` **required** |
| Edit a comment | `PATCH /repos/{o}/{r}/pulls/comments/{comment_id}` | `{body}` **required** |
| Delete a comment | `DELETE /repos/{o}/{r}/pulls/comments/{comment_id}` | `204` |

**[VERIFIED]** "Update review" changes `body` and nothing else - the request schema has exactly one
property. An App **cannot** change a submitted review's `state`, its `commit_id`, or its attached
comments. Turning an `APPROVE` into a `REQUEST_CHANGES` means dismiss-and-repost.

**[VERIFIED as a documented negative]** There is **no** restriction that an App may dismiss only its
own review. The gate is branch protection, not authorship: "To dismiss a pull request review on a
protected branch, you must be a repository administrator or be included in the list of people or
teams who can dismiss pull request reviews", and the branch-protection schema's
`dismissal_restrictions` accepts an `apps` list ("The list of app `slug`s with dismissal access").
On an unprotected branch, `Pull requests: write` is enough to dismiss anyone's review.

**[INFERRED]** That is a larger authority than Reprove wants to exercise and should be treated as
one: the capability exists, and the decision not to use it on reviews Reprove did not author should
be explicit.

**[VERIFIED]** Resolving a review thread is **GraphQL-only**. The OpenAPI contains no `resolve` path
outside `/notifications/threads/{thread_id}`. Live introspection confirms
`resolveReviewThread` ("Marks a review thread as resolved.") and `unresolveReviewThread`, taking
`threadId: ID!` - a **thread** node id, which is not a REST comment id, so resolving requires a
GraphQL round trip through `pullRequest.reviewThreads` and a `viewerCanResolve` check.
**[UNKNOWN]** which fine-grained permission `resolveReviewThread` requires; the docs' permission
mapping covers REST only.

---

## 2. Check runs

### 2.1 Creating before there is a result, and completing later

**[VERIFIED]** `POST /repos/{owner}/{repo}/check-runs` requires exactly `["name", "head_sha"]`.
Everything else is optional. "To create a check run, you must use a GitHub App. OAuth apps and
authenticated users are not able to create a check suite" (GitHub's own wording, trailing typo
included), reinforced by the shared note "Write permission for the REST API to interact with checks
is only available to GitHub Apps."

**[VERIFIED]** The request schema encodes the deferred-result flow structurally, as a `oneOf`
discriminated on `status`: `status: completed` requires `conclusion`; `status` in
`["queued", "in_progress"]` requires no conclusion. GitHub's own CI guide states the intent:

> As soon as you receive the `check_suite` webhook, you can create the check run, even if the check
> is not complete. You can update the `status` of the check run as it completes with the values
> `queued`, `in_progress`, or `completed`, and you can update the `output` as more details become
> available.

**[VERIFIED]** `status` enum is `["queued", "in_progress", "completed", "waiting", "requested",
"pending"]` with "Only GitHub Actions can set a status of `waiting`, `pending`, or `requested`." An
App has three settable values. **[UNKNOWN]** what happens if an App sends one of the Actions-only
values - the schema admits them and the prose forbids them, and GitHub does not say which wins.

**[VERIFIED]** `conclusion` enum: `action_required`, `cancelled`, `failure`, `neutral`, `success`,
`skipped`, `stale`, `timed_out`. Verbatim:

> **Required if you provide `completed_at` or a `status` of `completed`**. The final conclusion of
> the check. **Note:** Providing `conclusion` will automatically set the `status` parameter to
> `completed`. You cannot change a check run conclusion to `stale`, only GitHub can set this.

So an App may set seven of the eight; `stale` is GitHub's. **[VERIFIED]** and operationally sharp:
"If a check run is in an incomplete state for more than 14 days, then the check run's `conclusion`
becomes `stale`". A Run that hangs does not stay `in_progress` forever - it rots at 14 days into a
conclusion Reprove's status mapping does not produce.

**[VERIFIED]** `startup_failure` is a check **suite** conclusion only: "This status is not applicable
to check runs."

**[VERIFIED]** `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` exists and its request body is
exactly `name, details_url, external_id, started_at, status, conclusion, completed_at, output,
actions`.

**[VERIFIED by absence, therefore [INFERRED]]** `head_sha` is **not** a PATCH property. A Check Run's
commit is immutable; reporting on a new head means creating a new Check Run. That aligns cleanly with
ADR 0007 - a Run is pinned to a head SHA and a new push produces a new Run - but it forecloses any
design that reuses one Check Run across Runs on the same pull request.

**[VERIFIED]** A schema inconsistency worth coding around: `output` on PATCH declares
`required: ["summary"]`, while `output.title`'s own description says "**Required**." Send both on
every PATCH that carries `output`.

**[INFERRED, from consistent third-party observation; GitHub documents nothing]** An App can update
only the Check Runs it created. The reported failure is `403` with
`Invalid app_id <n> - check run can only be modified by the GitHub App that created it`. Searching
`github/docs` for this restriction returns nothing, and
[github/rest-api-description#4290](https://github.com/github/rest-api-description/issues/4290),
which asserts it, has no GitHub staff reply. Treat it as true in practice and unciteable.

### 2.2 `output` and annotation limits

**[VERIFIED]** from the request schema:

| Field | Limit | In the schema? |
| --- | --- | --- |
| `output.title` | none documented | no `maxLength` - **[UNKNOWN]** |
| `output.summary` | 65535 characters | `maxLength: 65535` |
| `output.text` | 65535 characters | `maxLength: 65535` |
| `output.annotations[]` | 50 per request | `maxItems: 50` |
| `actions[]` | 3 | `maxItems: 3` |
| annotation `message` | "The maximum size is 64 KB." | prose only |
| annotation `raw_details` | "The maximum size is 64 KB." | prose only |
| annotation `title` | "The maximum size is 255 characters." | prose only |

The three prose-only limits carry no `maxLength`, so a generated SDK will not catch an overrun
client-side.

**[VERIFIED]** The batching rule, verbatim:

> The Checks API limits the number of annotations to a maximum of 50 per API request. To create more
> than 50 annotations, you have to make multiple requests to the Update a check run endpoint. Each
> time you update the check run, annotations are appended to the list of annotations that already
> exist for the check run. GitHub Actions are limited to 10 warning annotations and 10 error
> annotations per step.

The 10+10 figure is **Actions-step-scoped and does not bind an App posting through REST**.
**[UNKNOWN]** the total annotations per check run - GitHub documents only the per-request 50.

**[VERIFIED]** Annotation fields: required are `path`, `start_line`, `end_line`, `annotation_level`
(`notice` / `warning` / `failure`), `message`. Columns are constrained: "Annotations only support
`start_column` and `end_column` on the same line. Omit this parameter if `start_line` and `end_line`
have different values."

### 2.3 Annotations are the out-of-diff anchoring surface

**[VERIFIED]** GitHub's CI guide, verbatim:

> Your check runs can include annotations that are displayed on specific lines of code. Annotations
> are visible in the **Checks** tab. When you create an annotation for a file that is part of the
> pull request, the annotations are also shown in the **Files changed** tab.

**[VERIFIED]** There is no diff-membership requirement on an annotation anywhere in the schema or
the prose. The only qualification GitHub states is about *rendering*: the Checks tab shows every
annotation; the Files changed tab additionally shows those whose **file** is part of the pull
request. The qualification is at file granularity, not line granularity.

**[UNKNOWN]** whether an annotation on an *unchanged line of a changed file* renders inline in Files
changed. GitHub says "a file that is part of the pull request" and stops there.

**[INFERRED]** This is a genuine capability ADR 0007 did not weigh. A Finding that cannot be a
Comment - because it falls outside every hunk - **can** be an annotation on its exact
`path:line`, and will render there in the Checks tab. That is a strictly better location statement
than a `path:line` string in the Review body. It is also directly against `CONTEXT.md`, which lists
`annotation` as a word to *avoid* for `Comment`. Section 6 takes this up; it is not a
recommendation to adopt annotations, it is a finding that the option exists and was priced at zero.

### 2.4 Re-run, and what else `Checks: write` turns on

**[VERIFIED]** `check_run` actions and their delivery rules, verbatim from the generated webhook
data behind [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads):

- `created` - "A new check run was created."
- `completed` - "A check run was completed, and a conclusion is available."
- `rerequested` - "Someone requested to re-run a check run. **Only the GitHub App that someone
  requests to re-run the check will receive the `rerequested` payload.**"
- `requested_action` - "A check run completed, and someone requested a followup action that your app
  provides. **Only the GitHub App someone requests to perform an action will receive the
  `requested_action` payload.**"

**[VERIFIED]** The permission note, and the sentence that matters most in this whole document:

> To subscribe to this event, a GitHub App must have at least read-level access for the "Checks"
> repository permission. To receive the `rerequested` and `requested_action` event types, the app
> must have at least write-level access for the "Checks" permission. **GitHub Apps with write-level
> access for the "Checks" permission are automatically subscribed to this webhook event.**
> Repository and organization webhooks only receive payloads for the `created` and `completed` event
> types in repositories.

`check_suite` carries the identical clause for its `requested` / `rerequested` actions.

**[VERIFIED]** `check_suite.requested` is an implicit push trigger: "By default, GitHub creates a
check suite automatically when code is pushed to the repository. This default flow sends the
`check_suite` event (with `requested` action) to all GitHub Apps that have the `checks:write`
permission." It is opt-out only by a repository **admin**, via
`PATCH /repos/{owner}/{repo}/check-suites/preferences` with `auto_trigger_checks` - "You must have
admin permissions in the repository to set preferences for check suites."

**[VERIFIED]** A fan-out asymmetry that will bite an unfiltered handler: "GitHub sends all events for
`created` check runs to every app installed on a repository that has the necessary checks
permissions. That means that your app will receive check runs created by other apps." Filter on
`check_run.app.id`.

**[VERIFIED]** `POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest` defines the
semantics of a re-run precisely:

> This endpoint will trigger the `check_run` webhook event with the action `rerequested`. When a
> check run is `rerequested`, the `status` of the check suite it belongs to is reset to `queued` and
> the `conclusion` is cleared. **The check run itself is not updated.** GitHub apps recieving the
> `check_run` webhook with the `rerequested` action should then decide if the check run should be
> reset or updated...

So GitHub does not reset the Check Run; the App does. **[VERIFIED]** The UI mapping for a single
check is documented - "When someone re-runs a single test on GitHub by clicking the 'Re-run' button,
GitHub sends the `rerequested` check run event to your app" - while **[INFERRED]** "Re-run all
checks" maps to `check_suite.rerequested`; the button-to-event mapping for the suite case is not
stated.

**[VERIFIED]** `actions[]` is a second manual-trigger surface, and a cheap one: max 3, each
`{label, description, identifier}` with `maxLength` 20 / 40 / 20, all required. "The button created
in this object is displayed after the check run completes. When a user clicks the button, GitHub
sends the `check_run.requested_action` webhook to your app", and `requested_action.identifier` is
"The integrator reference of the action requested by the user."

**[VERIFIED]** `check_run.pull_requests[]` is **not** a reliable pull request handle. Its own
description: "Pull requests that are open with a `head_sha` or `head_branch` that matches the check.
The returned pull requests do not necessarily indicate pull requests that triggered the check." And
the fork caveat, repeated across the checks docs: "The Checks API only looks for pushes in the
repository where the check suite or check run were created. **Pushes to a branch in a forked
repository are not detected and return an empty `pull_requests` array**" and a `null` `head_branch`.

**[INFERRED]** For a fork pull request - the majority case for an open-source reviewer - Reprove
cannot recover the pull request number from a `rerequested` payload. It must carry its own handle.
`external_id` is the field for that: it is settable on create and on update, and GitHub Actions uses
it for exactly this purpose (observed live: `external_id: "5ad37362-83a5-5bff-ab25-ea402deca63b"`).

### 2.5 What a required-check rule sees

**[VERIFIED]** The rule matches the check run **name**, with the App as an optional extra constraint.
Branch protection takes `checks: [{context, app_id}]` where `context` is "The name of the required
check" and `app_id` is "The ID of the GitHub App that must provide this check. Omit this field to
automatically select the GitHub App that has recently provided this check... **Pass `-1` to
explicitly allow any app to set the status.**" The legacy `contexts: [string]` form is
`deprecated: true`. Rulesets use the same shape with `context` plus an optional `integration_id`.

**[VERIFIED]** Prose confirmation and the documented failure message: "If the status is set by any
other person or integration, merging won't be allowed" / `Required status check "build" was not set
by the expected GitHub App.`

**[VERIFIED]** If the App never creates the check, the pull request **sits blocked indefinitely**.
GitHub's own troubleshooting page: "If `build` is required, the pull request is blocked with
**'Waiting for status to be reported.'**", and the summary row "Associated checks stay in a
'Pending' state and block merging".

**[VERIFIED]** `neutral` and `skipped` **count as passing**, stated twice independently:

> Required status checks must have a `successful`, `skipped`, or `neutral` status before
> collaborators can make changes to a protected branch.

> Successful check statuses are `success`, `skipped`, and `neutral`.

**[VERIFIED]** Three more rules that constrain a per-Run Check: "A required status check must have
completed successfully in the chosen repository during the past **seven days**"; "Required checks
must pass on the **latest commit SHA**. Checks from earlier commits don't satisfy the requirement";
"If a check and a commit status have the same name, **both** must pass when that name is required."

**[VERIFIED]** Check Run versus Commit Status, from GitHub's comparison table: Checks give "Detailed
output, annotations, and messages" and are "Created by GitHub Apps, including GitHub Actions";
commit statuses are "A simpler status for a commit" from "External services and integrations". Both
occupy the same required-check namespace by name. Only Checks populate the Checks tab.

**[VERIFIED]** Retention: "GitHub retains checks data for 400 days. After 400 days, the data is
archived. 10 days after archival, the data is permanently deleted." And "To merge a pull request
with checks that are both required and archived, you must rerun the checks."

**[VERIFIED]** Per-suite cap: "In a check suite, GitHub limits the number of check runs with the same
name to 1000. Once these check runs exceed 1000, GitHub will start to automatically delete older
check runs."

**[VERIFIED, and flagged as probably a doc error]** The rulesets documentation says an App pinned as
a required-check source "must be installed in the repository with the `statuses:write` permission" -
`statuses`, not `checks`, in a sentence otherwise about check runs. **[UNKNOWN]** whether that is
accurate. If Reprove wants to be selectable as a pinned required-check source in an organization
ruleset, this is the one place the grant might need `Commit statuses: write` as well.

**[VERIFIED]** Permission mapping: create, update, rerequest, and check-suite preferences are all
`Checks: write` with no additional permission; all reads are `Checks: read`.

**[VERIFIED]** No check-run-specific rate limit is documented; the generic limits in §1.4 apply.
**[UNKNOWN]** whether a check-run write counts as "content-generating" for the 80/minute and
500/hour secondary limit - GitHub does not enumerate which endpoints do, and notes "Some REST API
endpoints have a different point cost that is not shared publicly."

---

## 3. Fetching an exact commit as an App

ADR 0004 fixes what the answer has to satisfy: the Workspace is "pinned to a Run's base and head
SHA", the Worker must "strip credential-bearing URLs and credential helpers from `.git/config`", must
"leave no Git alternates or linked-worktree pointers referencing host locations", must "resolve
submodules and LFS host-side if they are needed at all", and must "preserve enough history for
`git log` and `git blame` to be useful, with the depth decided separately". ADR 0013 adds that
`mergeBaseSha` is "derived from the Git object graph" inside that Workspace.

**Those two requirements interact, and the interaction eliminates most of the cheap options.** The
measurements below were run this session against `github.com`.

### 3.1 The tarball cannot be the Workspace

**[VERIFIED]** `GET /repos/{owner}/{repo}/tarball/{ref}` and `/zipball/{ref}` need `Contents: read`,
with no additional permission. `{ref}` may be a full commit SHA, and GitHub recommends exactly that:
"we recommend using the archives REST API with a commit ID for `:ref`. Using the commit ID ensures
you'll always get the same file contents inside the archive."

**[VERIFIED]** "Gets a redirect URL to download a tar archive for a repository... Please make sure
your HTTP framework is configured to follow redirects or you will need to use the `Location` header
to make a second `GET` request." And: "**For private repositories, these links are temporary and
expire after five minutes.**" The zipball variant adds "If the repository is empty, you will receive
a 404 when you follow the redirect."

**[VERIFIED] live** against this repository:

```text
$ curl -sL -o t.tar.gz "https://api.github.com/repos/nick-neely/reprove/tarball/6a71d3ad...9600" \
       -w "http=%{http_code} redirects=%{num_redirects} final=%{url_effective}\n"
http=200 redirects=1 final=https://codeload.github.com/nick-neely/reprove/legacy.tar.gz/6a71d3ad...9600

$ tar tzf t.tar.gz | head -1
nick-neely-reprove-6a71d3a/

$ tar tzf t.tar.gz | grep -c '\.git/'
0                       # out of 603 entries
```

So: one redirect, to `codeload.github.com`; top-level directory `{owner}-{repo}-{short-sha}/`; and
**no `.git` at all**. GitHub says so too - "Snapshots don't contain the entire repository history."

**[VERIFIED]** The folklore that the redirect target rejects the `Authorization` header **does not
reproduce**: a signed `codeload` Location returned an identical body with the header present, absent,
and forwarded via `--location-trusted`. That gotcha belongs to release assets on S3, a different host.

**[VERIFIED]** Submodule contents are **not** in the archive - streaming `grpc/grpc`'s tarball shows
`third_party/googletest/`, `third_party/abseil-cpp/` and `third_party/benchmark/` as directory
entries with zero files under them. `.gitmodules` *is* included. That is `git archive` semantics, and
GitHub says archives "are generated by the `git archive` command".

**[VERIFIED]** LFS content is **pointers only by default**, and the exception is not Reprove's to
take: "By default, Git LFS objects are not included in these archives, only the pointer files to
these objects. To improve the usability of archives for your repository, you can choose to include
the Git LFS objects instead." That is a per-repository admin setting. Also "If you use an external
LFS server (configured in your `.lfsconfig`), those LFS files will not be included in archives."

**[UNKNOWN]** any documented size or bandwidth limit on source archives; none exists in
`github/docs`. A 158.9 MB archive downloaded fine empirically.

**[VERIFIED, empirically; undocumented]** The tarball `302` did **not** consume a core rate-limit
unit (measured against `GET /rate_limit`, which GitHub confirms "does not count against your primary
rate limit"), and `codeload.github.com` returns no `x-ratelimit-*` headers at all. Treat that as
observed, not guaranteed.

**[INFERRED]** The archive is a fine way to get a content snapshot and a bad way to get a Workspace.
It cannot satisfy ADR 0004 at all, because ADR 0004 keeps `.git` deliberately.

### 3.2 `git clone` with an installation token

**[VERIFIED]** The documented form: "You can also use an installation access token to authenticate
for HTTP-based Git access. Your app must have the **'Contents'** repository permission. You can then
use the installation access token as the HTTP password... `git clone
https://x-access-token:TOKEN@github.com/owner/repo.git`".

**[VERIFIED]** "The installation access token will expire after 1 hour", and an expired token gives
`401`. Revocable early with `DELETE /installation/token`. **[UNKNOWN]** whether an in-flight clone
survives expiry; GitHub says nothing. **[INFERRED]** Smart-HTTP authenticates per request, so a
`git-upload-pack` POST already authorized should finish, but any follow-up request - an LFS batch, a
submodule fetch, a second negotiation round - will `401`. Mint immediately before each network
operation.

**[VERIFIED]** A format change Reprove must not be broken by: "Starting April 27, 2026, GitHub began a
staged rollout of a stateless format (`ghs_APPID_JWT`) to all newly minted GitHub App installation
tokens... If your application expects or relies on installation tokens being exactly 40 characters
long, it may not handle this new token format correctly." Nothing in `client.ts` assumes a length
today; this is a constraint on whatever handles the checkout token later, including log redaction.

**[VERIFIED]** Fetching an **arbitrary commit SHA** works. GitHub advertises
`allow-tip-sha1-in-want allow-reachable-sha1-in-want ... filter` in its upload-pack capabilities, and
live:

```text
$ git init -q probe && cd probe && git remote add origin https://github.com/nick-neely/reprove.git
$ git fetch --depth=1 origin 6a71d3ad1f68070638bd630bd2dbf6a16ca49600
 * branch  6a71d3ad1f68070638bd630bd2dbf6a16ca49600 -> FETCH_HEAD    # ~1.1s
```

**[VERIFIED]** but only with the **full 40-character SHA**: `git fetch origin 454eeb7` fails with
`fatal: couldn't find remote ref 454eeb7`. **[UNKNOWN]** as a *supported guarantee* - GitHub has
never documented fetch-by-SHA. **[VERIFIED]** that `actions/checkout` depends on it: its
`getRefSpec()` pushes a bare commit as a refspec and its `fetch()` runs
`git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules [--filter] [--depth]`,
with `fetch-depth` defaulting to `1`.

**[VERIFIED]** A **fork** pull request's head is reachable from the **base** repository, which is what
makes a base-repo installation token sufficient. Live, against `github/docs` PR 45881 whose head is
in `kjanat/docs`:

```text
$ git remote add origin https://github.com/github/docs.git
$ git fetch --depth=1 origin refs/pull/45881/head && git rev-parse FETCH_HEAD
3f584411b41dd75c64e1c16bb48fdca5850e5100     # == the PR's head.sha in the fork
$ git fetch --depth=1 origin 3f584411b41dd75c64e1c16bb48fdca5850e5100     # bare SHA also works
```

**[VERIFIED]** GitHub documents the refs themselves - "When you open a pull request, GitHub creates
temporary Git references that point to the pull request's head branch and, when possible, to a
simulated merge result", `git fetch origin pull/ID/head:BRANCH_NAME`, and "The remote `refs/pull/`
namespace is *read-only*" - and states the underlying fact plainly: "After a pull request is opened,
GitHub stores all of the changes remotely. Commits in a pull request are available in a repository
even before the pull request is merged."

**[VERIFIED]** Git operations have **no REST rate-limit bucket**. `GET /rate_limit` returns
`core, search, graphql, integration_manifest, source_import, code_search, dependency_sbom,
dependency_snapshots, code_scanning_autofix, audit_log, scim, ...` and no `git` resource. The two
documented git-adjacent limits are LFS - "API requests are required when you upload or download Git
LFS content. These count towards a separate rate limiting bucket with a limit of 300 requests per
minute for unauthenticated requests and 3,000 requests per minute for authenticated requests" - and a
**recommendation**, not an enforced ceiling: "Git read operations (e.g. fetches, clones): The
recommended maximum limit is 15 operations per second per repository."

### 3.3 The measurement that decides the Workspace shape

Every cheap checkout strategy is a partial view of the object graph, and ADR 0004's
credential-stripping requirement removes the escape hatch that makes partial views work. Measured
this session against `nick-neely/reprove` (62 commits), with the remote removed after cloning, as
ADR 0004 requires:

| Operation | Full clone | `--filter=blob:none`, remote removed | `--depth=1`, remote removed |
| --- | --- | --- | --- |
| `git log` | 62 commits | **62 commits** | 1 commit |
| `git merge-base head base` | `454eeb74...` | **`454eeb74...`** | **empty, exit 1** |
| `git diff --name-only base head` | works | **works** | n/a |
| `git diff --stat base head` | works | `fatal: unable to read 511dd4ca...` | n/a |
| `git show <old-sha>:<path>` | works | `fatal: bad object` | n/a |
| `git blame <path>` | `a20ec45b (Nick Neely 2026-09-01 ...)` | `fatal: Cannot read blob 6b73a125...` | **`^6a71d3a` - every line attributed to the graft** |

The `--depth=1` column mixes two shapes deliberately: `log` and `blame` were measured on a depth-1
clone of one ref, and `merge-base` on a repository where the head and the base were each fetched
separately at `--depth=1`, which is the shape a Run would actually build. The `n/a` cells are
comparisons that shape cannot pose.

Three findings follow, and each one is load-bearing.

**[VERIFIED] A partial clone is structurally incompatible with a credential-stripped Workspace.** A
`--filter=blob:none` clone writes `remote.origin.promisor=true` and
`remote.origin.partialclonefilter=blob:none` into `.git/config`, and every missing blob is fetched
lazily *from that remote*. Removing it - which ADR 0004 requires, and requires more thoroughly than
`git remote remove` - leaves a repository that can walk history and compare trees but cannot read any
historical file content. `git blame` and content-level `git diff` both fail hard. The bandwidth the
filter saves is therefore unavailable to Reprove, because Reprove cannot keep the promisor.

**[VERIFIED] `git merge-base` on a shallow clone returns nothing, not an error message.** With both
the head and the base commit fetched at `--depth=1`, `git merge-base` printed no output and exited
`1`; the full clone printed the correct answer. Deepening to `--depth=2` fixed it *in this instance
only*, because the base happened to be the head's parent. In general the depth needed to reach a
merge base is a function of how far the branches diverged and is unbounded. **This is a direct
constraint on ADR 0013**, which derives `mergeBaseSha` in the Workspace precisely to avoid calling
the compare endpoint at ingress: that derivation is correct only if the Workspace has enough history,
and "enough" cannot be a constant. A silent empty result is the worst available failure mode for a
value that determines which lines a Reviewer is asked to judge.

**[VERIFIED] `git blame` on a shallow clone does not fail - it lies.** Every line is attributed to
the graft commit, marked only by a `^` prefix that nothing checks. GitHub's own engineering blog says
the same: "Since the commit history is truncated, commands such as `git merge-base` or `git log` show
different results than they would in a full clone!" and, on blame, "Shallow clones don't even make
that a possibility!"
([Get up to speed with partial clone and shallow clone](https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/),
2020-12-21, updated 2021-04-28).

**[VERIFIED]** GitHub's guidance on shallow clones is also more negative than the repository-limits
page suggests. The blog: "We **do not recommend shallow clones** except for builds that delete the
repository immediately afterwards" and "Fetching from shallow clones can cause more harm than good!";
`repository-limits.md`: "shallow clones will impose less cost and burden on the server than full
clones". **[INFERRED]** The reconciliation is that a one-shot shallow *clone* is cheap and repeated
*fetches into a retained* shallow clone are not. Reprove's disposable Sandbox is on the cheap side of
that line, so the server-cost objection does not bind; the *correctness* objections above do.

**[VERIFIED]** `--shallow-since` works (`git clone --shallow-since="2026-06-01"` of `github/docs`
produced a shallow repository with 1,720 commits), backed by the advertised `deepen-since deepen-not
deepen-relative` capabilities. **[INFERRED]** It has the same unbounded-depth problem as `--depth=N`
for merge-base: a pull request older than the window still has no reachable merge base.

### 3.4 Blame without a full clone

**[VERIFIED]** GraphQL exposes blame directly, from the published schema
(`https://docs.github.com/public/fpt/schema.docs.graphql`):

```graphql
type Blame { ranges: [BlameRange!]! }
type BlameRange { age: Int!  commit: Commit!  endingLine: Int!  startingLine: Int! }
# on Commit:
blame(path: String!): Blame!
```

`blame` hangs off `Commit`, so it is pinned with `repository.object(expression: "<sha>")` - exactly
the shape a Run needs. A live query against `octocat/Hello-World` at `7fd1a60b...` returned
`{"startingLine":1,"endingLine":1,"age":10,"commit":{"oid":"762941318ee1..."}}`, which is the correct
attribution the shallow clone got wrong.

**[VERIFIED]** REST has a coarser equivalent: `GET /repos/{o}/{r}/commits` accepts `path` - "Only
commits containing this file path will be returned" - plus `sha`, `since`, `until`. It is
`Contents: read`.

**[VERIFIED]** And for ADR 0007's per-file anchor re-check at publish time,
`GET /repos/{o}/{r}/contents/{path}` is bounded in a way the ADR should know: "1 MB or smaller: All
features of this endpoint are supported"; "Between 1-100 MB: Only the `raw` or `object` custom media
types are supported" (with `content` empty and `encoding: "none"` under `object`); "Greater than
100 MB: This endpoint is not supported"; and "This API has an upper limit of 1,000 files for a
directory."

### 3.5 Submodules and LFS

**[VERIFIED]** `GET /repos/{o}/{r}/contents/{path}` on a submodule path returns
`{"type": "submodule", "submodule_git_url": "...", "size": 0, "download_url": null}` - confirmed live
on `grpc/grpc` `third_party/googletest`.

**[VERIFIED] and a genuine trap:** directory listings lie about the type. GitHub's own description:
"When listing the contents of a directory, submodules have their `type` specified as `file`.
Logically, the value _should_ be `submodule`. This behavior exists for backwards compatibility
purposes. In the next major version of the API, the type will be returned as `submodule`." Confirmed
live: `third_party` lists `abseil-cpp`, `benchmark` and `bloaty` as `type: file, size: 0`. Detect a
submodule by re-querying the path, or by reading `.gitmodules`.

**[VERIFIED]** "If the submodule repository is not hosted on github.com, the Git URLs (`git_url` and
`_links["git"]`) and the github.com URLs (`html_url` and `_links["html"]`) will have null values."

**[VERIFIED]** The hard boundary on cross-repository submodules: "The installation access token
cannot be granted access to repositories that the installation was not granted access to." A
submodule inside the installation's granted set is reachable; one outside it is not, and no token
scoping changes that. **[INFERRED]** `git clone --recurse-submodules` with an installation token is
not a documented flow, but it works mechanically if git is told to reuse the credential - which is
what `actions/checkout` does, writing per-submodule `includeIf` config plus an `insteadOf` rewrite of
`git@github.com:` URLs to HTTPS.

**[VERIFIED]** LFS content needs `git lfs pull` / `git lfs fetch --all`; without git-lfs installed
"they will only fetch the pointer files, and won't have access to any of the actual data."
**[VERIFIED, empirically, with an OAuth token]** the LFS batch endpoint accepts Basic auth as
`x-access-token:<token>` - `POST https://github.com/{o}/{r}.git/info/lfs/objects/batch` returned
`200` with credentials and `401 {"message":"Requires authentication"}` without. **[INFERRED]** the
same holds for an installation token, since GitHub documents it as the HTTP password for Git access;
this was not tested with a `ghs_` token.

**[VERIFIED]** LFS quotas, current figures: Free / Pro = **10 GiB** bandwidth and 10 GiB storage per
month; Team / GitHub Enterprise Cloud = **250 GiB** each. The widely repeated "1 GB" figure is
obsolete, and data packs were replaced by metered billing. Critically for a review bot:
"When you **download** a Git LFS file, the bandwidth you use is included in the **repository owner's**
bandwidth usage", and "Forking and pulling a repository counts against the parent repository's
bandwidth usage." **[INFERRED]** Reprove pulling LFS content on every Run spends its *users'* quota,
and exhausting it blocks LFS for the rest of the month for that account. LFS must be opt-in per
repository, not a default step in materialization.

**[VERIFIED]** One measurement worth carrying: for an LFS path, the Contents API `size` field reports
the **pointer's declared size** (469) while the Git Trees API reports the **real blob size** (128) for
the same path on `o3de/o3de`. Do not budget bytes from Contents `size` on LFS paths.

---

## 4. Permission migration

ADR 0013 states the asymmetry this section was written to test: "adding a *permission* later requires
every existing installation to approve it and the App keeps operating under the old grant until they
do, whereas adding an *event subscription* later is free once the gating permission is held."

**Both halves are confirmed.** The ADR is correct. What it does not carry - and what Phase 1 needs -
is *how the App learns the migration landed*, and one consequence of the specific permission it is
about to request.

### 4.1 How the request is made

**[VERIFIED]** [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration):
**Permissions & events**, change the dropdowns, optionally "add a note to users ... telling your users
why you are changing the permissions", **Save changes**. Then, verbatim:

> When you add new **repository**, **organization**, or **enterprise** permissions for an app, each
> account where the app is installed will need to approve the new permissions. ... In both cases,
> GitHub will send an email to each organization owner or user, notifying them of the request to
> update the app's permissions. Updated permissions won't take effect on an installation or user
> authorization until the new permissions are approved. You can use the [installation
> webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads?actionType=new_permissions_accepted#installation)
> to find out when people accept new permissions for your app.

> If you remove permissions or webhooks from your GitHub App, the changes will take effect
> immediately.

**[VERIFIED]** and worth recording because the ADR's phrasing echoes it: the sentence
"Any installation of your app will need to approve the new permissions before your app can use them"
**is no longer in GitHub's docs**. It is retired wording from `editing-a-github-apps-permissions`,
now a redirect. The current equivalent is the paragraph above plus, from
[choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app):
"If the account owner does not approve the new permissions, their installation will continue to use
the old permissions."

**[VERIFIED]** The only documented auto-accept is enterprise-owned: "When an enterprise owner
modifies the permissions of an app owned by an **enterprise account**, the changes are automatically
accepted by organizations in the enterprise."

### 4.2 A manifest cannot perform the migration

**[VERIFIED]** `POST /app-manifests/{code}/conversions` is creation-only: "**When you create a GitHub
App with the manifest flow**, you receive a temporary `code` used to retrieve the GitHub App's `id`,
`pem` (private key), and `webhook_secret`." Status codes are `201` / `404` / `422`. The manifest
flow's terminal state is described as an owner who "can choose to extend the app using the GitHub
APIs, transfer ownership to someone else, or delete it" - create, transfer, delete; no update.

**[VERIFIED]** There is **no** REST or GraphQL surface to change an existing App's
`default_permissions`. The complete Apps REST category is fourteen operations - `GET /app`,
`POST /app-manifests/{code}/conversions`, `GET /app/installation-requests`, `GET|DELETE
/app/installations[/{id}]`, `POST /app/installations/{id}/access_tokens`, `PUT|DELETE
/app/installations/{id}/suspended`, `POST /applications/{client_id}/token/scoped`,
`GET /apps/{app_slug}`, `GET /orgs/{org}/installation`, `GET /repos/{owner}/{repo}/installation`,
`GET /users/{username}/installation`. No `PATCH /app`. Live GraphQL introspection finds no
permission-related mutation either.

**[INFERRED]** and directly about this repository: `packages/control-plane/src/github/manifest.ts` is a
**first-registration artifact only**. Widening `APP_PERMISSIONS` changes nothing on GitHub; it
describes what a *newly created* App would request. For an App that already exists, the live grant is
observable only per-installation, and anything that treats the constant as the live grant will drift
silently. The constant's value as a decision record is unaffected - it is still the right place for a
test to hold the grant to ADR 0013 - but its relationship to reality changes the moment an App is
registered from it.

### 4.3 How an installation approves, and how the App finds out

**[VERIFIED]** The installer sees an email, and a notification:
[approving updated permissions](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app) -
"When a GitHub App requests additional permissions, GitHub will notify you if the app is installed on
your personal account or on an account that you own. You can choose whether to accept the additional
permissions. If you do not approve the additional permissions, the GitHub App will still retain its
current permissions."

**[VERIFIED]** There is **no API to approve**, and **no API that lists which installations have not
yet approved**. `GET /app/installation-requests` is not it - its description is "Lists all the
pending installation requests for the authenticated GitHub App", which is the organization
*request-to-install* flow.

**[UNKNOWN]** What the approval screen itself looks like. GitHub documents no screenshot, no button
label, and no banner location. A community discussion
([195745](https://github.com/orgs/community/discussions/195745), 2026-05-13, no staff reply) asserts
it is a single all-or-nothing "Accept new permissions" button with no per-scope choice; that is a
user's account, not documentation.

**[INFERRED, from four independent verified statements]** `installation.permissions` carries the
**approved** set, not the requested one. The statements: `GET /app/installations` says "The
permissions the installation **has** are included under the `permissions` key"; "Updated permissions
won't take effect on an installation ... until the new permissions are approved"; "their installation
will continue to use the old permissions"; and GitHub recommends the `installation` webhook to "find
out when people accept new permissions". No single sentence says it outright, but the model is
incoherent otherwise.

**[VERIFIED]** The runtime signals therefore available to Reprove:

| Signal | Where | Exact property |
| --- | --- | --- |
| Per-installation effective grant | `GET /app/installations[/{id}]` (App JWT) | `permissions` - "The permissions the installation has" |
| Grant on the token about to be used | `POST /app/installations/{id}/access_tokens` 201 body | `permissions`, described as the actual permissions granted |
| Push notification on approval | `installation` webhook, `action: new_permissions_accepted` | "Someone granted new permissions to a GitHub App." |
| Diagnosing a 403 | `X-Accepted-GitHub-Permissions` response header | see below |

**[VERIFIED]** The token exchange also lets a token be *narrowed*: its body accepts `repositories`,
`repository_ids` and `permissions`, and "If `permissions` is not specified, the installation access
token will have all of the permissions that were granted to the app. **The installation access token
cannot be granted permissions that the app was not granted.**" **[UNKNOWN]** whether asking for an
unapproved permission returns `403` or `422`; the endpoint documents both and GitHub does not say
which applies.

**[VERIFIED]** The header is the cheapest runtime probe there is, from
[troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api):

> If you are using a GitHub App or fine-grained personal access token and you receive a "Resource not
> accessible by integration" ... error, then your token has insufficient permissions. ... You can use
> the `X-Accepted-GitHub-Permissions` header to identify the permissions that are required to access
> the REST API endpoint. ... `X-Accepted-GitHub-Permissions: pull_requests=write,contents=read` means
> that your GitHub App or PAT needs write access to the pull request permission and read access to
> the contents permission.

**[VERIFIED]** During the gap the App keeps the old grant and calls needing the new permission return
`403`: "If your app makes a REST API request with insufficient permissions, the API will return a
`403` response." That is the same `403 Resource not accessible by integration` that
`packages/control-plane/src/github/client.ts` already classifies as `operator_attention` rather than
`transient`. **[INFERRED]** The classification is right, and the un-approved-migration case is
precisely the one it was built for - but "operator attention" for an installation that simply has not
clicked yet deserves its own reason string, because the operator who must act is the *installer*, not
Reprove's.

### 4.4 A private, single-owner App still has to click

**[UNKNOWN] as documentation.** No sentence in `content/apps/**` addresses whether an owner
installing on their own account is exempt.

**[INFERRED]** They are not exempt, on three grounds: every approval sentence is written
per-installation and unqualified; the *only* documented auto-accept is enterprise-owned and is stated
explicitly, which reads as an exception rather than an instance of a broader rule; and the
installer-facing page explicitly contemplates the self-owned case - "GitHub will notify you if the app
is installed on your personal account **or on an account that you own**" - then says "You can choose
whether to accept."

**[INFERRED]** So the Phase 1 migration is cheap but not free and not silent: one click on one
installation, an `installation` / `new_permissions_accepted` delivery that the handler must already
tolerate, and `installation.permissions` that does not widen until the click. ADR 0013's "the
migration cost is currently zero" is right about *cost* and wrong about *automaticity*; nothing
widens on its own. The cheapest way to settle the [UNKNOWN] is to perform the update and watch
whether `installation.permissions` widens before or after a click.

### 4.5 What `Contents: read` actually grants, and what reviews need

**[VERIFIED]** from GitHub's generated permission mapping
([permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)):

- **The entire review write surface is `Pull requests: write` with no additional permission.**
  Create, update, delete, dismiss and submit a review; create, edit and delete review comments;
  request reviewers. **`Contents` is not required to publish a Review.**
- **`GET /repos/{o}/{r}/pulls/{n}/files` is `Pull requests: read` only.** Reprove can read the diff
  and compute anchorability without `Contents`.
- **`POST /repos/{o}/{r}/check-runs` is `Checks: write` with no additional permission.**
- `GET /repos/{o}/{r}/pulls/{n}` (the one call `client.ts` makes today) is listed under **both**
  `contents: read` and `pull_requests: read`, each flagged as having additional permissions - which
  GitHub's own legend says means either "requires more than one" **or** "works with any one of a set",
  without disambiguating. **[INFERRED]** it is the any-one case, since `/files` needs only
  `pull_requests`; if it ever `403`s, read `X-Accepted-GitHub-Permissions` rather than guessing.

**[VERIFIED]** `Contents: read` is 42 endpoints, and it is read-of-the-whole-object-graph, not merely
archive access: `contents/{path}`, `git/blobs`, `git/trees`, `git/commits`, `git/ref`,
`git/matching-refs`, `readme`, `commits`, `commits/{ref}`, `compare/{basehead}`, `branches`,
`tarball/{ref}`, `zipball/{ref}`, the dependency graph and SBOM, releases, CodeQL databases,
`codeowners/errors`. **[VERIFIED]** and surprising: `POST /repos/{o}/{r}/commits/{commit_sha}/comments`
is classified under **`contents: read`** - so `Contents: read` carries one write side effect, the
ability to post commit comments.

**[VERIFIED]** For Git over HTTPS the docs are explicit: "If you want your app to use an installation
or user access token to authenticate for HTTP-based Git access, you should request the **'Contents'**
repository permission."

**[INFERRED]** `Contents: read` can read `.github/workflows/*.yml`. The `Workflows` permission maps to
exactly six endpoints, **all write-level** (`PUT|DELETE /contents/{path}`, `POST|PATCH /git/refs`,
`POST|PATCH /releases`); there is no read-side `Workflows` requirement anywhere, while
`GET /contents/{path}` needs `contents: read` with no additional permission. The prose in
"choosing permissions" says "If your app specifically needs to **access or edit** Actions files ...
request the 'Workflows' repository permission", which over-states the machine-readable mapping. The
mapping is the operative behaviour.

### 4.6 The subscription the migration turns on without asking

**[VERIFIED]** Adding an *event* needs no approval: the approval trigger is written exclusively about
permissions, the "Changing the webhook event subscriptions" procedure carries no approval note, and
the UI gates event selection on permission - "If you did not select sufficient permissions for your
GitHub App to subscribe to an event, the event will not appear as an option on your app registration
page."

**[VERIFIED]** But the reverse is also true, and it is not free: **write-level `Checks` auto-subscribes
the App**. "GitHub Apps with write-level access for the 'Checks' permission are automatically
subscribed to this webhook event" appears on both `check_run` and `check_suite`. Combined with
"By default, GitHub creates a check suite automatically when code is pushed to the repository. This
default flow sends the `check_suite` event (with `requested` action) to all GitHub Apps that have the
`checks:write` permission", the consequence is concrete:

**[INFERRED]** ADR 0013's "one explicit subscription, three unconditional arrivals" becomes **five**
the moment `Checks: write` is approved, and one of the two new ones - `check_suite.requested` -
arrives **on every push to the repository**, not only on pull request activity. A handler that
"switches explicitly on event type and ignores what it does not handle" survives this; a ledger that
records an envelope per delivery does not survive it for free, because the delivery volume on a busy
repository is now push-shaped rather than pull-request-shaped. Opting out is possible only by a
repository **admin** (`PATCH /repos/{o}/{r}/check-suites/preferences`, "You must have admin
permissions in the repository to set preferences for check suites"), which is not something Reprove
can do for its installers.

---

## 5. Manual triggers under the existing subscription

This section answers what [#108](https://github.com/nick-neely/reprove/issues/108) needs: which
deliberate human gesture can start a Run **without** widening the grant or adding a subscription.

### 5.1 The event, and what an App may filter

**[VERIFIED]** `pull_request` has **22** actions today: `assigned`, `auto_merge_disabled`,
`auto_merge_enabled`, `closed`, `converted_to_draft`, `demilestoned`, `dequeued`, `edited`,
`enqueued`, `labeled`, `locked`, `milestoned`, `opened`, `ready_for_review`, `reopened`,
`review_request_removed`, `review_requested`, `stacked`, `synchronize`, `unassigned`, `unlabeled`,
`unlocked`.

**[VERIFIED]** `stacked` ("A pull request was added to a stack.") is in GitHub's current webhook data
and OpenAPI but **absent from `octokit/webhooks` payload-schemas**, which still ships 21. Typing
payloads from `@octokit/webhooks-types` means `stacked` arrives unmodelled. This is a live instance
of the reason ADR 0013 already gives for switching explicitly rather than assuming a closed set.

**[VERIFIED]** The gate is exactly what ADR 0013 says: "To subscribe to this event, a GitHub App must
have at least read-level access for the 'Pull requests' repository permission."

**[VERIFIED]** Subscription is **event-level only**. The App registration UI offers event names; the
API models subscriptions as `events: array of string`; and GitHub's own best-practices page tells you
to filter yourself: "Your application should check the event type and action of a webhook payload
before processing the payload. To determine the event type, you can use the `X-GitHub-Event` request
header. To determine the action type, you can use the top-level `action` key in the event payload."
There is no action-level subscription anywhere in the webhook config schema.

**[VERIFIED]** `installation` is present on `pull_request` deliveries to an App. The
`simple-installation` schema's own description: "Webhook payloads contain the `installation` property
when the event is configured for and sent to a GitHub App." Shape is `{id, node_id}`, both required,
and it appears as an optional top-level property on every `pull_request` action schema - optional
because the same body is also delivered to repository and organization webhooks, which have no
installation.

**[VERIFIED]** Delivery headers: `X-GitHub-Event` (the event name only - there is no action header),
`X-GitHub-Delivery`, `X-Hub-Signature-256`, `X-Hub-Signature` (SHA-1, "provided for compatibility ...
We recommend that you use the more secure `X-Hub-Signature-256` instead"), `X-GitHub-Hook-ID`,
`X-GitHub-Hook-Installation-Target-Type`, `X-GitHub-Hook-Installation-Target-ID`, and a `User-Agent`
that "will always have the prefix `GitHub-Hookshot/`".

### 5.2 `labeled` / `unlabeled`

**[VERIFIED]** Both carry a top-level `label` object (`id`, `node_id`, `url`, `name`, `color`
- "6-character hex code, without the leading #" - `default`, `description` (nullable), `archived_at`,
`archived_by`), the full `pull_request` object, `repository`, `sender`, and `installation`.

**[VERIFIED]** `label` is **not** in the schema's `required` list for either action; the required set
is `action`, `number`, `pull_request`, `repository`, `sender`. Treat `payload.label` as possibly
absent.

**[VERIFIED]** The `pull_request` object on these deliveries is the full one: `head` and `base` are
required and each requires `["label","ref","sha","user","repo"]`, and `draft`, `state`, `locked`,
`merged_at`, `merge_commit_sha`, `labels`, `requested_reviewers` and `requested_teams` are all
required. `merged` is present, **not** required, and nullable. **[VERIFIED]** `merge_commit_sha` is
scheduled for removal under the `2026-03-10` breaking-change version
(`remove_pull_request_merge_commit_sha`) - relevant because ADR 0013's canonical fetch and the
webhook envelope both touch pull request fields.

**[VERIFIED]** `sender` is the actor, with a documented caveat GitHub asks you to honour: "Sometimes
GitHub can't resolve a specific user ... In these cases, `sender` is populated with the `ghost` user
... **Don't assume `sender` always identifies the person who caused an event**, and account for the
`ghost` user in any security or business logic that relies on it." A label-driven trigger that
authorizes on `sender` must handle `ghost`.

**[VERIFIED]** One delivery per label; there is no coalescing. The payload carries a single `label`,
so N labels structurally require N deliveries. Observed live on this repository: issue 87 shows
`unlabeled needs-triage`, `labeled enhancement` and `labeled ready-for-agent` all at
`2026-09-09T13:00:42Z`, three events in one second from one UI action.

**[VERIFIED]** Duplicates are real. `nick-neely/reprove` PR 93 (Dependabot) shows **four** `labeled`
events for **two** labels, at `10:19:03`, `10:19:03`, `10:19:03` and `10:19:04`. Any label trigger
must be idempotent - which ADR 0013's `(installation, repo, pr, head_sha)` semantic key already makes
it, provided the label gesture does not become a *second* uniqueness axis.

**[VERIFIED]** Labels applied by a bot fire the event: PR 93's and PR 92's `labeled` events carry
`actor = dependabot[bot]`, `actor.type = "Bot"`.

**[INFERRED]** A pull request opened with labels already applied produces a separate `labeled` event
a second later. Observed three times on this repository (issue 105 created `19:51:20Z`, labelled
`19:51:21Z`; issue 5 `16:35:07Z` / `16:35:08Z`; PR 93 `10:19:02Z` / `10:19:03Z`). The timeline and
the webhook stream are different surfaces, so this is inference, not verification. **[VERIFIED]** the
safer path exists regardless: `pull_request.labels` is already populated on `opened`, so a handler
can detect the trigger label without waiting for `labeled` at all.

### 5.3 `review_requested` / `review_request_removed`

**[VERIFIED]** The schema is a `oneOf` over exactly two branches: one requiring `requested_reviewer`
(a `title: "User"` object, nullable, carrying `login`, `id`, `node_id`, `type`, `html_url` and a
`deleted` flag), one requiring `requested_team` (a `title: "Team"` object). Exactly one appears per
delivery; requesting N reviewers produces N deliveries. `sender` is the requester.

**[VERIFIED]** Team requests fire the event - "Review by a person or team was requested for a pull
request" - but fan out under code review assignment: "If you request a review from a team and code
review assignment is enabled, specific members will be requested and the team will be removed as a
reviewer."

**[VERIFIED]** Who may request: "To request a review, you need write access to the repository. You can
request a review from a person or team with read access to the repository". So the gesture is already
restricted to people who can push - a useful property for a trigger.

**[VERIFIED]** A re-request after the reviewer has reviewed **fires a second `review_requested`**.
Observed live: `tekdi/eg-website` PR 2020 carries `review_requested` for `coderabbitai[bot]` at
`2024-08-08T14:15:52Z`, a submitted `reviewed` event by that bot, then a **second**
`review_requested` for the same reviewer at `15:30:58Z`, with no `review_request_removed` between
them and the same human actor both times. The gesture is therefore repeatable once the request has
been consumed by a review - which is exactly the shape a "run it again" trigger needs.

### 5.4 Requesting a review from a GitHub App

This is the question the ticket asks, and the answer has three parts that must not be collapsed.

**(a) A Bot can be a requested reviewer. [VERIFIED]** GraphQL's `RequestedReviewer` union is
`Bot | EnterpriseTeam | Mannequin | Team | User`, and `RequestReviewsInput` carries `botIds` ("The
Node IDs of the bot to request") alongside `userIds` and `teamIds`. Live data confirms it is not
theoretical: `microsoft/vscode` PR 336195 (state `OPEN`) has
`requestedReviewer: {__typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_kgDOCnlnWA",
databaseId: 175728472}`.

**(b) REST can write it but cannot read it. [VERIFIED]** GitHub documents the write path only on the
Copilot page: "You can also request a review from Copilot through the GitHub REST API by requesting
`copilot-pull-request-reviewer[bot]` as a reviewer." The REST reference for
`POST /repos/{o}/{r}/pulls/{n}/requested_reviewers` describes only `reviewers` ("An array of user
`login`s") and `team_reviewers`, mentions no bots, and returns `422 Unprocessable Entity if user is
not a collaborator`. And the read path **omits bot reviewers entirely** - verified independently on
an open pull request:

```text
$ gh api graphql ... microsoft/vscode PR 336195
{"requestedReviewer":{"__typename":"Bot","login":"copilot-pull-request-reviewer", ...}}

$ gh api repos/microsoft/vscode/pulls/336195 --jq '.requested_reviewers'
[]
```

The `pull-request-review-request` response schema is `{users, teams}` - there is no bot array to put
one in. The **Issue timeline** does render it, as a user-shaped object with `type: "Bot"` and an
`html_url` under `/apps/<slug>`; so does the search qualifier `review-requested:<slug>[bot]`.

**[INFERRED]** Note the login aliasing across surfaces for one actor: GraphQL `Bot.login` is
`copilot-pull-request-reviewer`, the timeline's `requested_reviewer.login` is `Copilot`, and the REST
write path expects `copilot-pull-request-reviewer[bot]`. The stable identifiers are the numeric id
and the node id.

**(c) Third-party Apps were requestable, and appear not to be now. [VERIFIED as observation]** The
search index carries real, currently-pending Bot review requests for two third-party Apps:

| Requested reviewer | Pull requests indexed | Newest by pull request creation | On a pull request created after 2025-06-01 |
| --- | --- | --- | --- |
| `copilot-pull-request-reviewer[bot]` | 20,631 | 2026-09-14 (today) | **5,450** |
| `coderabbitai[bot]` | 63 | 2024-08-08 | **0** |
| `sourcery-ai[bot]` | 14 | 2024-08-08 | **0** |
| `codecov[bot]`, `gemini-code-assist[bot]`, `cursor[bot]`, `devin-ai-integration[bot]`, `claude[bot]`, `dependabot[bot]`, `renovate[bot]` | 0 | - | 0 |

Two of those were spot-checked through GraphQL and the Issue timeline and are genuine: on
`prowide/prowide-iso20022` PR 125 a **human user** (`ptorres-prowide`, `type: "User"`) requested
`coderabbitai[bot]` on 2024-08-07, and on `tekdi/eg-website` PR 2020 a human requested it twice on
2024-08-08.

**[INFERRED]** Third-party App reviewer requests were possible at least through August 2024 and are
not happening now. A community feature request,
[193037](https://github.com/orgs/community/discussions/193037) (2026-04-18, unanswered), reports
`requestReviewsByLogin` failing with `Could not resolve user with login 'APP_NAME[bot]'` for a
third-party App, and `gh`'s own source hard-codes a single bot reviewer
(`const CopilotReviewerLogin = "copilot-pull-request-reviewer"`), routing only that one login into its
bot-reviewer bucket and silently dropping bot reviewers on the id-based path. **[UNKNOWN]** whether
GitHub closed a path, whether an allowlist exists, or what it contains; GitHub publishes nothing.

**[VERIFIED as a negative]** There is no reviewer-suggestion API to check against:
`Repository.suggestedActors` accepts only `CAN_BE_ASSIGNED` and `CAN_BE_AUTHOR` - there is no
`CAN_BE_REVIEWER` capability.

**[UNKNOWN] and load-bearing.** Whether a `pull_request` / `review_requested` **webhook** is delivered
at all when the requested reviewer is a Bot, and what `requested_reviewer` contains if so. The
evidence points both ways: the webhook `requested_reviewer` uses the shared user schema whose `type`
enum is `["Bot", "User", "Organization"]`, and the REST timeline does render a Bot reviewer in that
exact shape - but REST's `requested_reviewers` demonstrably strips bots, so the webhook might too.
Settling it requires a write. **Do not build on it without testing it first.**

### 5.5 What each gesture actually costs

Everything in the top block is already covered by the existing `pull_request` subscription and
`Pull requests: read`. Nothing in it needs a permission change.

| Gesture | Action delivered | Repeatable | Cost |
| --- | --- | --- | --- |
| **Add a trigger label** | `labeled` (+ `unlabeled` to reset) | Yes, cleanly | Needs a label to exist; collides with triage labelling; duplicate deliveries observed |
| **Request a review from a human** | `review_requested` | Yes, after the review lands (§5.3) | Notifies a real person every time (`triggersNotification: true`) |
| **Request a review from the App** | `review_requested` | Presumed | **Delivery unverified (§5.4); third-party support unverified** |
| Draft to ready | `ready_for_review` | Only via a draft round trip | Mutates pull request state that CI and branch protection see |
| Close and reopen | `closed`, `reopened` | Yes | Very noisy; may cancel in-flight CI |
| Empty commit | `synchronize` | Yes | Pollutes history; re-runs everything; indistinguishable from a real push |
| Edit title or body | `edited` | Yes | ADR 0013 makes `edited` inert **deliberately** (ADR 0012); reopening it would hand the Author a free re-roll |

Alternatives that need a new subscription, split by whether they also need a new permission -
**[VERIFIED]** from each event's permission sentence:

| Event | New permission needed? |
| --- | --- |
| `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | **No** - all three are "at least read-level access for the 'Pull requests' repository permission", which the App already holds |
| `issue_comment` (the classic `/review` slash command) | Yes - `Issues: read`, which grants read of **every** issue in the repository |
| `check_run.rerequested`, `check_suite.rerequested` | Yes - `Checks: **write**`, which also auto-subscribes the App (§4.6) |
| `workflow_dispatch` | Yes - `Contents: read` |

**[INFERRED]** and worth stating plainly because it inverts the usual assumption: the conventional
slash-command design (`issue_comment`) is the **expensive** one. A slash command posted as a *review
comment* or in a *review body* reaches the App through `pull_request_review_comment` or
`pull_request_review` at the cost of a subscription and **no new permission at all**. For a product
whose central claim is credential minimalism, that difference is not a detail.

---

## What this means for Reprove

### Where the decision record is confirmed

Three decisions come out of this unchanged and now better evidenced, which is worth recording because
they were each reasoned from first principles rather than from GitHub's documentation.

- **ADR 0002's `COMMENT` default is right for the stated reason.** `REQUEST_CHANGES` is "purely
  informational and will not prevent merging unless a ruleset or classic branch protection rule is
  configured", and where such a rule exists it blocks "until the same collaborator submits another
  review approving the changes" (§1.5). A first install genuinely can block a team's merges, and only
  a write-capable human can clear it.
- **ADR 0007's Check mapping is right, and its rejected alternative is now measured rather than
  argued about.** `neutral` and `skipped` **count as passing** for a required check (§2.5), stated
  twice in GitHub's own docs. Returning `neutral` for a timed-out Run would have made a required
  Reprove check unfalsifiable - "quietly void that choice", in the ADR's words - which is exactly
  what it predicted without being able to cite it.
- **ADR 0013's permission/subscription asymmetry is confirmed on both halves** (§4.1, §4.6): adding a
  permission needs per-installation approval and the old grant persists until then; adding an event
  needs none, provided the gating permission is held.

### Where it is wrong, or under-specified

**ADR 0007, "Findings outside the diff", is under-specified.** It says "GitHub cannot line-anchor a
review comment on a file the diff never touched." The real constraint is narrower and bites harder:
a comment must fall inside a `@@` **hunk** (§1.2). A Finding on line 900 of a file whose only hunk is
lines 10-20 is equally unanchorable, and that is a far more common case than an untouched file. The
ADR's rule still produces the right *behaviour* - render it structurally in the Review body - but the
population it governs is much larger than the text implies, and the sentence should be corrected
before anyone implements against it.

**ADR 0007 states a permission Reprove does not hold.** Its justification for `anchoredText` says
"the control plane already holds `contents: read`". It does not: `APP_PERMISSIONS` is
`{metadata: read, pull_requests: read}`, and ADR 0013 defers `Contents: read` to Phase 1 explicitly.
The good news is that most of what ADR 0007 needs does not require it - `GET /pulls/{n}/files`
carries the `@@` hunks under `Pull requests: read` alone (§1.2, §4.5) - but the per-file anchor
re-check at publish time genuinely does need `Contents: read`, and it needs to respect that
endpoint's 1 MB / 100 MB / 1,000-file bounds (§3.4).

**ADR 0013's arrival list gets longer the moment the grant widens.** "One explicit subscription,
three unconditional arrivals" becomes **five** when `Checks: write` is approved, because write-level
Checks auto-subscribes the App to `check_run` and `check_suite`, and `check_suite.requested` fires
**on every push**, not only on pull request activity (§4.6). The event switch already tolerates this;
the delivery ledger's volume assumptions may not, and opting out is a repository-admin action Reprove
cannot take on an installer's behalf.

**ADR 0013's merge-base derivation depends on a depth nobody has chosen yet.** "Given a pinned base
tip and a pinned head, the merge base is deterministic and computed there" is true only if the
Workspace contains enough history. At `--depth=1` with both commits present, `git merge-base` printed
**nothing** and exited `1` where a full clone printed the right answer (§3.3), and the depth needed
is a function of divergence, not a constant. ADR 0004 deferred "the depth" as a separate decision;
this research says that decision cannot be a number. Either the Workspace carries full history, or
the merge base is resolved from `GET /repos/{o}/{r}/compare/{basehead}` (which returns
`merge_base_commit.sha`, verified live) and fetched explicitly - which is the call ADR 0013 rejected
at ingress for dragging in `Contents: read`, an objection Phase 1 dissolves.

**ADR 0004's credential stripping rules out partial clone entirely.** `--filter=blob:none` keeps
commits and trees but fetches blobs lazily from the promisor remote; strip the remote as ADR 0004
requires and `git blame` and content-level `git diff` both fail hard, while `git log`, `git merge-base`
and `git diff --name-only` keep working (§3.3). And shallow clone is worse than useless for blame: it
does not error, it attributes every line to the graft commit. The only shape that satisfies ADR 0004
as written is a **full clone** - or an explicit decision to give up `git blame` in the Sandbox and
serve it from GraphQL `Commit.blame(path:)` instead (§3.4), which ADR 0004's own "resolve submodules
and LFS host-side if they are needed at all" already establishes as an acceptable pattern.

### The option nobody priced

**Check Run annotations anchor anywhere.** They carry `path`, `start_line`, `end_line` and optional
columns, with no diff-membership requirement, and render in the Checks tab regardless of the diff;
the Files changed tab additionally renders those whose file is part of the pull request (§2.3). That
is precisely the location statement ADR 0007 concluded GitHub could not give it.

This is not a recommendation to adopt them. It is a finding that the option exists, was never
weighed, and is currently foreclosed by vocabulary rather than by a decision: `CONTEXT.md` lists
`annotation` under **Comment**'s *Avoid* line. The real trade-offs are worth naming so that whoever
decides can decide rather than inherit:

- **For:** an exact `path:line` for a Finding that has none today; 50 per request and no documented
  total ceiling; no notification spam, since annotations do not trigger review notifications; and
  Reprove is already publishing a Check.
- **Against:** it splits one review across two surfaces, which is the exact objection ADR 0007 used to
  reject a separate issue comment; annotations are not threads, cannot be replied to or resolved, and
  have no dedupe story across Runs; and they disappear with the Check Run, which is per-head-SHA
  (§2.1) and subject to a 400-day retention window (§2.5).

### Concrete consequences for Phase 1

1. **Compute anchorability locally before publishing.** A single unanchorable comment fails the whole
   `createReview` call with a `422` that does not name the offender (§1.2). Parse the hunk headers
   from `GET /pulls/{n}/files` - `Pull requests: read`, 3000-file cap - and partition Findings into
   Comments and body entries before the request is built, never after a rejection.
2. **Parse both error shapes.** `POST /pulls/{n}/reviews` returns `errors` as plain strings;
   `POST /pulls/{n}/comments` returns objects (§1.2).
3. **Batch into one review.** One `createReview` with N comments is one content-generating request;
   N standalone comments are N, against a 500-per-hour secondary limit (§1.4).
4. **Identify the App by `user.id`.** Reviews carry no `performed_via_github_app` (§1.6).
5. **Guard self-review by identity, not by error.** Compare `pull_request.user.id` to the App's bot
   user id and degrade to `COMMENT` (§1.5).
6. **One Check Run per Run, and carry your own pull request handle.** `head_sha` is immutable on
   PATCH (§2.1), and `check_run.pull_requests[]` is **empty for fork pull requests** (§2.4), so a
   `rerequested` delivery cannot be resolved back to a pull request without `external_id`.
7. **Handle `stale`.** A Check Run left incomplete for 14 days is concluded `stale` by GitHub - a
   value ADR 0007's status mapping never produces (§2.1).
8. **Decide the Workspace shape as a correctness question, not a bandwidth one** (§3.3).
9. **The migration is one click, not zero.** Nothing widens until an installer - including the
   single-owner one - accepts. Detect it from `installation.permissions`, the token response's
   `permissions`, the `installation` / `new_permissions_accepted` webhook, and
   `X-Accepted-GitHub-Permissions` on a `403` (§4.3, §4.4). `manifest.ts` describes a *new*
   registration and cannot perform the change (§4.2).
10. **For the manual trigger (#108), a label is the safe default and a review comment is the cheap
    surprise.** `labeled` needs no new permission and no new subscription, is repeatable, carries the
    actor, and delivers one event per label with observed duplicates (§5.2). If a slash command is
    wanted, `pull_request_review_comment` and `pull_request_review` cost a subscription and **no new
    permission**, where the conventional `issue_comment` route costs `Issues: read` over every issue
    in the repository (§5.5). Requesting a review from the App is real but only demonstrably works for
    Copilot today, is invisible to REST, and its webhook delivery is unverified - do not build on it
    without testing it first (§5.4).

---

## Residual uncertainty

Ordered by how much a wrong guess would cost.

- **[UNKNOWN] Whether a `review_requested` webhook is delivered at all when the requested reviewer is
  a Bot, and what `requested_reviewer` carries if so** (§5.4). The webhook uses the shared user schema
  whose `type` enum includes `"Bot"`, and the REST *timeline* renders a Bot reviewer in exactly that
  shape - but REST's `requested_reviewers` strips bots entirely. Settling it needs one write against a
  scratch repository. #108 must not choose this surface until it is settled.
- **[UNKNOWN] Whether third-party GitHub Apps are still requestable as reviewers** (§5.4). Real
  pending requests exist for `coderabbitai[bot]` and `sourcery-ai[bot]`, none on a pull request
  created after 2025-06-01, while Copilot's are current. GitHub documents no allowlist and no change.
- **[UNKNOWN] Whether a private, single-owner App's permission update is auto-approved** (§4.4). The
  docs are silent; the only documented auto-accept is enterprise-owned. Settled by performing the
  update and watching whether `installation.permissions` widens before or after a click.
- **[UNKNOWN] Whether an App can update a Check Run it did not create** (§2.1). Consistently reported
  as `403 ... check run can only be modified by the GitHub App that created it`, and completely absent
  from GitHub's documentation.
- **[UNKNOWN] The maximum review `body` length and the maximum `comments[]` per review** (§1.4).
  Neither is documented and neither appears in the schema. The 65,536 figure is only ever observed
  against `IssueComment`.
- **[UNKNOWN] The total annotations per Check Run** (§2.2). Only the per-request 50 is documented.
- **[UNKNOWN] Whether `REQUEST_CHANGES` is blocked on your own pull request** the way `APPROVE` is
  (§1.5).
- **[UNKNOWN] Whether GraphQL `addPullRequestReviewThread` relaxes the hunk constraint** that REST
  enforces (§1.2), and whether a `subject_type: file` comment can target a file outside the diff.
- **[UNKNOWN] Whether a check-run write counts as "content-generating"** for the 80/minute and
  500/hour secondary limit (§2.5).
- **[UNKNOWN] Whether an in-flight `git clone` survives installation-token expiry** (§3.2).
- **[UNKNOWN] Whether fetch-by-SHA is a supported guarantee.** Proven at the protocol layer and
  depended on by `actions/checkout`, never documented by GitHub (§3.2).
- **[UNKNOWN] Whether archive downloads are genuinely free of the rate limit.** Observed unauthenticated;
  the authenticated repeat was inconclusive (§3.1).
- **[UNKNOWN] Whether a GitHub App receives webhooks for actions it performed itself** - relevant if
  Reprove ever applies its own trigger label (§5.2).
- **[UNKNOWN] Whether the rulesets doc's `statuses:write` requirement for pinning an App as a
  required-check source is accurate or a documentation error** (§2.5).
- **[INFERRED, not stated in one sentence] That `installation.permissions` is the approved rather
  than the requested set** (§4.3). Four verified statements force the reading; none says it outright.

Two smaller ones worth carrying: `merge_commit_sha` on the pull request payload is scheduled for
removal under the `2026-03-10` breaking-change version (§5.2), and `pull_request.stacked` exists in
GitHub's current schema but not in `@octokit/webhooks-types` (§5.1).

---

## Sources

Everything below was fetched or executed during this session. Nothing is from training data.

**GitHub's own machine-readable descriptions**

- [`github/rest-api-description`](https://github.com/github/rest-api-description) `main`,
  `descriptions/api.github.com/api.github.com.json`, `info.version` 1.1.4 - request and response
  schemas for pulls, reviews, review comments, checks, contents, apps, and the webhook payloads.
- [`github/docs`](https://github.com/github/docs) `main` - `content/**` Markdown, and the generated
  data the reference pages render from: `src/rest/data/fpt-2022-11-28/*.json`,
  `src/github-apps/data/fpt-2022-11-28/{fine-grained-pat,server-to-server}-permissions.json`,
  `src/webhooks/data/fpt/*.json`, `data/reusables/**`, `data/ui.yml`, `data/variables/large_files.yml`.
- The public GraphQL schema at `https://docs.github.com/public/fpt/schema.docs.graphql`, plus live
  introspection through `gh api graphql` for `PullRequestReviewEvent`,
  `AddPullRequestReviewThreadInput`, `AddPullRequestReviewInput`, `RequestReviewsInput`,
  `RequestedReviewer`, `RepositorySuggestedActorFilter`, `ResolveReviewThreadInput`.
- [`octokit/webhooks`](https://github.com/octokit/webhooks) `payload-schemas/` and
  `payload-examples/` - used to read the shared `common/user.schema.json` `type` enum and real
  delivered payload shapes. Second-party: generated from real deliveries, not authored by GitHub.

**GitHub documentation pages**

- REST: [pulls](https://docs.github.com/en/rest/pulls/pulls),
  [reviews](https://docs.github.com/en/rest/pulls/reviews),
  [review comments](https://docs.github.com/en/rest/pulls/comments),
  [review requests](https://docs.github.com/en/rest/pulls/review-requests),
  [check runs](https://docs.github.com/en/rest/checks/runs),
  [check suites](https://docs.github.com/en/rest/checks/suites),
  [repository contents](https://docs.github.com/en/rest/repos/contents),
  [apps](https://docs.github.com/en/rest/apps/apps),
  [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
  [troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api),
  [permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
- Apps: [choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
  [modifying a registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration),
  [approving updated permissions](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app),
  [registering from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
  [authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation),
  [building CI checks](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-ci-checks-with-a-github-app).
- Webhooks: [events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
  [best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
- Pull requests: [approving with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews),
  [status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks),
  [troubleshooting required status checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
  [checking out pull requests locally](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/checking-out-pull-requests-locally),
  [about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- Repositories: [repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits),
  [about large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github),
  [Git LFS objects in archives](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-git-lfs-objects-in-archives-of-your-repository),
  [downloading source code archives](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives).
- Copilot: [using Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review).

**GitHub changelog and engineering blog** (first-party, dated)

- [Files changed supports commenting on unchanged lines](https://github.blog/changelog/2025-09-25-pull-request-files-changed-public-preview-now-supports-commenting-on-unchanged-lines/), 2025-09-25.
- [Improved Files changed page on by default](https://github.blog/changelog/2026-01-22-improved-pull-request-files-changed-page-on-by-default/), 2026-01-22.
- [X-Accepted-GitHub-Permissions header](https://github.blog/changelog/2023-08-10-x-accepted-github-permissions-header-for-fine-grained-permission-actors/), 2023-08-10.
- [Get up to speed with partial clone and shallow clone](https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/), 2020-12-21, updated 2021-04-28.

**Live read-only API observations** (`gh api` GET, `gh api graphql` queries only)

- Review and review-comment payload shapes: `repos/nick-neely/reprove/pulls/*/reviews` and
  `/comments`, plus bot-authored reviews in `elastic/kibana`, `microsoft/vscode`.
- Bot reviewer requests: `repos/github/docs`, `repos/microsoft/vscode`,
  `repos/prowide/prowide-iso20022`, `repos/tekdi/eg-website`, and
  `search/issues?q=is:pr review-requested:<slug>[bot]` across eleven App slugs.
- Check run shapes: `repos/nick-neely/reprove/commits/{sha}/check-runs`.
- Diff shape and limits: `repos/nick-neely/reprove/pulls/89/files`.
- Timelines for label and reviewer events: `repos/nick-neely/reprove/issues/{5,87,92,93,105}/timeline`.
- Submodule and LFS shapes: `repos/grpc/grpc/contents/third_party*`, `repos/o3de/o3de/contents/*`.

**Local git measurements** (against `github.com`, in a scratch directory outside any checkout)

- `git fetch --depth=1 origin <full-sha>`, `--filter=blob:none`, `--filter=tree:0`,
  `--shallow-since`, `git merge-base`, `git blame`, `git diff`, `git show`, and
  `tar tzf` of a repository archive - the matrix in §3.3 and the archive measurements in §3.1.

**Non-GitHub-authored, used only as observation and labelled as such**

- [community discussion 32859](https://github.com/orgs/community/discussions/32859),
  [145141](https://github.com/orgs/community/discussions/145141),
  [143197](https://github.com/orgs/community/discussions/143197),
  [193037](https://github.com/orgs/community/discussions/193037),
  [195745](https://github.com/orgs/community/discussions/195745) - all unanswered by GitHub staff.
- [fleetdm/fleet#38750](https://github.com/fleetdm/fleet/issues/38750),
  [actions/github-script#318](https://github.com/actions/github-script/issues/318),
  [github/rest-api-description#4290](https://github.com/github/rest-api-description/issues/4290),
  [PyGithub#3038](https://github.com/PyGithub/PyGithub/issues/3038).
- [`actions/checkout`](https://github.com/actions/checkout) `src/ref-helper.ts`,
  `src/git-command-manager.ts`, `src/git-auth-helper.ts`; [`cli/cli`](https://github.com/cli/cli)
  `api/queries_repo.go`, `pkg/cmd/pr/shared/params.go`.
