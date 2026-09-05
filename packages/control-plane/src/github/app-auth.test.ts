/**
 * The App JWT, measured by verifying it the way GitHub does.
 *
 * A signature this file only compared against a recorded string would pass
 * against any stable implementation, correct or not, so it generates a key
 * pair, signs with the private half and verifies with the public one - which
 * is the only arrangement that can tell a real RS256 assertion from a
 * well-formed encoding of the same bytes.
 */
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  APP_JWT_LIFETIME_SECONDS,
  appJwt,
  CLOCK_DRIFT_SECONDS,
} from "./app-auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const PKCS1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();

const ISSUED_AT = new Date("2026-02-01T12:00:00.000Z");
const SECONDS = Math.floor(ISSUED_AT.getTime() / 1000);

/** One JWS segment, back to the JSON text it encodes. */
const decode = (segment: string): string =>
  Buffer.from(segment, "base64url").toString("utf-8");

const parts = (token: string) => {
  const [header, payload, signature] = token.split(".");
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined
  ) {
    throw new Error(`not a three-part JWS: ${token}`);
  }
  return { header, payload, signature };
};

describe("the App JWT", () => {
  it("carries the RS256 header GitHub requires", () => {
    const { header } = parts(
      appJwt({ appId: "1234", privateKey: PEM }, ISSUED_AT)
    );

    expect(JSON.parse(decode(header))).toStrictEqual({
      alg: "RS256",
      typ: "JWT",
    });
  });

  it("issues from the App id, backdated against clock drift and short-lived", () => {
    const { payload } = parts(
      appJwt({ appId: "1234", privateKey: PEM }, ISSUED_AT)
    );

    expect(JSON.parse(decode(payload))).toStrictEqual({
      iat: SECONDS - CLOCK_DRIFT_SECONDS,
      exp: SECONDS - CLOCK_DRIFT_SECONDS + APP_JWT_LIFETIME_SECONDS,
      iss: "1234",
    });
  });

  it("stays inside GitHub's ten-minute ceiling", () => {
    expect(APP_JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(600);
  });

  it("verifies under the public half of the key that signed it", () => {
    const token = appJwt({ appId: "1234", privateKey: PEM }, ISSUED_AT);
    const { header, payload, signature } = parts(token);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signature, "base64url"))
    ).toBeTruthy();
  });

  it("does not verify under a different key", () => {
    const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = appJwt({ appId: "1234", privateKey: PEM }, ISSUED_AT);
    const { header, payload, signature } = parts(token);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(stranger.publicKey, Buffer.from(signature, "base64url"))
    ).toBeFalsy();
  });

  it("accepts the PKCS#1 PEM GitHub's download button actually hands out", () => {
    const token = appJwt({ appId: "1234", privateKey: PKCS1 }, ISSUED_AT);
    const { header, payload, signature } = parts(token);

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(
        createPublicKey(PKCS1),
        Buffer.from(signature, "base64url")
      )
    ).toBeTruthy();
  });

  it("names the field when the key is not a key", () => {
    expect(() =>
      appJwt({ appId: "1234", privateKey: "not a pem" }, ISSUED_AT)
    ).toThrow(/privateKey/u);
  });

  it("names the field when the App id is empty", () => {
    expect(() => appJwt({ appId: "", privateKey: PEM }, ISSUED_AT)).toThrow(
      /appId/u
    );
  });
});
