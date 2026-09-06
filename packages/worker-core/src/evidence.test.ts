/**
 * The Evidence cross-check: the comparison that turns a Reviewer's claim into
 * Evidence Reprove will carry.
 *
 * The property under test is narrow on purpose. It proves the Harness observed
 * the execution; it does not prove the output supports the Finding, and it
 * never rewrites a Finding's Verification.
 */
import { protocolLimits } from "@reprove/protocol/v1";
import { describe, expect, it } from "vitest";

import type { CandidateFinding, ClaimedEvidence } from "./adapter.js";
import { crossCheckEvidence } from "./evidence.js";

const claim = (
  command: string,
  overrides: Partial<ClaimedEvidence> = {}
): ClaimedEvidence => ({
  command,
  exitCode: 0,
  durationMs: 1200,
  output: "3 passed",
  ...overrides,
});

const candidate = (
  overrides: Partial<CandidateFinding> = {}
): CandidateFinding => ({
  title: "The pooled connection outlives its client",
  body: "Session state set here survives into the next transaction.",
  severity: "high",
  verification: "verified",
  location: { path: "src/db/pool.ts", startLine: 42, endLine: 44 },
  anchoredText: "await client.query('SET app.owner = $1', [ownerId]);",
  evidence: [claim("pnpm vitest run src/db/pool.test.ts")],
  ...overrides,
});

describe("the Evidence cross-check", () => {
  it("carries a claim the Adapter observed, bounded", () => {
    const checked = crossCheckEvidence({
      findings: [candidate()],
      observed: [
        { command: "pnpm vitest run src/db/pool.test.ts", exitCode: 0 },
      ],
    });

    expect(checked.complaint).toBeNull();
    expect(checked.findings?.[0]?.evidence).toStrictEqual([
      {
        command: "pnpm vitest run src/db/pool.test.ts",
        exitCode: 0,
        durationMs: 1200,
        excerpt: "3 passed",
        truncated: false,
        originalByteLength: 8,
      },
    ]);
  });

  it("bounds an excerpt and records what it cut", () => {
    const output = "x".repeat(protocolLimits.evidenceExcerptChars + 500);
    const checked = crossCheckEvidence({
      findings: [candidate({ evidence: [claim("pnpm test", { output })] })],
      observed: [{ command: "pnpm test", exitCode: 0 }],
    });
    const evidence = checked.findings?.[0]?.evidence[0];

    expect(evidence?.excerpt).toHaveLength(protocolLimits.evidenceExcerptChars);
    expect(evidence?.truncated).toBeTruthy();
    expect(evidence?.originalByteLength).toBe(output.length);
  });

  it("cuts an excerpt at a whole code point rather than mid-character", () => {
    // The offset makes the bound land inside a surrogate pair. Cutting there
    // would put an unpaired half into a field a human reads, which is content
    // the command never emitted.
    const emoji = "\u{1F600}";
    const output = `a${emoji.repeat(protocolLimits.evidenceExcerptChars)}`;
    const checked = crossCheckEvidence({
      findings: [candidate({ evidence: [claim("pnpm test", { output })] })],
      observed: [{ command: "pnpm test", exitCode: 0 }],
    });
    const excerpt = checked.findings?.[0]?.evidence[0]?.excerpt ?? "";

    expect(excerpt).toBe(
      `a${emoji.repeat(protocolLimits.evidenceExcerptChars / 2 - 1)}`
    );
    expect(excerpt.length).toBeLessThan(protocolLimits.evidenceExcerptChars);
    expect([...excerpt].at(-1)).toBe(emoji);
  });

  it("complains when a claimed command has no observed counterpart", () => {
    const checked = crossCheckEvidence({
      findings: [candidate()],
      observed: [{ command: "pnpm lint", exitCode: 0 }],
    });

    expect(checked.findings).toBeNull();
    expect(checked.complaint).toStrictEqual({
      reason: "evidence_unsupported",
      detail:
        'the Reviewer claimed Evidence the Adapter never observed: "pnpm vitest run src/db/pool.test.ts" on the Finding "The pooled connection outlives its client"',
    });
  });

  it("complains about an unobserved claim whatever Verification it carries", () => {
    // ADR 0005 names the `verified` case, and the rule here is deliberately
    // wider: a Finding claiming Evidence Reprove never observed is a fabricated
    // record whatever standing the Reviewer assigned it. Dropping the claim
    // instead would be a quiet rewrite of the Finding.
    const checked = crossCheckEvidence({
      findings: [candidate({ verification: "inconclusive" })],
      observed: [],
    });

    expect(checked.complaint?.reason).toBe("evidence_unsupported");
  });

  it("does not let one observed call support two claims of it", () => {
    const checked = crossCheckEvidence({
      findings: [
        candidate({ evidence: [claim("pnpm test"), claim("pnpm test")] }),
      ],
      observed: [{ command: "pnpm test", exitCode: 0 }],
    });

    expect(checked.complaint?.reason).toBe("evidence_unsupported");
  });

  it("does not match an observed call that exited differently", () => {
    const checked = crossCheckEvidence({
      findings: [
        candidate({ evidence: [claim("pnpm test", { exitCode: 1 })] }),
      ],
      observed: [{ command: "pnpm test", exitCode: 0 }],
    });

    expect(checked.complaint?.reason).toBe("evidence_unsupported");
  });

  it("never rewrites a Verification it could not support", () => {
    // The whole point of complaining rather than downgrading: ADR 0002 makes
    // Verification the whole trust signal a Finding carries.
    const checked = crossCheckEvidence({
      findings: [candidate()],
      observed: [],
    });

    expect(checked.findings).toBeNull();
  });

  it("carries a reasoned-only Finding through untouched", () => {
    // A claim reached by reasoning alone is still a Finding: verification
    // raises a Finding's standing, it does not admit it. This is what keeps
    // `inspect` - which may read and not execute - able to produce Findings.
    const reasoned = candidate({ verification: "static", evidence: [] });
    const checked = crossCheckEvidence({
      findings: [reasoned],
      observed: [],
    });

    expect(checked.complaint).toBeNull();
    expect(checked.findings?.[0]).toStrictEqual({
      title: reasoned.title,
      body: reasoned.body,
      severity: "high",
      verification: "static",
      location: reasoned.location,
      anchoredText: reasoned.anchoredText,
      evidence: [],
    });
  });

  it("carries a Patch through as the Finding made it", () => {
    const patch = {
      path: "src/db/pool.ts",
      startLine: 42,
      endLine: 42,
      replacement: "await client.query('SELECT set_config($1, $2, true)');",
    };
    const checked = crossCheckEvidence({
      findings: [candidate({ verification: "static", evidence: [], patch })],
      observed: [],
    });

    expect(checked.findings?.[0]?.patch).toStrictEqual(patch);
  });
});
