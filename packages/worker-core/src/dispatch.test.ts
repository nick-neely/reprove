/**
 * The gates Worker core runs before it authorizes anything.
 *
 * Every one of them can only refuse. That is what "Worker core alone authorizes
 * execution" means in practice: an Adapter's capability and a Sandbox's
 * Attestation are inputs to a decision made here, and neither is a decision.
 */
import { describe, expect, it } from "vitest";

import {
  checkDispatch,
  PROBE_MAX_AGE_MS,
  permittedProvenance,
} from "./dispatch.js";
import type { DispatchInput } from "./dispatch.js";

const NOW = 1_780_000_000_000;

const sound: DispatchInput = {
  autonomy: "verify",
  provenance: "internal",
  allowExternalProvenance: false,
  exposure: "scoped",
  maximumExposure: "account",
  isolation: "container-rootless",
  capability: {
    supportedAutonomy: ["verify", "fix"],
    canEnforceRepoInstructionBoundary: true,
    reportsResolvedModel: false,
    probeFingerprint: "codex-0.150.0/brokered/adapter-1/suppression-1",
    probedAt: NOW - 1000,
  },
  now: NOW,
};

describe("the dispatch matrix", () => {
  it.each([
    // ADR 0004's table, stated whole. Exposure classifies the blast radius
    // going out and Provenance the risk coming in; Isolation is what stands
    // between them.
    {
      exposure: "none",
      isolation: "microvm",
      permitted: ["internal", "external"],
    },
    {
      exposure: "none",
      isolation: "container-rootless",
      permitted: ["internal", "external"],
    },
    { exposure: "none", isolation: "container", permitted: ["internal"] },
    { exposure: "scoped", isolation: "microvm", permitted: ["internal"] },
    {
      exposure: "scoped",
      isolation: "container-rootless",
      permitted: ["internal"],
    },
    { exposure: "scoped", isolation: "container", permitted: ["internal"] },
    { exposure: "account", isolation: "microvm", permitted: ["internal"] },
    {
      exposure: "account",
      isolation: "container-rootless",
      permitted: ["internal"],
    },
    { exposure: "account", isolation: "container", permitted: [] },
  ] as const)(
    "permits $permitted at $exposure exposure on $isolation",
    ({ exposure, isolation, permitted }) => {
      expect(permittedProvenance(exposure, isolation, false)).toStrictEqual(
        permitted
      );
    }
  );

  it("has exactly one opt-in, and it is the external cell on the scoped row", () => {
    // A matrix of opt-ins is a policy engine nobody can reason about at review
    // time. One named opt-in is auditable and its name can state the risk.
    expect(
      permittedProvenance("scoped", "container-rootless", true)
    ).toStrictEqual(["internal", "external"]);
    expect(permittedProvenance("scoped", "container", true)).toStrictEqual([
      "internal",
    ]);
    expect(
      permittedProvenance("account", "container-rootless", true)
    ).toStrictEqual(["internal"]);
    expect(permittedProvenance("none", "container", true)).toStrictEqual([
      "internal",
    ]);
  });

  it("refuses an account credential in a rootful container outright", () => {
    // Not offered behind a checkbox: this is the configuration both OpenAI and
    // Anthropic document as unsafe in their own devcontainer guidance.
    expect(
      checkDispatch({ ...sound, exposure: "account", isolation: "container" })
    ).toStrictEqual({
      reason: "isolation_insufficient",
      required: "container-rootless",
      actual: "container",
    });
  });

  it("names the isolation when a stronger one would have permitted the Run", () => {
    expect(
      checkDispatch({
        ...sound,
        exposure: "none",
        isolation: "container",
        provenance: "external",
      })
    ).toStrictEqual({
      reason: "isolation_insufficient",
      required: "container-rootless",
      actual: "container",
    });
  });

  it("names the Provenance when no isolation would have permitted the Run", () => {
    expect(
      checkDispatch({
        ...sound,
        exposure: "account",
        isolation: "container-rootless",
        provenance: "external",
      })
    ).toStrictEqual({
      reason: "provenance_ineligible",
      required: "internal",
      actual: "external",
    });
  });

  it("refuses an Exposure above the maximum the Repository allows", () => {
    // ADR 0011's durable form of "never let a password-equivalent account
    // credential run here". The Worker is the only place it can bind, because
    // the control plane that read the key never saw the resolved Exposure.
    expect(
      checkDispatch({
        ...sound,
        exposure: "account",
        maximumExposure: "scoped",
      })
    ).toStrictEqual({
      reason: "exposure_above_maximum",
      required: "no more than scoped",
      actual: "account",
    });
  });

  it("names the maximum before the matrix an operator cannot act on", () => {
    // A Repository that refused the credential has already answered this Run,
    // and naming ADR 0004's table instead would send an operator to rebuild a
    // host over a combination their own configuration never permitted.
    expect(
      checkDispatch({
        ...sound,
        exposure: "account",
        maximumExposure: "none",
        isolation: "container",
      })?.reason
    ).toBe("exposure_above_maximum");
  });

  it("permits an Exposure at or below the maximum", () => {
    expect(
      checkDispatch({ ...sound, exposure: "scoped", maximumExposure: "scoped" })
    ).toBeNull();
    expect(
      checkDispatch({ ...sound, exposure: "none", maximumExposure: "none" })
    ).toBeNull();
  });

  it("permits external Provenance on the one opt-in cell", () => {
    expect(
      checkDispatch({
        ...sound,
        provenance: "external",
        allowExternalProvenance: true,
      })
    ).toBeNull();
  });
});

describe("the capability gates", () => {
  it("passes a resolved capability that holds every gate", () => {
    expect(checkDispatch(sound)).toBeNull();
  });

  it("refuses a probe too stale to trust rather than assuming it", () => {
    // A stale probe is a refusal rather than an assumption. Dispatch requires
    // fresh evidence that the boundary works for the exact artifacts being
    // invoked, not merely recognition of a version string.
    const capability = {
      ...sound.capability,
      probedAt: NOW - PROBE_MAX_AGE_MS - 1,
    };

    expect(checkDispatch({ ...sound, capability })).toStrictEqual({
      reason: "capability_probe_stale",
      required: `probed within ${PROBE_MAX_AGE_MS}ms`,
      actual: `probed ${PROBE_MAX_AGE_MS + 1}ms ago`,
    });
  });

  it("refuses when the instruction boundary cannot be established", () => {
    // There is no degraded Run: ADR 0004 bans anything that warns and runs, and
    // ADR 0009 promotes this from an advisory field to a hard gate.
    const capability = {
      ...sound.capability,
      canEnforceRepoInstructionBoundary: false,
    };

    expect(checkDispatch({ ...sound, capability })).toStrictEqual({
      reason: "instruction_boundary_unenforceable",
      required: "an enforced repo-controlled instruction boundary",
      actual: "the resolved invocation cannot enforce one",
    });
  });

  it("refuses an Autonomy the resolved invocation cannot enforce", () => {
    // Codex throws on any permission mode other than allow-all, so there is no
    // mechanism by which `inspect` can mean "may read, may not execute" on it.
    // Offering it anyway would hand a user who chose `inspect` for safety an
    // unrestricted shell.
    expect(checkDispatch({ ...sound, autonomy: "inspect" })).toStrictEqual({
      reason: "autonomy_unsupported",
      required: "inspect",
      actual: "verify, fix",
    });
  });

  it("decides the capability gates before the dispatch matrix", () => {
    // A Run that fails two gates is refused by the one that names the thing an
    // operator can act on first, and a stale probe means every fact below it
    // was measured against artifacts nobody re-checked.
    const stale = {
      ...sound.capability,
      probedAt: NOW - PROBE_MAX_AGE_MS - 1,
      canEnforceRepoInstructionBoundary: false,
    };

    expect(
      checkDispatch({
        ...sound,
        capability: stale,
        exposure: "account",
        isolation: "container",
      })?.reason
    ).toBe("capability_probe_stale");
  });
});
