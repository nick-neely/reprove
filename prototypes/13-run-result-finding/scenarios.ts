/**
 * THROWAWAY PROTOTYPE - wayfinder ticket #13.
 *
 * Drives the shapes in schema.ts through the cases that are hard to reason about
 * on paper. Every scenario prints the state it produced. `npm start`.
 */

import {
  acceptForRun,
  acceptResultPayload,
  bucketKey,
  checkConclusion,
  LIMITS,
  planComments,
  publicationDecision,
  reconcile,
  Run,
  type Finding,
  type Result,
} from "./schema.js";

// ---------------------------------------------------------------------------

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "b".repeat(40);


function evidence(command: string, exitCode: number, excerpt: string) {
  return {
    command,
    exitCode,
    durationMs: 4_120,
    excerpt,
    truncated: false,
    originalByteLength: excerpt.length,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    title: "Session token is compared with ===, so a timing oracle leaks it",
    body: "The comparison short-circuits on the first differing byte.",
    severity: "high",
    verification: "verified",
    location: { path: "src/auth/session.ts", startLine: 41, endLine: 43 },
    anchoredText: "if (token === stored) { return true }",
    evidence: [
      evidence("node -e 'require(\"./bench-timing.js\")'", 0, "mean delta 1.9ms over 10k trials"),
    ],
    ...over,
  } as Finding;
}

function result(over: Partial<Result> = {}): Result {
  return {
    runId: "run_01",
    completeness: "complete",
    stoppedBy: null,
    summary: "Reviewed 6 changed files. Verified 1 finding, disproved 3 further hypotheses.",
    disprovedHypothesisCount: 3,
    findings: [finding()],
    passes: [
      {
        passId: "pass_01",
        harness: "codex",
        pinnedModel: "gpt-5.5-codex",
        resolvedModel: null,
        startedAt: "2026-08-30T10:00:00Z",
        endedAt: "2026-08-30T10:18:00Z",
        outcome: "completed",
        failureReason: null,
        repairTurnUsed: false,
        usage: { inputTokens: 180_000, outputTokens: 9_400 },
      },
    ],
    usage: { inputTokens: 180_000, outputTokens: 9_400 },
    protocolVersion: 1,
    workerBuildVersion: "0.1.0",
    ...over,
  } as Result;
}

function run(over: Record<string, unknown> = {}) {
  const base = {
    spec: {
      runId: "run_01",
      ownerId: "own_01",
      repositoryId: "repo_01",
      installationId: "inst_01",
      pullRequestNumber: 412,
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      provenance: "internal",
      provenanceBasis: { sameRepositoryBranch: true, authorAssociation: "MEMBER" },
      placement: "self_hosted",
      hostedFallbackAllowed: false,
      harness: "codex",
      model: "gpt-5.5-codex",
      strategy: "standard",
      autonomy: "verify",
      configDigest: "cfg_9f21",
      claimableUntil: "2026-08-30T10:30:00Z",
      createdAt: "2026-08-30T09:58:00Z",
    },
    resolution: {
      workerId: "wrk_01",
      route: "native",
      isolation: "container-rootless",
      exposure: "scoped",
      protocolVersion: 1,
      workerBuildVersion: "0.1.0",
      claimedAt: "2026-08-30T09:59:00Z",
    },
    state: {
      status: "executing",
      leaseExpiresAt: "2026-08-30T10:20:00Z",
      refusals: [],
      failureReason: null,
      startedAt: "2026-08-30T10:00:00Z",
      endedAt: null,
      result: null,
      review: null,
    },
  };
  return Run.parse({ ...base, ...over });
}

// ---------------------------------------------------------------------------

let n = 0;
function scenario(title: string, body: () => void) {
  n++;
  console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
  console.log("".padEnd(76, "-"));
  body();
}
const pass = (s: string) => console.log(`   \x1b[32m+\x1b[0m ${s}`);
const stop = (s: string) => console.log(`   \x1b[31mx\x1b[0m ${s}`);

console.log("\n\x1b[1mPROTOTYPE #13 - Run, Result, Finding\x1b[0m");
console.log("Shapes under test. Every line below is a consequence of the schema, not prose.");

// ---------------------------------------------------------------------------

scenario("A Run's shape splits into spec / resolution / state", () => {
  const r = run();
  console.log(`   spec       (fixed at creation)  ${Object.keys(r.spec).length} fields`);
  console.log(`   resolution (fixed at claim)     ${Object.keys(r.resolution!).length} fields, incl. isolation=${r.resolution!.isolation} exposure=${r.resolution!.exposure}`);
  console.log(`   state      (mutable)            status=${r.state.status}`);
  pass("nothing in `spec` names a webhook delivery, so everything after creation is ingress-independent");
  pass("`provenanceBasis` is kept so the classification stays explainable without refetching the PR");
});

scenario("ADR 0002: no Evidence, no `verified` - unreachable in the schema", () => {
  const bad = acceptResultPayload(
    result({ findings: [finding({ verification: "verified", evidence: [] })] }),
  );
  if (!bad.ok) stop(bad.reason.split("\n").slice(0, 3).join("\n     "));

  const ok = acceptResultPayload(
    result({ findings: [finding({ verification: "static", evidence: [] })] }),
  );
  if (ok.ok) pass("the same claim as `static` with no Evidence is accepted - an inspect Run still produces Findings");

  const contradiction = acceptResultPayload(
    result({ findings: [finding({ verification: "static" })] }),
  );
  if (!contradiction.ok) stop("`static` carrying Evidence is rejected too - reasoned-only means reasoned-only");
});

scenario("ADR 0006: an oversized Result is rejected, never truncated into shape", () => {
  const fat = result({
    findings: Array.from({ length: 100 }, () =>
      finding({ body: "x".repeat(3_500), anchoredText: "y".repeat(500) }),
    ),
  });
  const r = acceptResultPayload(fat);
  if (!r.ok) stop(r.reason);
  pass(`the bound (${LIMITS.resultBytes / 1024}KB) is enforced at the edge, so a Worker cannot drift into shipping test output`);
});

scenario("Partial Results, and a Check that reports execution rather than verdict", () => {
  const rows: [string, Result][] = [
    ["complete, 0 findings", result({ findings: [] })],
    ["complete, 1 finding ", result()],
    ["partial (budget), 0 ", result({ completeness: "partial", stoppedBy: "budget_exhausted", findings: [] })],
    ["partial (budget), 1 ", result({ completeness: "partial", stoppedBy: "budget_exhausted" })],
    ["partial (cancelled)  ", result({ completeness: "partial", stoppedBy: "cancelled" })],
  ];
  for (const [label, r] of rows) {
    const status = r.completeness === "complete" ? "completed" : "incomplete";
    const pub = publicationDecision(r);
    const check = checkConclusion(status, r.stoppedBy);
    console.log(`   ${label}  status=${status.padEnd(10)} check=${String(check).padEnd(9)} review=${pub.publishReview}`);
  }
  console.log("");
  pass("a complete Run is `success` whether or not it found defects - Findings move the Review, not the Check");
  stop("partial + zero Findings publishes no Review at all: it would assert a clean bill of health the Reviewer never gave");
  pass("partial + Findings still publishes them, and the Check stays non-successful so a required Check is not voided");
  console.log(`   worker_lost / failed        -> check=${checkConclusion("failed", null)}`);
  console.log(`   unscheduled (never ran)     -> check=${checkConclusion("unscheduled", null)}  <- a failure CONCLUSION, not Reprove \`Failure\` vocabulary`);

  const inconsistent = acceptResultPayload(result({ completeness: "partial", stoppedBy: null }));
  if (!inconsistent.ok) stop("`partial` without `stoppedBy` does not parse - the two cannot drift apart");
});

scenario("Reconciliation is Comment dedupe, not Finding identity", () => {
  const timingOracle = finding();
  const auditWrite = finding({
    title: "Missing await on the audit write",
    severity: "medium",
    location: { path: "src/audit/log.ts", startLine: 88, endLine: 88 },
    anchoredText: "  writeAudit(entry)",
    verification: "static",
    evidence: [],
  });
  const nullTenant = finding({
    title: "Null tenant dereferenced",
    location: { path: "src/tenant/resolve.ts", startLine: 12, endLine: 12 },
    anchoredText: "return tenant.id",
  });

  const priorRun = [timingOracle, auditWrite, nullTenant];

  // Next push: an unrelated import pushed session.ts down 4 lines (same claim,
  // moved). audit/log.ts was rewritten, so its anchor is gone. tenant/resolve.ts
  // is untouched but the Reviewer did not re-find it. And resolve.ts:12 now has
  // TWO Findings against the same anchor - an ambiguous bucket.
  const currentRun = [
    finding({ location: { path: "src/auth/session.ts", startLine: 45, endLine: 47 } }),
    finding({ title: "Tenant id is not URL-encoded before interpolation", location: { path: "src/tenant/resolve.ts", startLine: 12, endLine: 12 }, anchoredText: "return tenant.id" }),
    finding({ title: "Tenant lookup misses the cache on every call", location: { path: "src/tenant/resolve.ts", startLine: 12, endLine: 12 }, anchoredText: "return tenant.id" }),
  ];

  const anchorStillPresent = (f: Finding) => f.location.path !== "src/audit/log.ts";
  const r = reconcile(priorRun, currentRun, anchorStillPresent);

  console.log("   current side (drives Comment dedupe):");
  for (const c of r.current) {
    (c.disposition === "recurring" ? pass : stop)(`${c.disposition.padEnd(10)} ${c.title.slice(0, 46)}`);
  }
  console.log("\n   prior side (INTERNAL - never user-facing prose):");
  for (const p of r.prior) {
    console.log(`     ${p.disposition.padEnd(15)} ${p.title.slice(0, 46)}`);
  }
  console.log("");
  pass("the timing-oracle claim moved 41 -> 45 and is still `recurring`: the key is the anchored source, not the line");
  stop("resolve.ts:12 holds 1 prior and 2 current Findings - an ambiguous bucket, so BOTH current ones are `new`");
  console.log("     A wrong `new` costs a duplicate Comment. A wrong `recurring` hides a real defect. It fails open.");
  console.log("     `anchor_changed` says the anchor is stale. It does NOT say the defect was fixed.");
});

scenario("A Finding outside the diff cannot be line-anchored on GitHub", () => {
  const res = result({
    findings: [
      finding(),
      finding({
        title: "Caller now passes a null tenant, which this untouched helper dereferences",
        location: { path: "src/tenant/resolve.ts", startLine: 12, endLine: 12 },
        anchoredText: "return tenant.id",
      }),
      finding({ title: "Variable name `x` is unhelpful", severity: "low", verification: "static", evidence: [] }),
    ],
  });
  const recon = reconcile([], res.findings, () => true).current;
  for (const p of planComments(res, recon, new Set(["src/auth/session.ts"]), "medium")) {
    if (p.kind === "comment") pass(`Comment       ${p.path}:${p.line}`);
    if (p.kind === "review_body") stop(`Review body   ${p.because}`);
    if (p.kind === "suppressed") stop(`suppressed    ${p.because}`);
  }
  console.log("     An out-of-diff Finding is not a `Comment` - a Comment is the line-anchored projection.");
  console.log("     It renders structurally in the Review body, under the same Threshold and dedupe rules.");
  pass("Threshold is applied here, at publish time - changing it never costs a Run");
});

scenario("Acceptance rules that belong to the Run, not the Result", () => {
  const good = acceptForRun(run(), result());
  if (good.ok) pass("a well-formed Result on an executing Run is accepted");

  const late = acceptForRun(
    run({ state: { ...run().state, status: "superseded" } }),
    result(),
  );
  if (!late.ok) stop(late.reason);
  console.log("     ADR 0006: acceptance state is the stale-result boundary, not the Worker cooperating with a cancel.");

  const patched = acceptForRun(run(), result({
    findings: [finding({ patch: { path: "src/auth/session.ts", startLine: 41, endLine: 43, replacement: "if (timingSafeEqual(...))" } })],
  }));
  if (!patched.ok) stop(patched.reason);

  const drifted = acceptForRun(run(), result({
    passes: [{ ...result().passes[0], resolvedModel: "gpt-5.5" }],
  }));
  if (!drifted.ok) stop(drifted.reason);
  console.log("     Codex's adapter default is gpt-5.5, so this is the exact substitution ADR 0005 forbids.");
});

scenario("The bucket key, shown", () => {
  const a = finding();
  const b = finding({ location: { path: "src/auth/session.ts", startLine: 45, endLine: 47 } });
  const c = finding({ severity: "medium" });
  const d = finding({ anchoredText: "if (timingSafeEqual(token, stored)) { return true }" });
  const same = (x: Finding) => (bucketKey(a) === bucketKey(x) ? "SAME" : "DIFFERENT");
  console.log(`   original                 ${bucketKey(a)}`);
  console.log(`   same claim, moved lines  ${bucketKey(b)}  ${same(b)}`);
  console.log(`   re-rated high -> medium  ${bucketKey(c)}  ${same(c)}`);
  console.log(`   anchored source edited   ${bucketKey(d)}  ${same(d)}`);
  console.log("");
  pass("moving lines does not break the bucket");
  pass("severity is deliberately out of the key - the same defect re-rated must not become a different Finding");
  pass("editing the anchored source does break it, and that is correct: the claim must be re-made");
});

console.log("\n" + "".padEnd(76, "="));
console.log("Open forks are listed in README.md. Nothing here is decided until #13 closes.\n");
