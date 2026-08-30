# What each provider actually says about subscription auth, usage, and automation

Research for [#9](https://github.com/nick-neely/reprove/issues/9) (child of the foundation map [#1](https://github.com/nick-neely/reprove/issues/1)).
Verified 2026-08-29 by fetching the primary vendor pages directly. Every quote below is
verbatim from the cited URL.

This note exists because the Native Auth Route's usage model is a **positioning claim**
([`docs/prd.md`](../prd.md) §38), and a positioning claim that rests on provider terms needs a
citation rather than a recollection. Re-verify before relying on it after ~2026-11; vendors
change these pages without notice.

Claims are tagged **[V]** verified (raw page fetched, quote exact) or **[I]** inferred.

---

## 1. Verdict

**[V] The usage claim is true as stated, for both major Harnesses.** Subscription-authenticated
CLI usage draws on the plan's included allowance; API-key authentication is a separate,
separately-billed path. Both vendors document this explicitly, and Anthropic documents it from
the inverse direction (an `ANTHROPIC_API_KEY` in the environment *silently* diverts Claude Code
off the subscription and onto API billing).

**[V] Anthropic's carve-out is broader than previously recorded**, and it explicitly survives
platform hosting - with conditions Reprove already satisfies by construction.

**[V] But Anthropic's position is actively in flux and currently paused mid-change.** It has
moved four times in seven months (§5). The **unmodified-CLI carve-out Reprove depends on has
not moved**, and the reversals concern Agent SDK and third-party-app usage, which the Native
Auth Route does not use - but nothing here should be described as settled.

**[V] OpenAI's automation guidance is more cautionary than previously recorded** - API keys are
its recommended default for automation - **but its public/open-source warning is scoped to a
specific pattern Reprove does not use**, and must not be read as a general restriction. See §5,
which was corrected after an initial over-reading.

---

## 2. Codex / OpenAI

**Inclusion. [V]** *"Codex is included across ChatGPT plans, including Free and Go. Usage
limits vary by plan."*
([help.openai.com](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan))

**Included usage is consumed first. [V]** *"Your plan's included usage is used first. After you
hit plan limits, usage draws from your credit balance."* Also: *"For Plus and Pro, supported
agentic features, including Codex, ChatGPT Work, and ChatGPT for Excel, can draw from the same
agentic usage allowance."*
([help.openai.com](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-freegopluspro))

**Overflow exists and is not API credit. [V]** *"Eligible Plus and Pro users can buy credits
without changing plans."* … *"These credits are not API credits."* (same page)

**API-key auth is a separate billing path. [V]** *"OpenAI bills API key usage through your
OpenAI Platform account at standard API rates."* … *"When you sign in with an API key, Codex
uses standard API pricing instead of included ChatGPT plan credits."*
([learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth))

**Not verified.** Numeric allowances per plan. The Help Center deliberately defers to the
pricing page rather than stating fixed figures, so **no numeric allowance should ever be
quoted in Reprove's docs.**

## 3. Claude Code / Anthropic

**Inclusion. [V]** *"With Pro and Max plans, you now have access to both Claude on the web,
desktop, and mobile apps and Claude Code in your terminal with one unified subscription."*
([support.claude.com](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan))

**Limits are pooled, not separate. [V]** *"Both Pro and Max plans offer usage limits that are
shared across Claude and Claude Code, meaning all activity in both tools counts against the
same usage limits."* (same page)

**[I] This matters more for Reprove than the equivalent Codex fact.** A review Run on a
self-hosted Worker consumes the *same* pool the developer uses for their own interactive work.
Unattended reviews can therefore degrade a human's own Claude experience in a way that is not
obvious from the Reprove UI. Rate limits and concurrency caps on the Native Route are a
product concern, not only an infrastructure one.

**An API key silently overrides the subscription. [V]** *"If you have an ANTHROPIC_API_KEY
environment variable set on your system, Claude Code will use this API key for authentication
instead of your Claude subscription (Pro, Max, Team, or Enterprise plans), resulting in API
usage charges rather than using your subscription's included usage."* (same page)

**[I] Reprove must not set `ANTHROPIC_API_KEY` in a Native Auth Route Worker's environment**,
and should detect and warn when one is present, or a user who configured the Native Route to
use their subscription will be billed API rates without being told.

**Subscription and Console are separate products. [V]** *"A paid Claude subscription enhances
your chat experience but doesn't include access to the Claude API or Console."*
([support.claude.com](https://support.claude.com/en/articles/9876003-i-subscribe-to-a-paid-claude-ai-plan-why-do-i-have-to-pay-separately-for-api-usage-on-console))

## 4. OpenCode

**[V]** Three coexisting and genuinely distinct paths:

- **BYOK, the base case.** *"OpenCode uses the AI SDK and Models.dev to support 75+ LLM
  providers"* via the user's own keys ([opencode.ai/docs/providers](https://opencode.ai/docs/providers)).
  Cost is whatever that provider charges. Zen is *"completely optional to use."*
- **OpenCode Go** - *"a low cost $10/month subscription… generous limits and reliable access to
  the most capable open source models,"* usable *"with OpenCode or any agent"*
  ([opencode.ai/go](https://opencode.ai/go)). Curated open-weight models, dollar-denominated
  caps (*"5 hour limit - $12 of usage,"* *"Weekly limit - $30 of usage,"* *"Monthly limit - $60
  of usage"*), one subscriber per workspace.
- **OpenCode Zen** - separate pay-as-you-go prepaid balance over curated frontier models.

**[I] OpenCode is the least constrained of the three Harnesses** for Reprove's purposes: BYOK is
an ordinary provider key with no subscription-terms question attached, and neither Zen nor Go
carries anything resembling OpenAI's or Anthropic's automation restrictions. **Do not repeat
the widely quoted "zero markup" framing for Zen** - it could not be confirmed on a primary page.

## 5. Automation, CI, and unattended use

### OpenAI: four narrow facts, and nothing beyond them

**Fact 1 - non-interactive Codex is explicitly documented for automation. [V]** From
[developers.openai.com/codex/noninteractive](https://developers.openai.com/codex/noninteractive):

> "Non-interactive mode lets you run Codex from scripts (for example, continuous integration
> (CI) jobs) without opening the interactive TUI. You invoke it with `codex exec`."

Its "When to use `codex exec`" list names, verbatim: *"Run as part of a pipeline (CI, pre-merge
checks, scheduled jobs)."* The same page carries a worked "Autofix CI failures in GitHub
Actions" example. **[V]** The list does **not** use the words "code review" or "cron"; quote it
as written.

**Fact 2 - `codex exec` reuses the existing login. [V]** Same page, under "Authenticate in
automation":

> "`codex exec` reuses saved CLI authentication by default. In CI, it's common to provide
> credentials explicitly:"

**Fact 3 - API keys are the recommended default for automation. [V]** From
[learn.chatgpt.com/docs/auth/ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth):
*"The right way to authenticate automation is with an API key"*, and *"API keys are still the
recommended option for most CI/CD jobs."*

**Fact 4 - the public/open-source warning, and exactly what it is bound to. [V]** The same page
states its pattern as five numbered steps:

> "1. Create `auth.json` once on a trusted machine with `codex login`. 2. Put that file on the
> runner. 3. Run Codex normally. 4. Let Codex refresh the session when it becomes stale.
> 5. Keep the refreshed `auth.json` for the next run."

and immediately after, in full:

> "Treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it,
> paste it into tickets, or share it in chat. **Do not use this workflow for public or
> open-source repositories.** If `codex login` is not an option on the runner, seed `auth.json`
> through secure storage, run Codex on the runner so Codex refreshes it in place, and persist
> the updated file between runs."

Its "When to use this" gate is entirely about runner conditions - *"`codex login` cannot run on
the remote runner"*, *"the runner is trusted private infrastructure"*, *"you can preserve the
refreshed `auth.json` between runs"*, *"only one machine or serialized job stream will use a
given `auth.json` copy"* - and its "Operational rules that matter" are `auth.json`-handling
hygiene throughout.

**[V] Nothing on that page, or anywhere else fetched, generalizes the warning** beyond the
`auth.json`-on-a-runner pattern. No source states that account-authenticated Codex must not run
non-interactively against a public repository as a standalone rule.

**The one ambiguous sentence. [V]** From [learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth),
in a passage about sign-in methods:

> "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't
> expose Codex execution in untrusted or public environments."

**[I] "Public environments" is genuinely ambiguous** and the docs never disambiguate it. It sits
in a section about *how the process authenticates and runs* rather than about the target
codebase, and "untrusted or public environments" reads most naturally as infrastructure and
network trust - matching OpenAI's neighbouring guidance about not running untrusted code in the
same process environment. But a reader could argue it loosely covers operating against a public
repository. **Record both readings; do not resolve it in Reprove's favour.** Note also the
register: the word is *"Don't"*, the same soft imperative used for "don't commit it, paste it
into tickets" - guidance phrasing, not "must not" or "prohibited."

**Not verified. [V]** No precedence rule was found anywhere for a saved ChatGPT login versus an
`OPENAI_API_KEY` / `CODEX_API_KEY` environment variable. Unlike Anthropic, which documents that
an API key wins, **OpenAI's precedence is undocumented** - so a Native Auth Route Worker should
not assume either way and should verify empirically which credential a Run actually used.

### Read that warning narrowly - what "this workflow" refers to

**[I] Two corrections, in opposite directions, and the second matters more.**

**First**, describing the public-repo line as *purely* a credential-exposure note was too
generous. OpenAI states plainly that API keys are "the right way" to authenticate automation
and that the account path is for "trusted private automation." Reprove should call the Native
Auth Route **documented and supported**, never **recommended**.

**Second - and this reverses an earlier conclusion in this file** - the warning does **not**
establish that account-authenticated Codex may not be used non-interactively against public
repositories. "This workflow" is a demonstrative, and its antecedent is what that page
documents: **seeding a ChatGPT-managed `auth.json` onto a CI/CD runner and persisting it there
between jobs**, where Codex then refreshes it. The page is titled for that pattern and the
warning sits inside it.

Reprove's Native Auth Route is a materially different arrangement:

```text
The documented CI/CD workflow          Reprove's Native Auth Route
─────────────────────────────          ───────────────────────────
log in on a trusted machine            user logs in to their own Codex
copy auth.json to the CI runner        (no credential is copied anywhere)
persist it between CI jobs             (nothing is seeded or persisted by Reprove)
Codex refreshes it on the runner       Worker invokes the already-authenticated CLI
```

**[I] So no repository-visibility restriction is established**, and this file previously drew
one. That inference has been withdrawn. The correct posture is to record the four narrow facts
in §5 and go no further. If a source is later found stating that account-authenticated Codex
itself must not be run non-interactively against public repositories, that would change the
conclusion - none has been found.

**What survives is a security concern, not a terms one.** The *reason* the warning exists -
untrusted code sharing an environment with a password-equivalent credential - applies to
Reprove regardless of who documents it, and is sharper on a public repository where anyone may
open a pull request. That makes repository visibility **a risk input to the isolation design**
([#10](https://github.com/nick-neely/reprove/issues/10)), not a policy gate on the Route.

### Anthropic: the carve-out is explicit, and survives platform hosting

All **[V]**, from
[code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance):

> "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team,
> and Enterprise subscription plans and is designed to support ordinary use of Claude Code and
> other native Anthropic applications."

> "Developers building products or services that interact with Claude's capabilities, including
> those using the Agent SDK, should use API key authentication through Claude Console or a
> supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai
> login into their own applications, or to route requests through Free, Pro, or Max plan
> credentials on behalf of their users. Moreover, developers may not collect, store, or
> intermediate Claude.ai credentials or session tokens - sign-in to a Claude account must
> complete through Anthropic's own flow."

The carve-out, verbatim:

> "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
> their own Claude subscription, **including where a platform hosts Claude Code**…"

With conditions:

> "The Claude Code binary must not be modified. Claude Code must be installed and run as
> published by Anthropic, and customers may not remove, disable, or restrict any authentication
> method built into it…"

> "Each end user must authenticate with their own Anthropic API key, Claude subscription plan
> credentials, or 3P inference provider credential… That usage is billed directly to the end
> user under their own agreement with Anthropic…"

**[I] Reprove satisfies every named condition by construction**, and this is worth stating
because it was designed that way before the text was read: the Native Auth Route invokes the
published CLI unmodified, never collects or intermediates a credential, never routes requests
on a user's behalf, and never offers Claude sign-in inside Reprove's own UI. The clause that
would exclude Reprove is the one it deliberately avoids.

**The residual gap. [V]** *"Advertised usage limits for Pro and Max plans assume ordinary,
individual usage of Claude Code and the Agent SDK."* **[I]** An unattended, webhook-triggered
Run is not obviously "ordinary, individual usage." Neither vendor's documentation uses the
words "unattended" or "webhook-triggered" at all. This specific combination remains
**unaddressed rather than blessed or prohibited**, and Reprove should keep saying so.

### Anthropic's position is actively unstable, and that is the finding

Do not cite the legal-and-compliance language as a settled position. It is one move in an
ongoing sequence that has reversed twice and is currently paused:

| Date | What happened | Evidence |
|---|---|---|
| 2026-01-09 | Server-side blocks deployed against third-party clients spoofing the Claude Code client. Enforcement, no policy text. | Secondary only |
| ~2026-02-19 | "Authentication and credential use" language added to the legal-and-compliance page (§5 above). | **[V]** page live; **date secondary** |
| 2026-04-04 | Full enforcement: Pro/Max/Team subscriptions stopped covering third-party tools. One-time credit issued as compensation. | Secondary only - no Anthropic-hosted announcement found |
| 2026-05-13 | Reversal announced: a separate monthly "Agent SDK credit" ($20 Pro / $100 Max 5x / $200 Max 20x) explicitly covering third-party apps authenticating with a Claude subscription, effective 2026-06-15. | **[V]** via the page below |
| 2026-06-15 | **Paused on the day it was to take effect.** Unresolved as of 2026-08-29. | **[V]** live banner |

The live banner, verbatim, from
[support.claude.com/en/articles/15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):

> "**Update June 15:** We're pausing the changes to Claude Agent SDK usage described below. For
> now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw
> from your subscription's usage limits. The previously announced monthly credit… isn't
> available. We're working to update the plan to better support how users build with Claude
> subscriptions. When we have an update, we'll share it before anything takes effect."

**[V] Anthropic's live documentation currently contradicts itself.** The legal-and-compliance
page says Agent SDK developers *"should use API key authentication"* and that Anthropic does not
permit routing requests through subscription credentials *"on behalf of their users."* The
Agent SDK article treats a user's own OAuth-authenticated third-party usage as normal and
sanctioned. **[I]** The likely reconciliation is that the legal page targets a *developer*
pooling or reselling *other people's* usage, while an *individual* running a tool under their
own session is the Agent SDK article's case - but Anthropic has published nothing reconciling
them. Treat the ambiguity as real and current, not as stale reporting.

**[I] Two things follow for Reprove, and they point in opposite directions.**

1. **The instability does not invalidate the carve-out.** Reprove's Native Auth Route invokes
   the **unmodified `claude` CLI**, not the Agent SDK. The entire reversal sequence above is
   about Agent SDK and third-party-app usage; the CLI carve-out in §5 is a different clause and
   has not moved. Reprove is on the more stable side of this line, and deliberately so.
2. **It is decisive evidence for the guardrail.** "A current capability, not a guarantee about
   future provider pricing, limits, or authentication policy" is not boilerplate caution - this
   provider changed position four times in seven months and is currently paused mid-change.
   Any Reprove document that implies permanence is contradicted by the record.

**Dates.** Only the 2026-06-15 pause is verified from a dated primary element. The February
and April dates rest on secondary reporting. **Cite URLs, not dates.**

## 6. Not verified

- Numeric usage allowances for any plan, from either vendor. Both deliberately publish these on
  pricing pages instead. **Never quote a figure.**
- OpenCode Zen's "zero markup" pricing framing.
- The 2026-02 and 2026-04 dates in the Anthropic timeline - secondary reporting only. Only the
  2026-06-15 pause is verified from a dated primary element.
- How Anthropic reconciles its legal-and-compliance page with its Agent SDK article. The
  contradiction is live and unexplained.
- Any vendor statement specifically addressing unattended or webhook-triggered subscription
  usage. **Its absence is itself the finding**, and it is the reason Reprove records this
  combination as unaddressed rather than permitted.
