# Contributing to Reprove

Thanks for your interest. Reprove is open source under
[Apache-2.0](LICENSE), and contributions of every size are welcome.

Everyone participating is held to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security problems do **not** go in a public issue - see [SECURITY.md](SECURITY.md).

## Where the project is right now

**Pre-implementation.** No source code exists yet. The repository currently
holds the specification and the decision record:

| Path | What it is |
|---|---|
| [`docs/prd.md`](docs/prd.md) | The product definition. Direction, not gospel - it changes as decisions land. |
| [`CONTEXT.md`](CONTEXT.md) | The glossary. The language of record for every noun in the system. |
| [`docs/adr/`](docs/adr/) | Architecture Decision Records. One file per load-bearing decision. |
| [`docs/research/`](docs/research/) | Findings from investigations that decisions depended on. |
| [`docs/agents/`](docs/agents/) | Conventions for the coding agents that work in this repo. |

Until the first package lands there is nothing to install and nothing to run.
The most useful contribution today is **argument**: reading the PRD or an ADR
and telling us where it is wrong.

Once code exists, this section will carry the real setup steps. The stack is
TypeScript on Node.js 22+ (ESM) in a Turborepo monorepo, with Vitest and
Playwright for tests and Oxlint/Oxfmt for lint and format.

## Speak the glossary

[`CONTEXT.md`](CONTEXT.md) is not a style suggestion; it is the vocabulary the
codebase is being built in, and it lists the synonyms each term exists to
replace. Before you write an issue title, a type name, or a paragraph of docs,
check the term you are about to use.

Two rules it enforces that catch people out:

1. **No `Review` prefix on domain nouns.** The whole system is review, so
   `ReviewJob`, `ReviewResult` and `ReviewFinding` stutter. The nouns are bare:
   **Run**, **Result**, **Finding**.
2. **A dependency's name gets qualified at the seam, not ours.** Where a library
   already occupies a word Reprove needs, Reprove keeps the bare name and renames
   the foreign one where it enters - Vercel Workflow's `runId` becomes
   `workflowRunId` on arrival.

If the concept you need is not in the glossary, that is a signal: either the
project does not use that language, or there is a real gap worth raising.

## How changes get proposed

### Issues

Open an issue before a substantial pull request. It is cheaper to be told an
idea is out of scope than to be told after you have built it.

Issue templates cover the three common cases: a bug, a feature, and support for
a new **Harness**. Pick the closest one.

New issues are labelled `needs-triage`. From there a maintainer applies one of:

| Label | Meaning |
|---|---|
| `needs-triage` | A maintainer still needs to evaluate this |
| `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | Fully specified; an autonomous agent can pick it up |
| `ready-for-human` | Needs human implementation |
| `wontfix` | Will not be actioned |

### Wayfinder maps

Structural decisions are made in the open through **wayfinder maps**: an issue
labelled `wayfinder:map` that names a destination, indexes the decisions made so
far, and carries its open questions as child issues. Each child is labelled by
type - `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or
`wayfinder:task` - and blocked-by edges show which are takeable now.

[Map: Lock the Reprove foundation](https://github.com/nick-neely/reprove/issues/1)
is the live one. If you want to know why something is the way it is, that map
and [`docs/adr/`](docs/adr/) are the answer. If you disagree with a settled
decision, the ADR is the thing to argue with.

Map work lands on a single long-lived branch rather than a branch per ticket.
Ordinary contributions do not need to follow that convention.

### Pull requests

- Branch from `main`.
- Keep a pull request to one concern. Two unrelated fixes are two pull requests.
- Update the docs the change invalidates in the same pull request - a PRD line,
  a glossary entry, an ADR. A decision that contradicts an existing ADR should
  say so explicitly rather than silently overriding it.
- Fill in the pull request template. The "why" matters more than the "what";
  the diff already says what.

## Licensing of contributions

There is nothing to sign. Reprove requires **no CLA and no DCO sign-off** -
open a pull request and that is the whole process.

Contributions are licensed inbound under the same terms as the project's
outbound license. Apache-2.0 Section 5 says so directly: a contribution
submitted for inclusion in the work is under the terms of the license, absent
an explicit statement otherwise. Section 3 carries an explicit patent grant
from each contributor along with it. So by opening a pull request you are
licensing that work to the project under [Apache-2.0](LICENSE), and confirming
you have the right to do so.

That leaves one consequence worth stating plainly, because it is a promise
rather than an oversight: **Reprove cannot unilaterally relicense contributed
code, and does not intend to.** A CLA is the instrument that would grant that
right, and the project deliberately does not collect one. Reprove Cloud stays
proprietary by keeping billing and multi-tenant management in unpublished
packages - by what gets published, not by holding rights over what is
contributed here.

If you are contributing on behalf of an employer, make sure you have the right
to do that before you open the pull request. That is between you and them; the
project takes your submission at face value.

## Reviewing your own work

Reprove is a code review tool. Hold contributions to the standard the product
argues for: a claim about the code should be **verified** by executing something,
not asserted. If you say a change fixes a bug, the pull request should show what
you ran.

## Questions

Open an issue. Discussions are not enabled yet.
