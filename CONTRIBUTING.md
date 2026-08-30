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
- Every commit needs a DCO sign-off (see below).

## Developer Certificate of Origin

Reprove uses the [Developer Certificate of Origin](https://developercertificate.org)
rather than a Contributor License Agreement. Sign off every commit:

```bash
git commit -s -m "Your message"
```

That appends a line to the commit message:

```text
Signed-off-by: Your Name <your.email@example.com>
```

It certifies that you wrote the contribution or otherwise have the right to
submit it under Apache-2.0. Use your real name and an address you can be
reached at. If you forget, `git commit --amend -s` fixes the last commit and
`git rebase --signoff main` fixes a branch.

### Why DCO and not a CLA

A CLA exists to give a project rights that its license does not already grant -
almost always the right to relicense or dual-license contributed code. Reprove
does not need that right:

- **Apache-2.0 already grants what a CLA would collect.** Section 5 makes every
  contribution inbound under the same terms as the outbound license, and Section
  3 carries an explicit patent grant from each contributor. The gap a CLA
  usually closes is closed by the license itself.
- **The open-core boundary is drawn by what gets published, not by what is
  licensed.** Reprove Cloud stays proprietary by keeping billing and
  multi-tenant management in unpublished packages, not by holding relicensing
  rights over this repository. No contribution here ever needs to be relicensed
  for Cloud to work.
- **A CLA has a real cost.** It puts a signature step in front of a first-time
  contributor's one-line fix, and it needs a bot and a signature store to
  administer. Paying that to acquire a right the project has no use for is a bad
  trade.

The consequence is deliberate and worth stating plainly: Reprove **cannot**
unilaterally relicense contributed code, and does not intend to.

## Reviewing your own work

Reprove is a code review tool. Hold contributions to the standard the product
argues for: a claim about the code should be **verified** by executing something,
not asserted. If you say a change fixes a bug, the pull request should show what
you ran.

## Questions

Open an issue. Discussions are not enabled yet.
