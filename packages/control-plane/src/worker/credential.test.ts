import { describe, expect, it } from "vitest";

import {
  hashWorkerSecret,
  mintWorkerCredential,
  parseWorkerCredential,
  WORKER_CREDENTIAL_SCHEME,
} from "./credential.js";

const ACME = 1001;

describe("a Worker credential", () => {
  it("carries a non-secret Owner locator ahead of the secret", () => {
    const minted = mintWorkerCredential(ACME);

    const [scheme, locator, secret] = minted.credential.split(".");
    expect(scheme).toBe(WORKER_CREDENTIAL_SCHEME);
    expect(locator).toBe(String(ACME));
    expect(secret).toBe(minted.secret);
  });

  it("mints a distinct secret every time", () => {
    const secrets = new Set(
      Array.from({ length: 64 }, () => mintWorkerCredential(ACME).secret)
    );

    expect(secrets.size).toBe(64);
  });

  it("stores a hash of the secret and never the secret", () => {
    const minted = mintWorkerCredential(ACME);

    expect(minted.secretHash).toBe(hashWorkerSecret(minted.secret));
    expect(minted.secretHash).toMatch(/^sha256:[\da-f]{64}$/u);
    expect(minted.secretHash).not.toContain(minted.secret);
  });

  it("hashes the secret alone, so the locator is not part of the proof", () => {
    // The locator arrives from the caller and only selects a tenant. Folding it
    // into the hash would make the stored row depend on a value an attacker
    // supplies, which is the opposite of what the pre-authentication
    // transaction is for.
    const minted = mintWorkerCredential(ACME);

    expect(hashWorkerSecret(minted.secret)).toBe(minted.secretHash);
  });
});

describe("parsing an Authorization header", () => {
  const minted = mintWorkerCredential(ACME);
  const bearer = `Bearer ${minted.credential}`;

  it("reads the Owner locator and the secret out of a Bearer credential", () => {
    expect(parseWorkerCredential(bearer)).toStrictEqual({
      ownerId: ACME,
      secret: minted.secret,
    });
  });

  it("accepts the scheme however the client cased it", () => {
    expect(parseWorkerCredential(`bearer ${minted.credential}`)).toStrictEqual({
      ownerId: ACME,
      secret: minted.secret,
    });
  });

  it.each([
    ["absent", null],
    ["empty", ""],
    ["not Bearer", `Basic ${minted.credential}`],
    ["Bearer with nothing after it", "Bearer "],
    ["a foreign credential scheme", `Bearer rpw2.${ACME}.${minted.secret}`],
    ["two segments", `Bearer ${WORKER_CREDENTIAL_SCHEME}.${ACME}`],
    [
      "four segments",
      `Bearer ${WORKER_CREDENTIAL_SCHEME}.${ACME}.${minted.secret}.extra`,
    ],
    ["an empty secret", `Bearer ${WORKER_CREDENTIAL_SCHEME}.${ACME}.`],
  ])("returns nothing for a header that is %s", (_label, header) => {
    expect(parseWorkerCredential(header)).toBeNull();
  });

  it.each([
    ["not a number", "acme"],
    ["fractional", "1001.5"],
    ["zero", "0"],
    ["negative", "-1001"],
    ["past the safe integer range", "9007199254740993"],
    ["hexadecimal", "0x3e9"],
    ["carrying a leading zero", "01001"],
    ["empty", ""],
  ])("returns nothing rather than a locator that is %s", (_label, locator) => {
    // `withOwner` throws a TypeError on an Owner id it cannot use, and a
    // forged locator must reach a refusal instead: a 401 is what ADR 0008's
    // "a forged locator only changes which tenant's lookup returns nothing"
    // looks like from outside, and a 500 is not.
    expect(
      parseWorkerCredential(
        `Bearer ${WORKER_CREDENTIAL_SCHEME}.${locator}.${minted.secret}`
      )
    ).toBeNull();
  });

  it("reads a forged locator as the tenant it names, and nothing more", () => {
    const globex = 2002;

    expect(
      parseWorkerCredential(
        `Bearer ${WORKER_CREDENTIAL_SCHEME}.${globex}.${minted.secret}`
      )
    ).toStrictEqual({ ownerId: globex, secret: minted.secret });
  });
});
