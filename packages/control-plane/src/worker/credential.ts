/**
 * The Worker credential, and the Owner locator that makes ADR 0008's
 * pre-authentication transaction possible at all.
 *
 * [ADR 0008](../../../../docs/adr/0008-persistence-tenancy-and-retention.md)
 * enumerated every entry point that reaches the database before a tenant is
 * known, and the Worker paths were the two with no locator. So **every
 * Reprove-minted credential carries a non-secret Owner locator**:
 *
 * ```text
 * rpw1.<ownerId>.<secret>
 *
 * begin transaction
 *   -> set_config('app.owner_id', ownerLocator, true)
 *   -> verify the credential inside that tenant
 *   -> only after verification may normal work execute
 * ```
 *
 * The locator is **not** a claim of identity and is never trusted as one. It
 * selects which tenant's credential rows the verification predicate reads, and
 * a forged one therefore only changes which tenant's lookup returns nothing.
 * That is the whole safety argument, and it holds only because the locator is
 * checked for being a usable Owner id **here**, before any transaction opens:
 * `withOwner` throws a `TypeError` on an id it cannot bind, and a forged
 * locator has to reach a refusal rather than an unhandled throw.
 *
 * **The stored form is `sha256:<hex>` over the secret and nothing else, and not
 * a password KDF.** The secret is 32 bytes from a CSPRNG rather than something a
 * person chose, so there is no candidate space small enough for a work factor to
 * defend: an attacker holding the hash has nothing better than 2^256 guesses
 * whatever the iteration count. What a KDF would buy instead is a deliberate
 * per-request delay on the hot path of every poll, which is the one path in this
 * protocol a Worker calls repeatedly while idle. The locator is deliberately not
 * folded into the hash, because it arrives from the caller: a stored value
 * depending on an attacker-supplied field is the opposite of what the
 * pre-authentication transaction is for.
 *
 * There is no enrollment endpoint here. ADR 0016 asserts Enrollment absent from
 * Phase 0, so minting exists for the fixtures and the dashboard flow that will
 * own it, and the credential format is what #54 fixes.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * The credential's own scheme, which is the first segment rather than a header
 * parameter: a bearer token that says what it is cannot be mistaken for one of
 * a later shape, and a Worker presenting `rpw2` to a control plane that serves
 * `rpw1` is refused by the parser instead of failing a lookup.
 */
export const WORKER_CREDENTIAL_SCHEME = "rpw1";

/** The bytes of entropy behind one secret. */
const SECRET_BYTES = 32;

/** How the `Authorization` header carries it. */
const BEARER = "bearer";

/** The three segments of a credential, which is a fixed arity. */
const SEGMENTS = 3;

/** A credential, and the only two forms of it that ever exist. */
export interface MintedWorkerCredential {
  /** What the Worker persists and presents. Reprove never stores this. */
  readonly credential: string;
  /** The secret half alone, which is what the hash is taken over. */
  readonly secret: string;
  /** What `worker_credential.secret_hash` holds. */
  readonly secretHash: string;
}

/** What a presented credential names, before anything has verified it. */
export interface PresentedWorkerCredential {
  /** The Owner locator. A tenant selector, never an identity claim. */
  readonly ownerId: number;
  /** The secret half, unverified. */
  readonly secret: string;
}

/**
 * The stored form of a secret.
 *
 * The digest is compared by ordinary SQL equality in the lookup that verifies
 * it, and that is deliberate rather than a timing-safety oversight: what the
 * comparison sees is a SHA-256 digest of a 256-bit CSPRNG secret, so leaking how
 * many leading bytes of a *digest* matched tells an attacker nothing about the
 * preimage they would have to present. A timing-safe compare defends a secret
 * compared directly, which is the webhook signature's case and not this one.
 *
 * @param secret The secret half of a credential.
 * @returns `sha256:` followed by the hex digest of the secret alone.
 */
export const hashWorkerSecret = (secret: string): string =>
  `sha256:${createHash("sha256").update(secret, "utf-8").digest("hex")}`;

/**
 * Mints one credential for an Owner.
 *
 * @param ownerId GitHub's durable numeric Owner id, which is the tenant key.
 * @returns The credential to hand over, its secret, and what to store.
 */
export const mintWorkerCredential = (
  ownerId: number
): MintedWorkerCredential => {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    credential: `${WORKER_CREDENTIAL_SCHEME}.${ownerId}.${secret}`,
    secret,
    secretHash: hashWorkerSecret(secret),
  };
};

/**
 * Whether a locator is an Owner id a tenant transaction can be opened on.
 *
 * The same predicate `withOwner` enforces, applied one step earlier so that a
 * forged locator is a refusal rather than a thrown `TypeError` from inside the
 * database layer. The shape test in front of the coercion is what makes
 * `Number()` safe to reach for: on its own it reads `0x3e9`, `1e3`, whitespace
 * and the empty string as numbers, and none of those is a locator Reprove
 * minted.
 *
 * A leading zero is refused for the same reason, and it is the case that would
 * otherwise slip past: `01001` and `1001` coerce to one Owner id, so two
 * distinct credential strings would name one tenant. Nothing here mints such a
 * string, which is exactly why accepting one is only ever an attacker's
 * spelling.
 */
const locatorOwnerId = (locator: string): number | null => {
  if (!/^(?:0|[1-9]\d*)$/u.test(locator)) {
    return null;
  }
  const ownerId = Number(locator);
  return Number.isSafeInteger(ownerId) && ownerId > 0 ? ownerId : null;
};

/**
 * Reads what an `Authorization` header presents, verifying nothing.
 *
 * @param authorization The header value, or `null` where there was none.
 * @returns The Owner locator and the secret, or `null` for anything that is not
 *   a well-formed Reprove Worker credential.
 */
export const parseWorkerCredential = (
  authorization: string | null | undefined
): PresentedWorkerCredential | null => {
  if (!authorization) {
    return null;
  }

  const space = authorization.indexOf(" ");
  if (space === -1 || authorization.slice(0, space).toLowerCase() !== BEARER) {
    return null;
  }

  const segments = authorization
    .slice(space + 1)
    .trim()
    .split(".");
  if (segments.length !== SEGMENTS) {
    return null;
  }
  const [scheme, locator, secret] = segments;
  if (scheme !== WORKER_CREDENTIAL_SCHEME || !secret) {
    return null;
  }

  const ownerId = locatorOwnerId(locator ?? "");
  return ownerId === null ? null : { ownerId, secret };
};
