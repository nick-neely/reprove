/**
 * The execution token, which is a bearer capability with a mint and a stored
 * form, exactly like a Worker credential and for the same reasons.
 *
 * ```text
 * claim   -> mint, store sha256(token), return the token once
 * submit  -> hash what was presented, compare digests (#55)
 * ```
 *
 * The token is what authorizes one submission against one Run inside one
 * bounded liveness window, so **only the digest is stored**: a database read or
 * a backup that yielded the token would yield the capability with it, and there
 * is nothing the control plane needs the plaintext back for. It is handed to the
 * Worker in the claim grant and never again.
 *
 * Both halves live here rather than in `claim.ts` because the claim mints and
 * the submission verifies, and a pair split across those two paths is a pair
 * that can drift.
 */
import { createHash, randomBytes } from "node:crypto";

/** The bytes of entropy behind one execution token. */
const TOKEN_BYTES = 32;

/**
 * Mints one execution token: 32 bytes from a CSPRNG, which is the same entropy
 * a Worker credential carries and for the same reason - it is a bearer
 * capability, and the only defence a bearer capability has is being
 * unguessable.
 *
 * @returns The token to hand back in the grant. Never stored as it is.
 */
export const mintExecutionToken = (): string =>
  randomBytes(TOKEN_BYTES).toString("base64url");

/**
 * The stored form of an execution token, and the form a presented one is
 * reduced to before comparison.
 *
 * `sha256:<hex>` rather than a password KDF, on the same argument
 * `hashWorkerSecret` makes: the token is 32 CSPRNG bytes rather than something
 * a person chose, so no work factor defends a candidate space that does not
 * exist, and a deliberate per-request delay would land on the submission path.
 *
 * @param token The minted execution token.
 * @returns `sha256:` followed by the hex digest of the token.
 */
export const hashExecutionToken = (token: string): string =>
  `sha256:${createHash("sha256").update(token, "utf-8").digest("hex")}`;
