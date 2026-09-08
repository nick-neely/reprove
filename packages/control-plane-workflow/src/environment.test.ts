import { PHASE_0_RUN_PROFILE } from "@reprove/control-plane";
import { describe, expect, it, vi } from "vitest";

import { configFromEnvironment, ENVIRONMENT } from "./environment.js";

/** The parse never reads the profile; it only has to arrive untouched. */
const PROFILE = PHASE_0_RUN_PROFILE;

/** A kick of the test's own, which only has to arrive untouched too. */
const kick = () => {};

const complete = {
  [ENVIRONMENT.databaseUrl]: "postgres://runtime@pooled/reprove",
  [ENVIRONMENT.webhookSecret]: "a-secret",
  [ENVIRONMENT.appId]: "1234",
  [ENVIRONMENT.privateKey]:
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
};

describe("the deployment's configuration, read from the environment", () => {
  it("passes every named variable through to the control plane's config", () => {
    const config = configFromEnvironment(complete, {
      runProfile: PROFILE,
      kick,
      onConnectionError: () => {},
    });

    expect(config.database.connectionString).toBe(
      "postgres://runtime@pooled/reprove"
    );
    expect(config.github).toMatchObject({
      webhookSecret: "a-secret",
      appId: "1234",
      privateKey: complete[ENVIRONMENT.privateKey],
      runProfile: PROFILE,
    });
    expect(config.kick).toBe(kick);
  });

  it("accepts a PEM whose newlines arrived escaped, and leaves a real one alone", () => {
    const escaped = configFromEnvironment(
      {
        ...complete,
        [ENVIRONMENT.privateKey]: String.raw`-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n`,
      },
      { runProfile: PROFILE }
    );

    expect(escaped.github.privateKey).toBe(complete[ENVIRONMENT.privateKey]);
    expect(
      configFromEnvironment(complete, { runProfile: PROFILE }).github.privateKey
    ).toBe(complete[ENVIRONMENT.privateKey]);
  });

  it("names a GitHub REST root only when the deployment set one", () => {
    expect(
      configFromEnvironment(complete, { runProfile: PROFILE }).github
    ).not.toHaveProperty("apiUrl");
    expect(
      configFromEnvironment(
        { ...complete, [ENVIRONMENT.githubApiUrl]: "" },
        { runProfile: PROFILE }
      ).github
    ).not.toHaveProperty("apiUrl");
    expect(
      configFromEnvironment(
        { ...complete, [ENVIRONMENT.githubApiUrl]: "http://127.0.0.1:4141" },
        { runProfile: PROFILE }
      ).github.apiUrl
    ).toBe("http://127.0.0.1:4141");
  });

  it("leaves an absent value empty for the control plane to refuse by name", () => {
    // Refusing here too would be a second spelling of `createControlPlane()`'s
    // rule, and the two would drift.
    const config = configFromEnvironment({}, { runProfile: PROFILE });

    expect(config.database.connectionString).toBe("");
    expect(config.github).toMatchObject({
      webhookSecret: "",
      appId: "",
      privateKey: "",
    });
    expect(config).not.toHaveProperty("kick");
  });

  it("leaves both Run windows at the injected profile's own durations", () => {
    const config = configFromEnvironment(complete, { runProfile: PROFILE });

    expect(config.github.runProfile).toStrictEqual(PROFILE);
  });

  it("shortens either window on its own, so a short claim window is never forced", () => {
    // The two are independent because a short `claimableFor` races the
    // scenario's own setup: Run creation takes the per-pull-request advisory
    // lock and fetches canonical state first, so a claim window measured in
    // seconds can close before anything gets to claim. The window under
    // observation is the liveness one.
    const config = configFromEnvironment(
      { ...complete, [ENVIRONMENT.livenessForMs]: "8000" },
      { runProfile: PROFILE }
    );

    expect(config.github.runProfile).toStrictEqual({
      ...PROFILE,
      livenessForMs: 8000,
    });
  });

  it("takes both durations when a deployment names both", () => {
    const config = configFromEnvironment(
      {
        ...complete,
        [ENVIRONMENT.claimableForMs]: "60000",
        [ENVIRONMENT.livenessForMs]: "8000",
      },
      { runProfile: PROFILE }
    );

    expect(config.github.runProfile).toMatchObject({
      claimableForMs: 60_000,
      livenessForMs: 8000,
    });
  });

  it("refuses a duration that is not a positive whole number of milliseconds", () => {
    // Refused here rather than left to `normalizeRunProfile`, which would name
    // a profile field: the profile is injected by name, so the only thing that
    // could have set this is the variable, and naming the field would send a
    // reader looking at code instead of at their deployment.
    for (const wrong of [
      "0",
      "-1",
      "abc",
      "1e3",
      "1.5",
      " 8000 ",
      "08000",
      // Past 2^53, where a deadline is one arithmetic can no longer move.
      "99999999999999999999",
    ]) {
      expect(() =>
        configFromEnvironment(
          { ...complete, [ENVIRONMENT.livenessForMs]: wrong },
          { runProfile: PROFILE }
        )
      ).toThrow(ENVIRONMENT.livenessForMs);
    }
  });

  it("treats an empty override as one nobody set", () => {
    // A deployment platform that writes every declared variable writes an empty
    // string for the ones with no value, and that must not be a refusal.
    const config = configFromEnvironment(
      {
        ...complete,
        [ENVIRONMENT.claimableForMs]: "",
        [ENVIRONMENT.livenessForMs]: "",
      },
      { runProfile: PROFILE }
    );

    expect(config.github.runProfile).toStrictEqual(PROFILE);
  });

  it("reports an idle connection failure to standard error by default", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      configFromEnvironment(complete, {
        runProfile: PROFILE,
      }).database.onConnectionError?.(new Error("connection reset"));

      expect(write).toHaveBeenCalledExactlyOnceWith(
        "reprove: idle database connection failed: connection reset\n"
      );
    } finally {
      write.mockRestore();
    }
  });
});
