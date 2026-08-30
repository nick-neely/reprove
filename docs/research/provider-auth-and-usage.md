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

**[V] OpenAI's automation guidance is more cautionary than previously recorded**, and one line
in it lands directly on Reprove: *"Do not use this workflow for public or open-source
repositories."* See §5 - this is the one finding here that constrains the product rather than
supporting it.

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

**[V]** Three distinct paths, per [opencode.ai/docs/go](https://opencode.ai/docs/go/):

- **BYOK** - the open-source CLI connects directly to providers with the user's own keys. Cost
  is whatever that provider charges. This is the base case.
- **OpenCode Go** - a $10/month subscription (first month $5) over a curated set of ~20-25
  open-weight coding models, with dollar-denominated caps: *"5 hour limit - $12 of usage,"*
  *"Weekly limit - $30 of usage,"* *"Monthly limit - $60 of usage."* One subscriber per
  workspace.
- **OpenCode Zen** - separate pay-as-you-go prepaid balance over curated frontier models.

**Lower confidence than §2-3.** These figures came from a documentation fetch rather than a
raw-page read, and the frequently repeated "zero markup" framing for Zen could **not** be
confirmed on a primary page. Do not repeat it.

## 5. Automation, CI, and unattended use

### OpenAI: API keys are the recommended path, and public repos are excluded

All **[V]**, from
[learn.chatgpt.com/docs/auth/ci-cd-auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth):

> "The right way to authenticate automation is with an API key. Use this guide only if you
> specifically need to run the workflow as your Codex account."

> "This is an advanced workflow for enterprise and other trusted private automation. API keys
> are still the recommended option for most CI/CD jobs."

> "Treat `~/.codex/auth.json` like a password: it contains access tokens. Don't commit it,
> paste it into tickets, or share it in chat. **Do not use this workflow for public or
> open-source repositories.**"

Preconditions it names: *"the runner is trusted private infrastructure"* and *"only one machine
or serialized job stream will use a given `auth.json` copy."* And from the auth page: *"Use API
key authentication for programmatic Codex CLI workflows, such as CI/CD jobs. Don't expose
Codex execution in untrusted or public environments."*

**[I] Correction to how Reprove had characterized this.** Reading the public-repo line purely
as a credential-exposure warning was too generous. It sits in a security paragraph, so the
*motivation* is exposure - but OpenAI states plainly that API keys are "the right way" and this
path is for "trusted private automation." Reprove should describe account-authenticated Codex
automation as **documented, supported, and narrow**, never as recommended.

**[I] This exposes a gap in Reprove's own gating.** Provenance ([ADR 0003](../adr/0003-two-invocation-routes.md))
classifies by *author association* - is the head a branch of the same Repository, and is the
Author an owner, member or collaborator? OpenAI's constraint is about **repository
visibility**, which is a different axis. A public open-source repository whose maintainer opens
a PR from a branch is `internal` Provenance and would pass the Native Route gate, while sitting
squarely inside the case OpenAI says not to use. **Provenance alone does not implement this
guidance.**

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

**Date not verified.** The February 2026 dating of this clarification is widely reported by
secondary sources but carries no dated stamp on the primary page. **Cite the URL, not a date.**

## 6. Not verified

- Numeric usage allowances for any plan, from either vendor.
- OpenCode Zen's "zero markup" pricing framing.
- The precise date of Anthropic's authentication clarification.
- Any vendor statement specifically addressing unattended or webhook-triggered subscription
  usage. Its absence is itself the finding.
