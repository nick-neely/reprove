/**
 * The pre-authentication transaction, and the restriction ADR 0008 calls
 * load-bearing: it verifies the credential and **does nothing else**.
 *
 * That is measured here rather than asserted, with a recording double in place
 * of the transaction. A stub that answered would prove the happy path; what
 * this needs to prove is the negative - one `select` and no second statement -
 * and only a double that records every call it received can state it.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { TenantTransaction } from "../db/runtime.js";
import {
  createWorkerAuthenticator,
  verifyWorkerCredential,
} from "./authenticate.js";
import { hashWorkerSecret, mintWorkerCredential } from "./credential.js";

const ACME = 1001;
const GLOBEX = 2002;
const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-02-01T12:00:00.000Z");

const dialect = new PgDialect();

/**
 * A transaction that records every statement it was asked for, answers `select`
 * with the shape the verification predicate builds, and throws for anything
 * else.
 */
const recording = (rows: readonly { workerId: string }[]) => {
  const calls: string[] = [];
  const bound: unknown[] = [];
  const selecting = () => ({
    from: () => ({
      where: (predicate: SQL) => {
        bound.push(...dialect.sqlToQuery(predicate).params);
        return { limit: () => Promise.resolve([...rows]) };
      },
    }),
  });
  // SAFETY: a measurement apparatus rather than an application path. Every
  // member goes through the handler below, so the empty target only gives the
  // proxy something to sit on and no call ever reaches it.
  const target = {} as TenantTransaction;
  const tx = new Proxy(target, {
    get: (_held, property) => {
      const name = String(property);
      calls.push(name);
      if (name === "select") {
        return selecting;
      }
      return () => {
        throw new Error(
          `the pre-authentication transaction called ${name}, and it may only verify the credential`
        );
      };
    },
  });
  return { bound, calls, tx };
};

describe("verifying a Worker credential", () => {
  it("issues exactly one select and nothing else", async () => {
    const { calls, tx } = recording([{ workerId: WORKER }]);

    await expect(
      verifyWorkerCredential(tx, ACME, "sha256:whatever", NOW)
    ).resolves.toStrictEqual({ workerId: WORKER });
    expect(calls).toStrictEqual(["select"]);
  });

  it("returns nothing when the tenant holds no matching row", async () => {
    const { calls, tx } = recording([]);

    await expect(
      verifyWorkerCredential(tx, ACME, "sha256:whatever", NOW)
    ).resolves.toBeNull();
    expect(calls).toStrictEqual(["select"]);
  });
});

describe("the authenticator", () => {
  const minted = mintWorkerCredential(ACME);

  /** A `withOwner` that records which tenant it opened, and what ran inside. */
  const withOwnerRecording = (rows: readonly { workerId: string }[]) => {
    const recorder = recording(rows);
    const tenants: number[] = [];
    const withOwner = <T>(
      ownerId: number,
      fn: (tx: TenantTransaction) => Promise<T>
    ): Promise<T> => {
      if (!(Number.isSafeInteger(ownerId) && ownerId > 0)) {
        // What `withOwner` really does with an id it cannot bind, which is why
        // a forged locator has to be refused before one is opened.
        return Promise.reject(new TypeError("not an Owner id"));
      }
      tenants.push(ownerId);
      return fn(recorder.tx);
    };
    return { recorder, tenants, withOwner };
  };

  it("sets tenant context from the locator before verifying anything", async () => {
    const { tenants, withOwner } = withOwnerRecording([{ workerId: WORKER }]);
    const authenticate = createWorkerAuthenticator({
      withOwner,
      now: () => NOW,
    });

    await expect(
      authenticate(`Bearer ${minted.credential}`)
    ).resolves.toStrictEqual({ ownerId: ACME, workerId: WORKER });
    expect(tenants).toStrictEqual([ACME]);
  });

  it("opens no transaction at all for a header that is not a credential", async () => {
    const { tenants, withOwner } = withOwnerRecording([{ workerId: WORKER }]);
    const authenticate = createWorkerAuthenticator({
      withOwner,
      now: () => NOW,
    });

    await expect(authenticate("Bearer nonsense")).resolves.toBeNull();
    await expect(authenticate(null)).resolves.toBeNull();
    expect(tenants).toStrictEqual([]);
  });

  it("opens the forged tenant, and finds nothing there", async () => {
    // ADR 0008's safety argument, exactly as stated: a forged locator "only
    // changes which tenant's credential lookup returns nothing". The
    // transaction opens on GLOBEX because that is what the credential said, and
    // GLOBEX holds no row for ACME's secret.
    const { tenants, withOwner } = withOwnerRecording([]);
    const authenticate = createWorkerAuthenticator({
      withOwner,
      now: () => NOW,
    });

    await expect(
      authenticate(`Bearer rpw1.${GLOBEX}.${minted.secret}`)
    ).resolves.toBeNull();
    expect(tenants).toStrictEqual([GLOBEX]);
  });

  it("looks the credential up by its hash, never by the secret", async () => {
    const { recorder, withOwner } = withOwnerRecording([]);
    const authenticate = createWorkerAuthenticator({
      withOwner,
      now: () => NOW,
    });

    await authenticate(`Bearer ${minted.credential}`);

    expect(recorder.bound).toContain(hashWorkerSecret(minted.secret));
    expect(recorder.bound).not.toContain(minted.secret);
  });

  it("scopes the lookup to the locator's Owner as well as to the tenant", async () => {
    // ADR 0008 rule 1 is application scoping **plus** RLS, "not either alone".
    const { recorder, withOwner } = withOwnerRecording([]);
    const authenticate = createWorkerAuthenticator({
      withOwner,
      now: () => NOW,
    });

    await authenticate(`Bearer ${minted.credential}`);

    expect(recorder.bound).toContain(ACME);
  });

  it("reads the clock once per attempt, so `now` is the caller's", async () => {
    const now = vi.fn<() => Date>(() => NOW);
    const { withOwner } = withOwnerRecording([]);
    const authenticate = createWorkerAuthenticator({ withOwner, now });

    await authenticate(`Bearer ${minted.credential}`);

    expect(now).toHaveBeenCalledOnce();
  });
});
