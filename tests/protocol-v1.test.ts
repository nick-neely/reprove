import { readFileSync } from "node:fs";
import path from "node:path";

import { workerProtocolSchemas as controlPlaneSchemas } from "@reprove/control-plane";
import { protocolLimits, protocolSchemas } from "@reprove/protocol/v1";
import { workerProtocolSchemas as workerSchemas } from "@reprove/worker-core";
import { describe, expect, it } from "vitest";

const fixturesDirectory = path.join(
  import.meta.dirname,
  "fixtures",
  "protocol-v1"
);

const fixtureSource = (name: string): string =>
  readFileSync(path.join(fixturesDirectory, `${name}.json`), "utf-8");

const validRunSpec = protocolSchemas.runSpec.parse(
  JSON.parse(fixtureSource("run-spec"))
);
const validCompleteResult = protocolSchemas.result.parse(
  JSON.parse(fixtureSource("result-complete"))
);
const validPartialResult = protocolSchemas.result.parse(
  JSON.parse(fixtureSource("result-partial"))
);
const validRefusal = protocolSchemas.refusal.parse(
  JSON.parse(fixtureSource("refusal"))
);

describe("protocol v1 compatibility", () => {
  it.each([
    ["RunSpec", "runSpec", "run-spec"],
    ["complete Result", "result", "result-complete"],
    ["partial Result", "result", "result-partial"],
    ["Refusal", "refusal", "refusal"],
  ] as const)("accepts the golden %s fixture", (_name, schemaName, file) => {
    const source = fixtureSource(file);

    expect(protocolSchemas[schemaName].parse(JSON.parse(source))).toStrictEqual(
      JSON.parse(source)
    );
  });

  it("represents partiality without Failure data", () => {
    expect(validPartialResult.completeness).toBe("partial");
    expect(validPartialResult.stoppedBy).toBe("budget_exhausted");
    expect(validPartialResult).not.toHaveProperty("failure");
    expect(Object.keys(protocolSchemas)).toStrictEqual([
      "runSpec",
      "result",
      "refusal",
    ]);
  });

  it("ignores unknown additive fields from a newer compatible sender", () => {
    expect(
      protocolSchemas.runSpec.parse({
        ...validRunSpec,
        futureOptionalField: true,
      })
    ).toStrictEqual(validRunSpec);
  });

  it("requires stoppedBy exactly when a Result is partial", () => {
    expect(() =>
      protocolSchemas.result.parse({
        ...validPartialResult,
        stoppedBy: null,
      })
    ).toThrow("stoppedBy");
  });

  it("counts ignored additive fields toward the Result byte bound", () => {
    expect(() =>
      protocolSchemas.result.parse({
        ...validCompleteResult,
        futureOptionalField: "x".repeat(protocolLimits.resultBytes),
      })
    ).toThrow("Result exceeds");
  });
});

describe("the shared Worker boundary", () => {
  it("uses the protocol package's one schema definition on both sides", () => {
    expect(controlPlaneSchemas).toBe(protocolSchemas);
    expect(workerSchemas).toBe(protocolSchemas);
  });

  it.each([
    ["headSha", "runSpec", { ...validRunSpec, headSha: "not-a-sha" }],
    [
      "severity",
      "result",
      {
        ...validCompleteResult,
        findings: validCompleteResult.findings.map((finding) => ({
          ...finding,
          severity: "urgent",
        })),
      },
    ],
    ["reason", "refusal", { ...validRefusal, reason: "" }],
  ] as const)(
    "rejects an invalid %s field by name on both sides",
    (field, schemaName, payload) => {
      for (const schemas of [controlPlaneSchemas, workerSchemas]) {
        expect(() => schemas[schemaName].parse(payload)).toThrow(field);
      }
    }
  );
});
