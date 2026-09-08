import { createSign, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { bearerToken, decodeJws, verifiesUnder } from "./gate-fixtures.mjs";

/**
 * The readers the gate puts over what its canned GitHub recorded.
 *
 * ADR 0016 substitutes GitHub "only at the transport", which makes the App JWT
 * on the installation-token exchange a real signature over real bytes rather
 * than a fixture the gate hands itself. These three functions are what turn
 * that into something checkable, and each of them is a place where a wrong
 * answer would make the expensive check around it pass against a client that
 * signed nothing: a decoder that accepted anything, a verifier that trusted the
 * token's own `alg`, or a header reader that returned the whole header value.
 *
 * They are pure, so they are measured here rather than behind a build and a
 * boot.
 */

const KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = KEY.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const PUBLIC_PEM = KEY.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();

const OTHER_PUBLIC_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ format: "pem", type: "spki" })
  .toString();

/**
 * What one segment of a compact JWS encodes. The array arm is not decoration:
 * a JWS whose payload is a bare array is the case that would otherwise let
 * `payload.iss` read `undefined` and be reported as a wrong issuer.
 */
type SegmentValue = Readonly<Record<string, string>> | readonly never[];

const segment = (value: SegmentValue): string =>
  Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");

/**
 * A compact JWS over the given header and payload, signed the way
 * `appJwt` signs one.
 */
const signed = (header: SegmentValue, payload: SegmentValue): string => {
  const signingInput = `${segment(header)}.${segment(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(PRIVATE_PEM).toString("base64url")}`;
};

/** One recorded request, carrying whatever `Authorization` it carried. */
const request = (authorization?: string) => ({
  headers: authorization === undefined ? {} : { authorization },
  method: "GET",
  url: "/",
});

describe(decodeJws, () => {
  it("takes an RS256 assertion apart into its header, claims and signature", () => {
    const jws = signed({ alg: "RS256", typ: "JWT" }, { iss: "1234" });

    const decoded = decodeJws(jws);

    expect(decoded?.header).toStrictEqual({ alg: "RS256", typ: "JWT" });
    expect(decoded?.payload).toStrictEqual({ iss: "1234" });
    expect(decoded?.signingInput).toBe(jws.split(".").slice(0, 2).join("."));
    expect(decoded?.signature.length).toBeGreaterThan(0);
  });

  it("refuses anything that is not three segments", () => {
    expect(decodeJws("")).toBeNull();
    expect(decodeJws(`${segment({})}.${segment({})}`)).toBeNull();
    expect(decodeJws(`${segment({})}..sig`)).toBeNull();
  });

  it("refuses segments that are not JSON objects under the base64url", () => {
    expect(decodeJws("bm90LWpzb24.bm90LWpzb24.sig")).toBeNull();
    // Valid JSON, and not an object: a bare array would otherwise let
    // `payload.iss` read `undefined` and report a claim fault for a token that
    // is not a JWT at all.
    expect(decodeJws(`${segment([])}.${segment([])}.sig`)).toBeNull();
  });
});

describe(verifiesUnder, () => {
  it("accepts an assertion the key really signed", () => {
    expect(
      verifiesUnder(
        signed({ alg: "RS256", typ: "JWT" }, { iss: "1234" }),
        PUBLIC_PEM
      )
    ).toBeTruthy();
  });

  it("refuses an assertion signed by a different key", () => {
    expect(
      verifiesUnder(
        signed({ alg: "RS256", typ: "JWT" }, { iss: "1234" }),
        OTHER_PUBLIC_PEM
      )
    ).toBeFalsy();
  });

  it("refuses claims that were edited after signing", () => {
    const jws = signed({ alg: "RS256", typ: "JWT" }, { iss: "1234" });
    const [header, , signature] = jws.split(".");
    const tampered = `${header}.${segment({ iss: "9999" })}.${signature}`;

    expect(verifiesUnder(tampered, PUBLIC_PEM)).toBeFalsy();
  });

  it("refuses an unsigned assertion rather than taking alg from the token", () => {
    const unsigned = `${segment({ alg: "none", typ: "JWT" })}.${segment({ iss: "1234" })}.`;

    expect(verifiesUnder(unsigned, PUBLIC_PEM)).toBeFalsy();
  });
});

describe(bearerToken, () => {
  it("reads what follows the scheme, whatever case the scheme is in", () => {
    expect(bearerToken(request("Bearer ghs_a_token"))).toBe("ghs_a_token");
    expect(bearerToken(request("bearer ghs_a_token"))).toBe("ghs_a_token");
  });

  it("reads nothing from a request carrying no bearer credential", () => {
    expect(bearerToken()).toBeNull();
    expect(bearerToken(request())).toBeNull();
    expect(bearerToken(request("Basic abcdef"))).toBeNull();
    expect(bearerToken(request("ghs_a_token"))).toBeNull();
  });
});
