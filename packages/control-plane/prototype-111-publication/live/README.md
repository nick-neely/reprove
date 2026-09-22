# Live-App harness for issue #111

Throwaway, like its parent folder. The paper prototype answers what a Run should
look like; nothing in markdown can answer what only a real GitHub App observes.
This is the scratch App harness for ADR 0022's Consequences list and ADR 0025
§9: the re-run interaction, whether re-asserting a conclusion settles a suite,
whether Checks at one head share a suite, how same-name Checks display, whether
"Re-run all checks" really delivers `check_suite.rerequested`, config-only
versus combined suite routing, and two pull requests sharing a SHA.

Nothing here is tested, nothing is production code, and no shape in it is meant
to survive. It is outside the pnpm workspace (`pnpm-workspace.yaml` globs
`packages/*` only), so its three dependencies never join the ADR 0010 graph.

## Setup, once

1. A scratch GitHub App with `Checks: write` (which auto-subscribes `check_run`
   and `check_suite`), `Pull requests: write` and `Contents: write`, subscribed
   to `check_run`, `check_suite` and `pull_request`, installed on
   `nick-neely/reprove-fixture`. Webhook URL is a fresh channel from
   <https://smee.io/new>.
2. The fixture repository needs a `main` with a file to edit, for example
   `src/slice.ts` with a few lines.
3. `~/.config/reprove-proto-111/config.json`:

   ```json
   {
     "appId": 123456,
     "smeeUrl": "https://smee.io/<channel>",
     "owner": "nick-neely",
     "repo": "reprove-fixture"
   }
   ```

   `installationId` is optional: the first call looks it up through
   `GET /repos/{owner}/{repo}/installation` with the App JWT and caches it back
   into the file.
4. The App private key at `~/.config/reprove-proto-111/app.pem`.
5. `npm install` in this folder. Node 22 or newer.

Every script takes `--dry-run`, which prints the request instead of sending it
and needs no credentials, and `--help`.

## Start the listener, and leave it running

```sh
cd packages/control-plane/prototype-111-publication/live
npm install
node listen.mjs
```

`pnpm proto:111:live` from the repository root does the same thing, once
`npm install` has been run here.

It appends one flat JSON line per delivery to `deliveries.jsonl` and the
untouched payload to `payloads/<delivery>.json`. Read it with
`tail -f deliveries.jsonl | jq -c '{event,action,cr:.check_run.id,st:.check_suite.status,cc:.check_suite.conclusion}'`.

Every experiment below assumes the listener is up. Keep one terminal on it and
run the commands in a second.

## The matrix, in order

Run them in this order: E1 makes the pull request the next several reuse, and
E6 onwards move or close it.

### E1 - two Checks at one SHA

```sh
node pr.mjs open --branch exp/e1 --file src/slice.ts --line 3 --text "const answer = 42; // e1"
# note the number and headSha it prints; export them
node check.mjs create --sha "$SHA" --name Reprove --external-id reprove.run.e1 \
  --status completed --conclusion success --title "No blocking Findings" --summary "1 Finding, 0 blocking"
node check.mjs create --sha "$SHA" --name "Reprove config" --external-id reprove.config.e1 \
  --status completed --conclusion success --title "Configuration is valid" --summary "reprove.toml parsed"
node check.mjs list --sha "$SHA"
node check.mjs suites --sha "$SHA"
```

**Record.** From both `create` outputs, `check_suite.id`: the same value or two.
From `suites`, how many suites carry our `app_id`, each
`latest_check_runs_count` and `rerequestable`. From `deliveries.jsonl`, the
`check_run.created` lines and whether any `check_suite` delivery accompanied
them.

Optionally post the paper prototype's markdown so the Review surface is real
too:

```sh
node review.mjs --number "$PR" --sha "$SHA" --body-file ../out/D/S1/review.md \
  --comment src/slice.ts:3:../out/D/S1/comment-1.md
```

**Record.** The review id, each comment id and `html_url`, and any comment
GitHub rejected for anchoring outside the diff.

### E2 - Re-run one Check

Click **Re-run** on the `Reprove` Check in the Checks tab, then:

```sh
node check.mjs suites --sha "$SHA"
node check.mjs update --id "$REPROVE_CHECK_ID" --status completed --conclusion success \
  --title "Re-asserted unchanged" --summary "Nothing ran; the previous conclusion stands"
node check.mjs suites --sha "$SHA"
```

**Record.** Whether a `check_run.rerequested` delivery arrived and what its
`check_run.status` and `conclusion` were (ADR 0022 §5 says the Check Run itself
is not updated). Whether the suite went to `queued` with a null conclusion, and
whether re-asserting the same conclusion settled it back to `completed` /
`success`. This is the first unverified claim in ADR 0025 §9.

### E3 - Re-run one Check while another is in progress

```sh
node check.mjs update --id "$CONFIG_CHECK_ID" --status in_progress --title "Validating" --summary "..."
# click Re-run on the Reprove Check
node check.mjs suites --sha "$SHA"
node check.mjs update --id "$REPROVE_CHECK_ID" --status completed --conclusion success \
  --title "Re-asserted unchanged" --summary "..."
node check.mjs suites --sha "$SHA"
node check.mjs update --id "$CONFIG_CHECK_ID" --status completed --conclusion success \
  --title "Configuration is valid" --summary "..."
node check.mjs suites --sha "$SHA"
```

**Record.** The suite `status` and `conclusion` after each of the three
`suites` calls: whether the suite can settle at all while a sibling Check is
`in_progress`, and what it settles to once the sibling finishes. The second half
of the same ADR 0025 §9 question.

### E4 - Re-run all checks

Click **Re-run all checks**, then:

```sh
node check.mjs suites --sha "$SHA"
node check.mjs list --sha "$SHA"
```

**Record.** Whether `check_suite.rerequested` arrived at all - the research only
inferred it - and its `check_suite.id`, `status`, `conclusion` and
`latest_check_runs_count`. Which `check_run.rerequested` deliveries accompanied
it, in what order, and whether one arrived per Check or none. Whether `list`
shows the Check Runs unchanged.

### E5 - Re-run after a failure, and after a Refusal shape

```sh
node check.mjs update --id "$REPROVE_CHECK_ID" --status completed --conclusion failure \
  --title "2 blocking Findings" --summary "..."
# click Re-run; then
node check.mjs suites --sha "$SHA"
node check.mjs update --id "$REPROVE_CHECK_ID" --status completed --conclusion failure \
  --title "Re-asserted unchanged" --summary "..."
node check.mjs suites --sha "$SHA"

node check.mjs update --id "$REPROVE_CHECK_ID" --status completed --conclusion neutral \
  --title "Refused: the configuration names an unavailable model" --summary "..."
# click Re-run; then
node check.mjs suites --sha "$SHA"
```

**Record.** Whether the re-run affordance is present for `failure` and for
`neutral` at all, and whether the suite behaves as it did in E2 for both. A
`neutral` conclusion is the Refusal shape ADR 0025 publishes, so if `neutral`
loses the button the manual surface loses its only recovery.

### E6 - Stale head

```sh
node pr.mjs push --number "$PR"      # prints the new headSha
node check.mjs list --sha "$OLD_SHA"
# click Re-run on the Reprove Check at the OLD sha (Checks tab of that commit)
node check.mjs update --id "$REPROVE_CHECK_ID" --status completed --conclusion success \
  --title "Nothing ran: this Check is not at the current head ($NEW_SHA)" --summary "..."
```

**Record.** Whether a Check at a superseded SHA still offers Re-run and still
delivers `check_run.rerequested`, the `head_sha` on that delivery, and whether
the update at the old SHA is accepted and visible anywhere. This is ADR 0022
§5's stale-head visible no-op.

### E7 - Closed pull request

```sh
node pr.mjs close --number "$PR"
# click Re-run on the Reprove Check
node check.mjs suites --sha "$NEW_SHA"
```

**Record.** Whether a re-run is still offered and delivered on a closed pull
request, and whether the re-asserted no-op Check is visible with the pull
request closed. ADR 0022 §5's closed visible no-op depends on it.

### E8 - Two Checks of the same name at one SHA

```sh
node pr.mjs open --branch exp/e8 --file src/slice.ts --line 4 --text "const again = 1; // e8"
node check.mjs create --sha "$SHA8" --name Reprove --external-id reprove.run.e8a \
  --status completed --conclusion success --title "Attempt 1" --summary "..."
node check.mjs create --sha "$SHA8" --name Reprove --external-id reprove.run.e8b \
  --status completed --conclusion failure --title "Attempt 2" --summary "..."
node check.mjs list --sha "$SHA8"
```

**Record.** Whether both appear in the Checks tab and in the pull request's
checks summary or only the latest; what the summary line shows as the combined
state; which Check id the Re-run button targets (from the
`check_run.rerequested` delivery's `check_run.id` and `external_id`); and
whether both share one suite. ADR 0025 §9's same-name question, and the reason
`external_id` rather than name is the handle.

### E9 - Two pull requests sharing one SHA

```sh
node pr.mjs open-same-sha --from exp/e8 --branch exp/e9
node check.mjs list --sha "$SHA8"
node check.mjs suites --sha "$SHA8"
# click Re-run on a Check from each pull request's Checks tab in turn
```

**Record.** `check_run.pull_requests[]` in `deliveries.jsonl` for each re-run:
which numbers it holds, whether it holds both, and whether it differs depending
on which pull request the click came from. The suite `pull_requests` from
`suites`. Whether both pull requests share the one suite. This is the ADR 0022
§7 "at most one review per represented pull request per suite request" case, and
the evidence for §3's refusal to read `pull_requests[]`.

### E10 - Config-only suite

```sh
node pr.mjs open --branch exp/e10 --file src/slice.ts --line 5 --text "const only = 0; // e10"
node check.mjs create --sha "$SHA10" --name "Reprove config" --external-id reprove.config.e10 \
  --status completed --conclusion success --title "Configuration is valid" --summary "..."
node check.mjs suites --sha "$SHA10"
# click Re-run on the Reprove config Check, then Re-run all checks
node check.mjs suites --sha "$SHA10"
```

**Record.** The suite id and whether it is the same suite shape as E1's. The
`check_run.rerequested` `external_id`, which is what tells routing this is a
revalidation and not a review trigger. Whether "Re-run all checks" on a
config-only suite delivers `check_suite.rerequested` with a suite whose only
publication is the config Check: ADR 0022 §7's "a config-only suite never
initiates a paid review" is routed on exactly that.

## Cleanup

```sh
node pr.mjs close --number "$PR"    # for each pull request opened
```

The branches, the smee channel and the scratch App can all be deleted
afterwards; nothing in the fixture repository is referenced from anywhere.
