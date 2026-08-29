# Severity, Verification, and the absence of confidence

The PRD sketched a finding carrying `severity`, `confidence` and `verificationStatus` as three
independent axes, all three marked `[Undecided]` (open questions 16, 24, 25, §11 and §29). We are
keeping two of them. A **Finding** carries a **Severity** the Reviewer assigns from a
consequence-anchored ladder, and a **Verification** recording how far that Reviewer got in proving
it - and it carries no confidence field at all, because the only confidence signal worth trusting
from a language model is what it *did*, not what it *felt*.

## Decisions

- **A Finding is a claim its Reviewer did not disprove**, not one it proved. Verification raises a
  Finding's standing rather than admitting it. The alternative reading makes an `inspect` Run
  produce zero Findings by definition, and throws away the whole class of true review comment that
  is not executable - a missing error path, a race you cannot trigger, a misused API.
- **`severity`: `critical` | `high` | `medium` | `low`**, each anchored to an observable
  consequence rather than an adjective: `critical` is data loss, a security breach or an outage if
  it merges; `high` is incorrect behavior on a normal path; `medium` is incorrect behavior on an
  edge case, or a maintainability hazard with a concrete cost; `low` is style, naming and nits.
  There is no `info` - a remark that is not actionable does not earn a Finding.
- **`verification`: `verified` | `inconclusive` | `static`.** `verified` means the Reviewer
  executed something whose output demonstrates the claim. `inconclusive` means execution was
  attempted and failed to settle it - the build is broken, a service is missing. `static` means
  reasoned only.
- **No Evidence, no `verified`.** The schema makes the value unreachable with an empty Evidence
  field, and accepting a Result additionally cross-checks that the claimed command appears in the
  harness session transcript.
- **The Reviewer owns Severity; the Repository owns Thresholds.** Severity describes the defect,
  policy describes the repository, and the control plane never rewrites a Reviewer's Severity.
- **Defaults: post at `medium` and above, submit the GitHub review as `COMMENT`.** Requesting
  changes is opt-in, and no Verification threshold is applied by default.

## Considered options

**A `confidence` field.** The real argument for it is that `static` cannot distinguish a
near-certain claim from a speculative one. We rejected it anyway: a self-reported 0-1 score is
uncalibrated, a coarse enum is the same problem with fewer digits, and neither survives the
question "what would make this number trustworthy?" Worse, it gives a Reviewer somewhere to hedge
instead of going and running the code, which is the exact behavior this product exists to replace.
Adding the field later is cheap; removing it once it is in the comment format and the config schema
is not.

**A two-axis impact x likelihood severity.** Rejected because likelihood is a confidence axis
wearing a hat, and because it is the one model that will not collapse onto SARIF.

**The PRD's `PARTIALLY_VERIFIED`.** Rejected as a value with no bar anyone can write down, and as
one a Reviewer will reach for to upgrade itself out of `static`. `inconclusive` states the same
situation honestly and carries actionable information: the claim is unproven *and* proving it is
blocked.

**`refuted` and `verifying` as Verification values.** Neither is a state a Finding can be in. A
disproved hypothesis is not a Finding - [#2](https://github.com/nick-neely/reprove/issues/2) routes
those to telemetry - and verification happens inside a Pass, so there is no persisted transient
state.

**Designing the severity model to be SARIF-native**, so Findings could also upload to GitHub code
scanning. Rejected as a constraint. Code scanning is free on public repositories but requires a
paid GitHub Code Security seat on private and internal ones, so making it a delivery surface would
put a GitHub add-on on the critical path of an open-source tool's core output. The ladder above
collapses onto SARIF's `error`/`warning`/`note` anyway, which is all the compatibility we want.

## Consequences

- Changing a Threshold never requires a new Run: Findings are stored with their Severity and
  Verification intact, and Thresholds are applied when a Review is published.
- `REQUEST_CHANGES` interacts with branch protection, so defaulting to `COMMENT` is what keeps a
  first install from blocking a team's merges.
- Accepting a Result is a **named step** in the Run rather than something implicit in the Worker's
  callback, so independently re-executing a Reviewer's claimed command can be added later without
  reshaping the Run. We are not doing that now.
- Evidence output is the most sensitive thing a Run produces - it is literal output from the user's
  own code. Whether a self-hosted Worker ships it to the control plane at all belongs to
  [#12](https://github.com/nick-neely/reprove/issues/12).
- The Review summary reports disproved hypotheses in aggregate ("verified 3 findings, disproved 4
  further hypotheses") and never enumerates them, which would reward manufacturing hypotheses that
  are easy to knock down.
