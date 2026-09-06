import { z } from "zod";

import type { AdapterPassOutput, CandidateFinding } from "./types.js";

const location = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
const finding = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  verification: z.enum(["verified", "inconclusive", "static"]),
  location,
  anchoredText: z.string(),
  evidence: z.array(
    z.object({
      command: z.string().min(1),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative(),
      output: z.string(),
    })
  ),
  patch: location.extend({ replacement: z.string() }).nullable(),
});
const answer = z.object({
  summary: z.string().min(1),
  disprovedHypothesisCount: z.number().int().nonnegative(),
  findings: z.array(finding),
});
export const ANSWER_SCHEMA = z.toJSONSchema(answer);

export const parseAnswer = (
  text: string
): Pick<
  AdapterPassOutput,
  "summary" | "disprovedHypothesisCount" | "findings"
> => {
  if (Buffer.byteLength(text) > 1024 * 1024) {
    throw new Error("Codex answer exceeds the Pass limit");
  }
  const value = answer.parse(JSON.parse(text));
  return {
    summary: value.summary,
    disprovedHypothesisCount: value.disprovedHypothesisCount,
    findings: value.findings.map((item): CandidateFinding => {
      const { patch, ...candidate } = item;
      return patch === null ? candidate : { ...candidate, patch };
    }),
  };
};
