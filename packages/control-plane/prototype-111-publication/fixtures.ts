/**
 * Throwaway prototype for issue #111. Fixture data only: no persistence, no
 * abstraction, no test. Field names follow the protocol and the schema so a
 * rendering cannot quietly invent a value the product does not hold.
 */

import type {
  Evidence,
  Finding,
  Hunk,
  PullRequest,
  Scenario,
  TerminalFacts,
} from "./types.ts";

const PR: PullRequest = {
  owner: "nick-neely",
  repo: "reprove",
  number: 412,
  title: "Stream workspace materialization from the Sandbox",
  headSha: "9f1c4d2e7a86b0c5d3f21e9a7b48c6d0e5f3a1b2",
  baseSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
  state: "open",
};

const short = (sha: string) => sha.slice(0, 7);

export const prettySha = short;

const facts = (over: Partial<TerminalFacts> = {}): TerminalFacts => ({
  harness: { value: "codex", provenance: "configured" },
  model: { value: "gpt-5.6-sol", provenance: "configured" },
  autonomy: { value: "verify", provenance: "default" },
  deadline: { value: "20m", provenance: "configured" },
  durationMs: 8 * 60_000 + 41_000,
  usage: {
    completeness: "complete",
    inputTokens: 184_220,
    outputTokens: 12_905,
    cachedInputTokens: 96_300,
    reasoningTokens: 7_400,
  },
  estimatedCostUsd: 1.42,
  pricingRevision: "price-catalogue-2026-09-02",
  qualification: "unqualified",
  providerDrift: { pinned: "gpt-5.6-sol", resolved: "gpt-5.6-sol-2026-08-19" },
  ...over,
});

const hunkSlice: Hunk = {
  header: "@@ -138,7 +138,11 @@ export const driveSlice = async (ctx: SliceContext) => {",
  lines: [
    { kind: "ctx", line: 138, text: "  const cursor = await readCursor(ctx.executionRecordId);" },
    { kind: "ctx", line: 139, text: "" },
    { kind: "add", line: 140, text: "  const stream = await ctx.sandbox.openLogStream({" },
    { kind: "add", line: 141, text: "    follow: true," },
    { kind: "add", line: 142, text: "  });" },
    { kind: "add", line: 143, text: "  for await (const chunk of stream) {" },
    { kind: "add", line: 144, text: "    await appendMaterializationLog(ctx, chunk);" },
    { kind: "add", line: 145, text: "  }" },
    { kind: "add", line: 146, text: "  return { cursor, done: stream.closedCleanly };" },
    { kind: "ctx", line: 147, text: "};" },
  ],
};

const hunkPublish: Hunk = {
  header: "@@ -84,6 +84,9 @@ const submitReview = async (client: Octokit, body: ReviewBody) => {",
  lines: [
    { kind: "ctx", line: 84, text: "  const comments = body.comments.filter(inHunk);" },
    { kind: "ctx", line: 85, text: "" },
    { kind: "add", line: 86, text: "  const payload = {" },
    { kind: "add", line: 87, text: "    body: renderBody(body)," },
    { kind: "add", line: 88, text: "    comments: comments.slice(0, MAX_COMMENTS)," },
    { kind: "ctx", line: 89, text: "  };" },
    { kind: "ctx", line: 90, text: "  return await client.rest.pulls.createReview(payload);" },
  ],
};

const hunkRoute: Hunk = {
  header: "@@ -53,4 +53,8 @@ export const POST = async (request: Request) => {",
  lines: [
    { kind: "ctx", line: 53, text: "  const delivery = request.headers.get('x-github-delivery');" },
    { kind: "ctx", line: 54, text: "" },
    { kind: "add", line: 55, text: "  const body = await request.text();" },
    { kind: "add", line: 56, text: "  const event = request.headers.get('x-github-event');" },
    { kind: "add", line: 57, text: "  return await ingest({ body, delivery, event });" },
    { kind: "ctx", line: 58, text: "};" },
  ],
};

const hunkAccounting: Hunk = {
  header: "@@ -201,5 +201,9 @@ export const aggregateUsage = (record: ExecutionRecord) => {",
  lines: [
    { kind: "ctx", line: 201, text: "  let input = 0;" },
    { kind: "ctx", line: 202, text: "" },
    { kind: "add", line: 203, text: "  for (const step of record.steps) {" },
    { kind: "add", line: 204, text: "    input += step.usage?.inputTokens ?? 0;" },
    { kind: "add", line: 205, text: "  }" },
    { kind: "ctx", line: 206, text: "  return { inputTokens: input };" },
  ],
};

const evidenceFailingTest: Evidence = {
  command: "pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'resumes after a lost stream'",
  exitCode: 1,
  durationMs: 21_408,
  excerpt: [
    "FAIL  packages/worker-hosted/src/slice.test.ts > driveSlice > resumes after a lost stream",
    "AssertionError: expected { done: false } to match { done: true }",
    "  at slice.test.ts:64:22",
    "",
    "Test Files  1 failed (1)",
  ].join("\n"),
  truncated: true,
  originalByteLength: 18_442,
};

const evidenceInconclusive: Evidence = {
  command: "pnpm vitest run packages/control-plane/src/github/publish.test.ts",
  exitCode: null,
  durationMs: 120_000,
  excerpt: [
    "stderr | publish.test.ts > submitReview > drops comments past the cap",
    "connect ECONNREFUSED 127.0.0.1:56532",
    "(no assertion reached before the 120s cap)",
  ].join("\n"),
  truncated: false,
  originalByteLength: 214,
};

const f1: Finding = {
  key: "F1",
  title: "A lost log stream is reported as a clean close, so a Slice resumes past unmaterialized files",
  body: [
    "`driveSlice` returns `done: stream.closedCleanly`, but `openLogStream` sets",
    "`closedCleanly` on any close it did not itself abort, including an upstream reset. A",
    "Slice that reads `done: true` advances the cursor, so the next Slice starts a turn on a",
    "Workspace that is still missing files, and ADR 0024's closure sequence never runs.",
  ].join(" "),
  severity: "critical",
  verification: "verified",
  location: { path: "packages/worker-hosted/src/slice.ts", startLine: 142, endLine: 146 },
  anchoredText: "  return { cursor, done: stream.closedCleanly };",
  evidence: [evidenceFailingTest],
  inDiff: true,
  hunk: hunkSlice,
  publicationDisposition: "inline_comment",
  reconciliation: "new",
};

const f2: Finding = {
  key: "F2",
  title: "Comments past the cap are dropped without a record, so a Finding disappears",
  body: [
    "`comments.slice(0, MAX_COMMENTS)` truncates silently. A Finding whose Comment is dropped",
    "here keeps `publicationDisposition: inline_comment` in the database, so the stored",
    "disposition asserts a Comment that GitHub never received.",
  ].join(" "),
  severity: "high",
  verification: "inconclusive",
  location: { path: "packages/control-plane/src/github/publish.ts", startLine: 88, endLine: 88 },
  anchoredText: "    comments: comments.slice(0, MAX_COMMENTS),",
  evidence: [evidenceInconclusive],
  inDiff: true,
  hunk: hunkPublish,
  publicationDisposition: "inline_comment",
  reconciliation: "new",
};

const f3: Finding = {
  key: "F3",
  title: "The webhook body is read before the signature is checked",
  body: [
    "`ingest` receives the raw body and the delivery id, and the signature header is never",
    "read on this path. Reasoned from the call graph only: no request was executed against a",
    "running app, because the stack would not start (see the recorded Limitation).",
  ].join(" "),
  severity: "medium",
  verification: "static",
  location: {
    path: "apps/control-plane/src/app/api/webhook/route.ts",
    startLine: 57,
    endLine: 57,
  },
  anchoredText: "  return await ingest({ body, delivery, event });",
  evidence: [],
  inDiff: true,
  hunk: hunkRoute,
  publicationDisposition: "inline_comment",
  reconciliation: "new",
};

const f4: Finding = {
  key: "F4",
  title: "The untouched authorization line now runs after materialization can still fail",
  body: [
    "`authorizeExecution` is called from the new streaming path while materialization is",
    "still polled, so a Refusal raised after this point would be recorded as an execution",
    "Failure instead. The file is not in this pull request's diff.",
  ].join(" "),
  severity: "high",
  verification: "static",
  location: { path: "packages/worker-core/src/run.ts", startLine: 311, endLine: 311 },
  anchoredText: "  await authorizeExecution(ctx);",
  evidence: [],
  inDiff: false,
  publicationDisposition: "review_body",
  reconciliation: "new",
};

const f5: Finding = {
  key: "F5",
  title: "`aggregateUsage` coerces an unreported step to zero tokens",
  body: [
    "`step.usage?.inputTokens ?? 0` makes an unreported step indistinguishable from a step",
    "that reported nothing, which ADR 0023 §7 forbids. Rated `low` because the aggregate's",
    "completeness flag is computed elsewhere and still reads `incomplete`.",
  ].join(" "),
  severity: "low",
  verification: "static",
  location: {
    path: "packages/control-plane/src/accounting/usage.ts",
    startLine: 204,
    endLine: 204,
  },
  anchoredText: "    input += step.usage?.inputTokens ?? 0;",
  evidence: [],
  inDiff: true,
  hunk: hunkAccounting,
  publicationDisposition: "suppressed_threshold",
  reconciliation: "new",
};

const S1: Scenario = {
  id: "S1",
  name: "Complete Result with Findings",
  blurb:
    "The ordinary success: a complete Result, three in-hunk Findings across Severities and Verifications, one Finding GitHub cannot anchor, one below Threshold, and a recorded Limitation.",
  pullRequest: PR,
  run: {
    id: "1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
    status: "completed",
    trigger: "automatic",
    result: {
      completeness: "complete",
      stoppedBy: null,
      summary:
        "Reviewed the materialization streaming path end to end. The resume contract is the load-bearing change and it does not hold: a lost stream is reported as a clean close. Two further defects sit on the publication and ingress paths.",
      disprovedHypothesisCount: 4,
      unfinished: null,
      limitations: [
        {
          kind: "dependency_unavailable",
          detail:
            "git submodules under vendor/ did not resolve in the Workspace, so vendor/harness-bridge was read as an empty directory",
        },
      ],
    },
    refusals: [],
    facts: facts(),
  },
  findings: [f1, f2, f3, f4, f5],
  threshold: { severity: "medium", verification: "any" },
  ignore: ["generated/**"],
  review: { event: "COMMENT" },
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
      status: "completed",
      conclusion: "success",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 1f0c8a5e…55d1",
        external_id: "reprove.run.1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
        check_run_id: "39 114 552 010",
        check_suite_id: "28 660 145",
        state: "published",
        github_review_id: "2 411 903 776",
        event: "COMMENT",
        applied_threshold: '{"severity":"medium","verification":"any"}',
        reconciled_against_run_id: "null (no prior Run published on this pull request)",
        prior_reconciliation: "null",
      },
    },
    {
      table: "finding",
      columns: {
        F1: "publication_disposition=inline_comment, reconciliation=new",
        F2: "publication_disposition=inline_comment, reconciliation=new",
        F3: "publication_disposition=inline_comment, reconciliation=new",
        F4: "publication_disposition=review_body, reconciliation=new (outside the diff)",
        F5: "publication_disposition=suppressed_threshold, reconciliation=new",
      },
    },
  ],
  notes: [
    "Threshold `severity: medium` is what suppresses F5; `suppressedFindingCount` is 1.",
    "`ignore: generated/**` matches nothing here, so no Finding lands on `suppressed_ignore`.",
  ],
};

const S2: Scenario = {
  id: "S2",
  name: "Complete Result, zero Findings",
  blurb:
    "A success with nothing to say. A Review is still published, because a complete Result with no Findings is a clean bill of health the Reviewer did give.",
  pullRequest: PR,
  run: {
    id: "2b7e91d4-0c5a-4f18-8e33-a6d0b2f47c91",
    status: "completed",
    trigger: "automatic",
    result: {
      completeness: "complete",
      stoppedBy: null,
      summary:
        "Reviewed the streaming path, the cursor arithmetic and the two call sites it changed. Ran the worker-hosted suite and the resume test specifically; both pass. Four hypotheses were disproved by execution and none survived as a Finding.",
      disprovedHypothesisCount: 4,
      unfinished: null,
      limitations: [],
    },
    refusals: [],
    facts: facts({
      durationMs: 5 * 60_000 + 12_000,
      estimatedCostUsd: 0.81,
      usage: {
        completeness: "complete",
        inputTokens: 102_880,
        outputTokens: 4_120,
        cachedInputTokens: 61_004,
        reasoningTokens: 2_900,
      },
      providerDrift: null,
    }),
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: { event: "COMMENT" },
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.2b7e91d4-0c5a-4f18-8e33-a6d0b2f47c91",
      status: "completed",
      conclusion: "success",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 2b7e91d4…7c91",
        external_id: "reprove.run.2b7e91d4-0c5a-4f18-8e33-a6d0b2f47c91",
        check_run_id: "39 114 552 044",
        check_suite_id: "28 660 201",
        state: "published",
        github_review_id: "2 411 904 018",
        event: "COMMENT",
        applied_threshold: '{"severity":"medium","verification":"any"}',
      },
    },
    { table: "finding", columns: { "(no rows)": "the Run produced no Findings" } },
  ],
  notes: [
    "The Check is `success` whether or not Findings were made (ADR 0007's table).",
    "`disprovedHypothesisCount` is the only evidence on this surface that anything was done.",
  ],
};

const f6: Finding = {
  key: "F6",
  title: "The cursor is advanced before the append is durable",
  body: [
    "`appendMaterializationLog` resolves on enqueue rather than on write, so a Slice that",
    "dies between the enqueue and the flush loses the chunk and still moves the cursor.",
  ].join(" "),
  severity: "high",
  verification: "static",
  location: { path: "packages/worker-hosted/src/slice.ts", startLine: 144, endLine: 144 },
  anchoredText: "    await appendMaterializationLog(ctx, chunk);",
  evidence: [],
  inDiff: true,
  hunk: hunkSlice,
  publicationDisposition: "inline_comment",
  reconciliation: "new",
};

const S3: Scenario = {
  id: "S3",
  name: "Reviewer stopped, partial Result with one Finding",
  blurb:
    "The Reviewer declared its own review unfinished. The Findings it did make are published and the Check is `failure`, because an unfinished review is never green.",
  pullRequest: PR,
  run: {
    id: "3c41ad88-51e2-4a77-b0d6-9e2f7a1c40b5",
    status: "incomplete",
    trigger: "automatic",
    result: {
      completeness: "partial",
      stoppedBy: "reviewer_stopped",
      summary:
        "Read the Slice driver and found one durability defect. I did not get to the control-plane accounting path or to the Workflow step that calls it.",
      disprovedHypothesisCount: 1,
      unfinished:
        "I did not review packages/control-plane/src/accounting/** or the Workflow step that drives the Slices. The append path is the only thing I examined closely enough to make a claim about.",
      limitations: [
        {
          kind: "service_unavailable",
          detail: "the local Postgres stack on 56532 refused connections, so nothing touching the database could be executed",
        },
        {
          kind: "scope_limit",
          detail: "packages/control-plane/src/accounting/** was left out; see `unfinished`",
        },
      ],
    },
    refusals: [],
    facts: facts({
      durationMs: 11 * 60_000 + 3_000,
      estimatedCostUsd: 2.06,
      usage: {
        completeness: "complete",
        inputTokens: 240_110,
        outputTokens: 9_002,
        cachedInputTokens: 130_440,
        reasoningTokens: 18_220,
      },
      providerDrift: null,
    }),
  },
  findings: [f6],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: { event: "COMMENT" },
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.3c41ad88-51e2-4a77-b0d6-9e2f7a1c40b5",
      status: "completed",
      conclusion: "failure",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 3c41ad88…40b5",
        external_id: "reprove.run.3c41ad88-51e2-4a77-b0d6-9e2f7a1c40b5",
        check_run_id: "39 114 552 087",
        check_suite_id: "28 660 233",
        state: "published",
        github_review_id: "2 411 904 551",
        event: "COMMENT",
        applied_threshold: '{"severity":"medium","verification":"any"}',
      },
    },
    { table: "finding", columns: { F6: "publication_disposition=inline_comment, reconciliation=new" } },
  ],
  notes: [
    "`incomplete` + `reviewer_stopped` maps to Check `failure` (ADR 0007, amended by #107).",
    "The two Limitations do not by themselves make the review unfinished; `unfinished` does.",
  ],
};

const S4: Scenario = {
  id: "S4",
  name: "Partial Result, no Findings",
  blurb:
    "The budget ran out before anything was claimed. No Review is published at all, so the Check is the only surface, and it must not read as a clean bill of health.",
  pullRequest: PR,
  run: {
    id: "4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa",
    status: "incomplete",
    trigger: "automatic",
    result: {
      completeness: "partial",
      stoppedBy: "budget_exhausted",
      summary:
        "Read the diff and started on the Slice driver. Stopped before making any claim.",
      disprovedHypothesisCount: 0,
      unfinished: null,
      limitations: [],
    },
    refusals: [],
    facts: facts({
      durationMs: 14 * 60_000 + 55_000,
      estimatedCostUsd: 5.02,
      usage: {
        completeness: "complete",
        inputTokens: 612_400,
        outputTokens: 20_100,
        cachedInputTokens: 300_220,
        reasoningTokens: 44_800,
      },
      providerDrift: null,
    }),
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause:
    "A partial Result carrying no Findings publishes no Review (ADR 0007): publishing it would assert a clean bill of health the Reviewer never gave.",
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa",
      status: "completed",
      conclusion: "timed_out",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 4d9b02fa…33aa",
        external_id: "reprove.run.4d9b02fa-cc17-4e55-9a84-2b7c1e6d33aa",
        check_run_id: "39 114 552 120",
        check_suite_id: "28 660 277",
        state: "published",
        github_review_id: "null - the Check was published, the Review was not",
        event: "null",
        applied_threshold: '{"severity":"medium","verification":"any"}',
      },
    },
    { table: "finding", columns: { "(no rows)": "the Run produced no Findings" } },
  ],
  notes: [
    "`incomplete` + budget exhaustion maps to Check `timed_out` (ADR 0007's table).",
    "Settled in round 2: `publication` is one row per **published Check**, not per Review. The row exists, carries the Check Run id, the check suite id and the `external_id`, and leaves `github_review_id` null. That is what makes a Check with no Review retryable and routable in a suite re-run.",
  ],
};

const S5: Scenario = {
  id: "S5",
  name: "Failure: the hard deadline passed",
  blurb:
    "Execution was authorized and never produced an acceptable Result. This is a Failure by name, and the next step is a re-run.",
  pullRequest: PR,
  run: {
    id: "5e3f77c1-9a40-4b12-8d66-fe01c9a2b7e4",
    status: "failed",
    trigger: "automatic",
    failure: {
      reason: "deadline_reached",
      detail:
        "the Reviewer was still in its turn at the hard stop, 20m after the turn started, and the bridge cannot interrupt a turn to collect a partial answer",
    },
    refusals: [],
    facts: facts({
      durationMs: 20 * 60_000,
      estimatedCostUsd: 3.77,
      usage: {
        completeness: "incomplete",
        inputTokens: 410_002,
        outputTokens: 0,
        cachedInputTokens: 210_500,
        reasoningTokens: null,
      },
      providerDrift: null,
    }),
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "A Run that fails publishes no Review (CONTEXT.md, Review).",
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.5e3f77c1-9a40-4b12-8d66-fe01c9a2b7e4",
      status: "completed",
      conclusion: "failure",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 5e3f77c1…b7e4",
        external_id: "reprove.run.5e3f77c1-9a40-4b12-8d66-fe01c9a2b7e4",
        check_run_id: "39 114 552 166",
        check_suite_id: "28 660 302",
        state: "published",
        github_review_id: "null - a Run that fails publishes no Review",
        event: "null",
      },
    },
    { table: "finding", columns: { "(no rows)": "no Result was accepted" } },
  ],
  notes: [
    "`deadline_reached` is a failure detail, not a `stoppedBy` value in Phase 1 (ADR 0020 §6).",
    "The turn was aborted mid-flight, so `outputTokens` is 0 and the aggregate is `incomplete` rather than `complete`; `reasoningTokens` is unknown and is not shown as zero.",
  ],
};

const S6: Scenario = {
  id: "S6",
  name: "Worker Refusal: policy_unenforceable",
  blurb:
    "A hosted Run was dispatched, spent a probe turn, and refused before the authorization line. It ends `unscheduled` with a non-empty `refusals`.",
  pullRequest: PR,
  run: {
    id: "6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26",
    status: "unscheduled",
    trigger: "automatic",
    refusals: [
      {
        origin: "worker",
        reason: "policy_unenforceable",
        required: "autonomy=inspect enforced by the Harness",
        actual:
          "codex 0.61.2 (artifact fingerprint sha256:4c19…a7) advertises no tool restriction below `verify`",
      },
    ],
    facts: facts({
      durationMs: 41_000,
      estimatedCostUsd: null,
      usage: {
        completeness: "incomplete",
        inputTokens: 1_204,
        outputTokens: 96,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      autonomy: { value: "inspect", provenance: "configured" },
      qualification: "unqualified",
      providerDrift: null,
    }),
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "Nothing executed past the authorization line, so there is no Result and no Review.",
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26",
      status: "completed",
      conclusion: "failure",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 6a0d4b93…0f26",
        external_id: "reprove.run.6a0d4b93-2fe8-41c7-9b55-73c8ad1e0f26",
        check_run_id: "39 114 552 209",
        check_suite_id: "28 660 344",
        state: "published",
        github_review_id: "null",
        event: "null",
      },
    },
    { table: "finding", columns: { "(no rows)": "no Result" } },
    {
      table: "run",
      columns: {
        status: "unscheduled",
        refusals: '[{ reason: "policy_unenforceable", required: …, actual: … }]',
        execution_token: "cleared in the same transaction as the status write (ADR 0023 §4)",
      },
    },
  ],
  notes: [
    "The probe Usage is real spend and is reported. Cost is `unknown`, not `$0.00`: the pricing revision does not price the probe's resolved model.",
    "`cachedInputTokens` and `reasoningTokens` were not reported by the probe, so the aggregate is `incomplete`.",
  ],
};

const S7: Scenario = {
  id: "S7",
  name: "No Worker found",
  blurb:
    "Also `unscheduled`, and it must not read like S6. Nothing was dispatched, nothing was spent, and `refusals` is empty.",
  pullRequest: PR,
  run: {
    id: "7c88ef20-5a63-4d09-91ba-c4e7f0d2136b",
    status: "unscheduled",
    trigger: "automatic",
    refusals: [],
    facts: facts({
      durationMs: null,
      estimatedCostUsd: 0,
      usage: {
        completeness: "complete",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      harness: { value: "codex", provenance: "configured" },
      providerDrift: null,
    }),
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "No Worker ever claimed the Run, so there is no Result and no Review.",
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.7c88ef20-5a63-4d09-91ba-c4e7f0d2136b",
      status: "completed",
      conclusion: "failure",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 7c88ef20…136b",
        external_id: "reprove.run.7c88ef20-5a63-4d09-91ba-c4e7f0d2136b",
        check_run_id: "39 114 552 251",
        check_suite_id: "28 660 388",
        state: "published",
        github_review_id: "null",
        event: "null",
      },
    },
    {
      table: "run",
      columns: {
        status: "unscheduled",
        refusals: "[] - this empty array is the whole difference from S6",
        claimable_until: "2026-09-21T14:32:00Z, expired",
      },
    },
  ],
  notes: [
    "Zero Usage here is a measured zero, not an unknown: no Worker claimed the Run and no turn was spent. S6's unknown is rendered differently on purpose.",
    "Whether a Run that was never claimed should carry a duration at all is open; this fixture leaves it null.",
  ],
};

const S8: Scenario = {
  id: "S8",
  name: "Control-plane Refusal, no Run",
  blurb:
    "The base configuration names functionality the product does not have. No Run is constructed, and the Refusal record is what the Check publishes from.",
  pullRequest: PR,
  run: null,
  refusalRecord: {
    id: "8f2a61d0-4c8b-49e3-a71f-05b3d9e8c247",
    refusal: {
      origin: "control_plane",
      reason: "config_unsupported",
      required: "review.strategy is one of: standard",
      actual: "review.strategy: adversarial",
      keyPath: "review.strategy",
      line: 12,
    },
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "There is no Run, so there is nothing to publish a Review from.",
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.refusal.8f2a61d0-4c8b-49e3-a71f-05b3d9e8c247",
      status: "completed",
      conclusion: "failure",
    },
  ],
  state: [
    {
      table: "refusal",
      columns: {
        id: "8f2a61d0…c247",
        reason: "config_unsupported",
        key_path: "review.strategy",
        head_sha: short(PR.headSha),
        base_sha: `${short(PR.baseSha)} (the ref the file was read from)`,
        trigger: "automatic",
      },
    },
    {
      table: "publication",
      columns: {
        subject: "refusal 8f2a61d0…c247",
        external_id: "reprove.refusal.8f2a61d0-4c8b-49e3-a71f-05b3d9e8c247",
        check_run_id: "39 114 552 001",
        check_suite_id: "28 660 145",
        state: "published",
        github_review_id: "null - a Refusal has no Run and publishes no Review",
        event: "null",
      },
    },
  ],
  notes: [
    "The Refusal Check's `external_id` names a `refusal` record, not a Run. A handle that could mean either is not a handle (ADR 0022 §3).",
    "`keyPath` is what the record stores; `line` is optional and only present while the loader still holds the parse. The next step always names the key and names the line only when there is one.",
  ],
};

const f1Recurring: Finding = {
  ...f1,
  key: "F1'",
  publicationDisposition: "suppressed_dedupe",
  reconciliation: "recurring",
  suppressedAgainstRunId: "1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
};

const f7: Finding = {
  key: "F7",
  title: "The retry backoff is unbounded, so a stuck Slice pins a Sandbox for the whole deadline",
  body: [
    "The new retry loop multiplies the delay without a ceiling and without a total attempt",
    "budget, so a Sandbox stays alive until the hard deadline collects it.",
  ].join(" "),
  severity: "high",
  verification: "verified",
  location: { path: "packages/worker-hosted/src/slice.ts", startLine: 166, endLine: 169 },
  anchoredText: "    delay = delay * 2;",
  evidence: [
    {
      command: "pnpm vitest run packages/worker-hosted/src/slice.test.ts -t 'backoff'",
      exitCode: 1,
      durationMs: 9_120,
      excerpt: [
        "FAIL  driveSlice > backoff is bounded",
        "AssertionError: expected 524288 to be less than or equal to 30000",
      ].join("\n"),
      truncated: false,
      originalByteLength: 142,
    },
  ],
  inDiff: true,
  hunk: {
    header: "@@ -164,6 +164,10 @@ const withRetry = async (fn: () => Promise<void>) => {",
    lines: [
      { kind: "ctx", line: 164, text: "  let delay = 250;" },
      { kind: "ctx", line: 165, text: "" },
      { kind: "add", line: 166, text: "  for (;;) {" },
      { kind: "add", line: 167, text: "    try { return await fn(); } catch { /* retry */ }" },
      { kind: "add", line: 168, text: "    await sleep(delay);" },
      { kind: "add", line: 169, text: "    delay = delay * 2;" },
      { kind: "ctx", line: 170, text: "  }" },
    ],
  },
  publicationDisposition: "inline_comment",
  reconciliation: "new",
};

const S9: Scenario = {
  id: "S9",
  name: "Second Run on the same pull request",
  blurb:
    "A push produced a new Run. One Finding recurs and its Comment is suppressed, one is new and is published, and one from the first Run did not come back.",
  pullRequest: {
    ...PR,
    headSha: "b7d02e4a1c93f85062ba4d7e19c05f3a8e2d6b41",
  },
  run: {
    id: "9a15c7e3-6d02-4f8b-90a4-1c7e5b3d8f22",
    status: "completed",
    trigger: "automatic",
    result: {
      completeness: "complete",
      stoppedBy: null,
      summary:
        "Re-reviewed after the push. The clean-close defect is unchanged. The new retry loop adds an unbounded backoff.",
      disprovedHypothesisCount: 2,
      unfinished: null,
      limitations: [],
    },
    refusals: [],
    facts: facts({
      durationMs: 7 * 60_000 + 6_000,
      estimatedCostUsd: 1.18,
      usage: {
        completeness: "complete",
        inputTokens: 160_880,
        outputTokens: 10_440,
        cachedInputTokens: 88_100,
        reasoningTokens: 6_010,
      },
      providerDrift: null,
    }),
  },
  findings: [f1Recurring, f7],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: { event: "COMMENT" },
  prior: {
    runId: "1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
    recurring: [
      {
        key: "F1'",
        priorCommentUrl:
          "https://github.com/nick-neely/reprove/pull/412#discussion_r2411903776",
      },
    ],
    gone: [
      {
        title: "Comments past the cap are dropped without a record, so a Finding disappears",
        path: "packages/control-plane/src/github/publish.ts",
        prior: "anchor_changed",
      },
      {
        title: "The webhook body is read before the signature is checked",
        path: "apps/control-plane/src/app/api/webhook/route.ts",
        prior: "not_reproduced",
      },
    ],
  },
  checks: [
    {
      name: "Reprove",
      kind: "review",
      externalId: "reprove.run.9a15c7e3-6d02-4f8b-90a4-1c7e5b3d8f22",
      status: "completed",
      conclusion: "success",
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 9a15c7e3…8f22",
        external_id: "reprove.run.9a15c7e3-6d02-4f8b-90a4-1c7e5b3d8f22",
        check_run_id: "39 114 553 004",
        check_suite_id: "28 660 902",
        state: "published",
        github_review_id: "2 412 110 441",
        event: "COMMENT",
        reconciled_against_run_id: "1f0c8a5e…55d1",
        prior_reconciliation:
          '[{path:"…/publish.ts", prior:"anchor_changed"}, {path:"…/route.ts", prior:"not_reproduced"}]',
      },
    },
    {
      table: "finding",
      columns: {
        "F1'": "publication_disposition=suppressed_dedupe, reconciliation=recurring",
        F7: "publication_disposition=inline_comment, reconciliation=new",
      },
    },
  ],
  notes: [
    "`anchor_changed` and `not_reproduced` are internal and may never become user-facing prose (ADR 0007). No variant claims either Finding was fixed; the state panel is the only place they appear.",
    "The bucket key is `path + normalized anchored-source hash`. Severity is excluded from it, so a re-rated Finding still matches.",
    "Settled in round 2: a recurring Finding keeps its index row, marked `still open from the previous review` and linking the prior Comment. Earlier Findings that are no longer reported get a count line and a collapsed list, with no claim either way about why.",
  ],
};

const S10: Scenario = {
  id: "S10",
  name: "Visible no-op re-runs",
  blurb:
    "Three re-runs that must do nothing and must say so. The prior conclusion is re-asserted with a line explaining why nothing ran.",
  pullRequest: PR,
  run: {
    id: "1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
    status: "completed",
    trigger: "manual",
    result: {
      completeness: "complete",
      stoppedBy: null,
      summary: "(the original Run's Result; unchanged by any of these re-runs)",
      disprovedHypothesisCount: 4,
      unfinished: null,
      limitations: [],
    },
    refusals: [],
    facts: facts(),
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "Nothing ran, so nothing is published beyond the re-asserted Check.",
  checks: [
    {
      name: "Reprove",
      kind: "noop",
      externalId: "reprove.run.1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
      status: "completed",
      conclusion: "success",
      reassertedFrom: "success",
      noop: {
        reason: "stale_head",
        detail: `this Check was published for ${short(PR.headSha)}; the pull request's head is now b7d02e4`,
      },
    },
    {
      name: "Reprove",
      kind: "noop",
      externalId: "reprove.run.1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
      status: "completed",
      conclusion: "success",
      reassertedFrom: "success",
      noop: { reason: "closed", detail: "the pull request is closed" },
    },
    {
      name: "Reprove",
      kind: "noop",
      externalId: "reprove.run.1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
      status: "completed",
      conclusion: "success",
      reassertedFrom: "success",
      noop: {
        reason: "equivalent_live_run",
        detail:
          "an equivalent Run is already executing at this head and base under the same resolved configuration",
      },
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run 1f0c8a5e…55d1 (the existing row, unchanged)",
        external_id: "reprove.run.1f0c8a5e-7b31-4a90-9d62-0c1e4a7b55d1",
        check_run_id: "39 114 552 010 - the same Check Run, updated in place",
        check_suite_id: "28 660 145",
        github_review_id: "2 411 903 776, unchanged",
        note: "no new row. A no-op re-run republishes the Check output and touches nothing else.",
      },
    },
    {
      table: "ingress ledger",
      columns: {
        stale_head: "done, no-op: stale head",
        closed: "done, no-op: pull request closed",
        equivalent_live_run: "done, no-op: equivalent live Run",
      },
    },
  ],
  notes: [
    "A rerequest resets the check *suite* to `queued` and clears its conclusion; the Check Run itself is not updated by GitHub. Whether re-asserting the old conclusion settles the suite is unverified (ADR 0022 §5) and is what this ticket has to test against real GitHub.",
    "The third case is the only one where a Run is live. The equivalent live Run finishes on its own and a re-run after it ends creates a fresh Run.",
    "Settled in round 2: the conclusion is re-asserted unchanged, so the colour cannot carry the no-op. The Check **title** carries it instead - `Re-run ignored: head is stale` - because the title is the one field GitHub shows beside the conclusion in the collapsed Checks list.",
  ],
};

const S11: Scenario = {
  id: "S11",
  name: "In progress",
  blurb:
    "The two nonterminal Checks. Neither carries a conclusion and neither carries terminal facts, because none exist yet.",
  pullRequest: PR,
  run: {
    id: "c0ffee11-2233-4455-6677-8899aabbccdd",
    status: "queued",
    trigger: "automatic",
    refusals: [],
    facts: null,
  },
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "The Run has not produced a Result.",
  checks: [
    {
      name: "Reprove",
      kind: "progress",
      externalId: "reprove.run.c0ffee11-2233-4455-6677-8899aabbccdd",
      status: "queued",
      conclusion: null,
    },
    {
      name: "Reprove",
      kind: "progress",
      externalId: "reprove.run.c0ffee11-2233-4455-6677-8899aabbccdd",
      status: "in_progress",
      conclusion: null,
    },
  ],
  state: [
    {
      table: "publication",
      columns: {
        subject: "run c0ffee11…ccdd",
        external_id: "reprove.run.c0ffee11-2233-4455-6677-8899aabbccdd",
        check_run_id: "39 114 554 771 - written as soon as GitHub answers",
        check_suite_id: "28 661 010",
        state: "published (the Check) / pending (the Review)",
        github_review_id: "null",
        attempts: "[]",
      },
    },
    {
      table: "run",
      columns: {
        status: "queued, then executing",
        note: "`executing` is written by the hosted pass's own first step, before the probe (ADR 0023 §3)",
      },
    },
  ],
  notes: [
    "Settled in round 2: `claimed` renders as Check status `queued`. A claimed Run has an owner but has not begun, and `in_progress` is reserved for `executing`, which the hosted pass writes as its own first step.",
    "A Check published at creation is what makes the re-run button exist. Without it a pull request has no manual surface at all (ADR 0022 §1).",
  ],
};

const C1: Scenario = {
  id: "C1",
  name: "Reprove config Check: valid",
  blurb:
    "The pull request changes `.reprove.yml`. This Check reports what would apply if merged, never what applied, and it runs independently of review execution.",
  pullRequest: PR,
  run: null,
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "A config Check publishes no Review; it is a Check and nothing else.",
  config: {
    recordId: "c1d7e402-88a6-4f31-b05c-7a2e9d641f30",
    valid: true,
    filePath: ".reprove.yml",
    effective: [
      { key: "review.enabled", value: "true", note: "configured" },
      { key: "review.harness", value: "codex", note: "configured" },
      { key: "review.model", value: "gpt-5.6-sol", note: "configured" },
      { key: "review.autonomy", value: "verify", note: "default" },
      { key: "review.deadline", value: "20m", note: "configured" },
      { key: "review.event", value: "COMMENT", note: "default" },
      { key: "review.threshold.severity", value: "high", note: "configured, was medium" },
      { key: "review.threshold.verification", value: "any", note: "default" },
      { key: "review.ignore", value: "generated/**, vendor/**", note: "configured" },
      { key: "review.budget", value: "USD 5.00", note: "configured" },
    ],
    narrowed: [
      {
        key: "security.maxExposure",
        requested: "account",
        effective: "scoped",
        by: "Reprove boundary",
      },
    ],
  },
  checks: [
    {
      name: "Reprove config",
      kind: "config",
      externalId: "reprove.config.c1d7e402-88a6-4f31-b05c-7a2e9d641f30",
      status: "completed",
      conclusion: "success",
    },
  ],
  state: [
    {
      table: "config_validation",
      columns: {
        id: "c1d7e402…1f30",
        owner_id: "Owner-scoped and RLS-covered, like every tenant row",
        repository_id: "nick-neely/reprove",
        pull_request_number: "412",
        head_sha: short(PR.headSha),
        outcome: "valid",
        resolved: "the ten effective values, plus the one narrowing",
        error: "null",
      },
    },
    {
      table: "publication",
      columns: {
        subject: "config_validation c1d7e402…1f30",
        external_id: "reprove.config.c1d7e402-88a6-4f31-b05c-7a2e9d641f30",
        check_run_id: "39 114 552 500",
        check_suite_id: "28 660 145 - the same suite as the review Check at this head",
        state: "published",
        github_review_id: "null - a config Check publishes no Review",
        event: "null",
      },
    },
  ],
  notes: [
    "Settled in round 2: the config Check publishes from a **config validation record**, the third subject a `publication` row can have beside a Run and a `refusal`. That gives it the `external_id`, the Check Run id and the suite id ADR 0022 §3 requires, and something for durable publication retry to target.",
    "ADR 0019 gives Phase 1 no Owner layer, so the only term left in the meet is the Reprove boundary. The narrowing is labelled as such rather than implying a ceiling that does not exist.",
    "This Check runs even when `enabled: false`, when no Worker is online, and when the Run is Refused for an unrelated reason.",
  ],
};

const C2: Scenario = {
  id: "C2",
  name: "Reprove config Check: invalid",
  blurb:
    "The head file has an unknown key. The Check fails and points at the line. The review Check is unaffected, because it reports the Run under the base configuration.",
  pullRequest: PR,
  run: null,
  findings: [],
  threshold: { severity: "medium", verification: "any" },
  ignore: [],
  review: null,
  noReviewBecause: "A config Check publishes no Review.",
  config: {
    recordId: "c2a91b6f-30d4-4e17-9c88-6b0f5e2d7a43",
    valid: false,
    filePath: ".reprove.yml",
    effective: [],
    narrowed: [],
    error: {
      keyPath: "review.autonmy",
      line: 9,
      message:
        "unknown key `review.autonmy`. Unknown keys are rejected, never ignored. Did you mean `review.autonomy`?",
    },
  },
  checks: [
    {
      name: "Reprove config",
      kind: "config",
      externalId: "reprove.config.c2a91b6f-30d4-4e17-9c88-6b0f5e2d7a43",
      status: "completed",
      conclusion: "failure",
    },
  ],
  state: [
    {
      table: "config_validation",
      columns: {
        id: "c2a91b6f…7a43",
        repository_id: "nick-neely/reprove",
        pull_request_number: "412",
        head_sha: short(PR.headSha),
        outcome: "invalid",
        resolved: "null",
        error: '{"keyPath":"review.autonmy","line":9,"message":"unknown key"}',
      },
    },
    {
      table: "publication",
      columns: {
        subject: "config_validation c2a91b6f…7a43",
        external_id: "reprove.config.c2a91b6f-30d4-4e17-9c88-6b0f5e2d7a43",
        check_run_id: "39 114 552 512",
        check_suite_id: "28 660 145",
        state: "published",
        github_review_id: "null",
        event: "null",
      },
    },
    {
      table: "refusal",
      columns: {
        "(no row)":
          "the head file is prospective data and is never applied, so an invalid head is not a Refusal. `refusal` records a base-ref Refusal (S8), which is a different thing.",
      },
    },
  ],
  notes: [
    "The review Check for the same pull request can be green at the same time, and that is correct: mixing them would let a broken head file report failure for a Run that succeeded (ADR 0011 §8).",
    "The config validation record is what makes a failed publication of this Check recoverable with no further pull request event, which ADR 0022 §1 requires.",
  ],
};

export const scenarios: Scenario[] = [
  S1,
  S2,
  S3,
  S4,
  S5,
  S6,
  S7,
  S8,
  S9,
  S10,
  S11,
  C1,
  C2,
];
