import { readFileSync } from "node:fs";
import path from "node:path";

import { workerProtocolSchemas as controlPlaneSchemas } from "@reprove/control-plane";
import {
  claimSchemas,
  protocolLimits,
  protocolSchemas,
  protocolVersion,
  submissionSchemas,
} from "@reprove/protocol/v1";
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
const validClaimRequest = claimSchemas.request.parse(
  JSON.parse(fixtureSource("claim-request"))
);
const validSubmission = submissionSchemas.request.parse(
  JSON.parse(fixtureSource("result-submission"))
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

describe("the claim exchange", () => {
  it.each([
    ["claim request", "request", "claim-request"],
    ["claim grant", "grant", "claim-grant"],
  ] as const)("accepts the golden %s fixture", (_name, schemaName, file) => {
    const source = fixtureSource(file);

    expect(claimSchemas[schemaName].parse(JSON.parse(source))).toStrictEqual(
      JSON.parse(source)
    );
  });

  it("carries the execution ownership the claim created, beside the RunSpec", () => {
    const grant = claimSchemas.grant.parse(
      JSON.parse(fixtureSource("claim-grant"))
    );

    expect(grant.runSpec).toStrictEqual(validRunSpec);
    expect(grant.executionToken).not.toBe("");
    expect(grant.executionExpiresAt).not.toBe("");
    expect(grant.runSpec).not.toHaveProperty("executionToken");
  });

  it("lets a Worker state a version this control plane does not serve", () => {
    // ADR 0006 requires an incompatible Worker to receive a structured
    // `upgrade_required` naming the minimum. A literal here would turn that
    // Worker's honest self-description into a malformed request instead.
    expect(
      claimSchemas.request.parse({ ...validClaimRequest, protocolVersion: 99 })
        .protocolVersion
    ).toBe(99);
    expect(() =>
      claimSchemas.request.parse({ ...validClaimRequest, protocolVersion: 0 })
    ).toThrow("protocolVersion");
  });

  it("pins the grant to this compatibility family", () => {
    expect(() =>
      claimSchemas.grant.parse({
        ...JSON.parse(fixtureSource("claim-grant")),
        protocolVersion: protocolVersion + 1,
      })
    ).toThrow("protocolVersion");
  });

  it("polls with no Run named, and claims one by name", () => {
    const { runId, ...poll } = validClaimRequest;

    expect(runId).toBe("run_01");
    expect(claimSchemas.request.parse(poll)).not.toHaveProperty("runId");
  });

  it("stays out of the frozen three, which are the Run's content", () => {
    expect(Object.keys(protocolSchemas)).not.toContain("claim");
    expect(Object.keys(claimSchemas)).toStrictEqual(["request", "grant"]);
  });
});

describe("the result submission", () => {
  it("accepts the golden fixture and carries the Result unchanged", () => {
    const source = JSON.parse(fixtureSource("result-submission"));

    expect(validSubmission).toStrictEqual(source);
    expect(protocolSchemas.result.parse(validSubmission.result)).toStrictEqual(
      validCompleteResult
    );
  });

  it("lets a Worker state a version this control plane does not serve", () => {
    // The same reason the claim request takes a plain integer: ADR 0006
    // requires a Worker outside the served window to receive a structured
    // `upgrade_required`, and the envelope is what the compatibility check
    // reads before the Result inside it is parsed at all.
    expect(
      submissionSchemas.request.parse({
        ...validSubmission,
        protocolVersion: 99,
      }).protocolVersion
    ).toBe(99);
    expect(() =>
      submissionSchemas.request.parse({
        ...validSubmission,
        protocolVersion: 0,
      })
    ).toThrow("protocolVersion");
  });

  it("leaves the Result unparsed, so the version check reaches it first", () => {
    // `resultSchema.protocolVersion` is a literal, so a nested parse would
    // report an incompatible Worker as malformed. The envelope therefore takes
    // the Result as opaque and the endpoint parses it after the window check.
    expect(
      submissionSchemas.request.parse({
        ...validSubmission,
        result: {
          ...validCompleteResult,
          protocolVersion: protocolVersion + 1,
        },
      }).result
    ).toHaveProperty("protocolVersion", protocolVersion + 1);
  });

  it("keeps the idempotency key optional, because it enforces nothing", () => {
    const { idempotencyKey, ...withoutKey } = validSubmission;

    expect(idempotencyKey).toBe("fixture-idempotency-key-0001");
    expect(submissionSchemas.request.parse(withoutKey)).not.toHaveProperty(
      "idempotencyKey"
    );
  });

  it("requires the execution ownership the claim handed back", () => {
    expect(() =>
      submissionSchemas.request.parse({
        ...validSubmission,
        executionToken: "",
      })
    ).toThrow("executionToken");
  });

  it("stays out of the frozen three, which are the Run's content", () => {
    expect(Object.keys(protocolSchemas)).not.toContain("submission");
    expect(Object.keys(submissionSchemas)).toStrictEqual(["request"]);
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
