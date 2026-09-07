/**
 * The compatibility window, which is the whole of ADR 0006's versioning rule
 * that the control plane owns.
 *
 * ```text
 * offered < minimum   -> upgrade_required            naming the minimum
 * offered > current   -> unsupported_protocol_version
 * otherwise           -> compatible
 * ```
 *
 * The two refusals are deliberately different names for what is superficially
 * one condition. A Worker below the window has an upgrade to install and ADR
 * 0006 requires it to be told which one; a Worker **above** the window is
 * talking to a control plane that has not been deployed yet, and instructing it
 * to upgrade would be a false instruction. Collapsing them would make the one
 * actionable message unreliable.
 *
 * Nothing here decides anything about a Run. The check runs before the claim
 * transaction opens, because ADR 0006's rule is that an incompatible Worker
 * "does not claim Runs" - being handed a `RunSpec` it cannot read and refusing
 * it afterwards is not the same guarantee.
 */
import { protocolVersion } from "@reprove/protocol/v1";

/**
 * What this control plane serves, as ADR 0006's two advertised integers.
 *
 * They are equal because there is exactly one shipped family. A migration
 * lowers `minimum` for the length of the window and raises it afterwards, which
 * is a change to this constant and to nothing else.
 */
export const WORKER_PROTOCOL_SUPPORT = {
  current: protocolVersion,
  minimum: protocolVersion,
} as const;

/** Why an offered version is not served. */
export type ProtocolIncompatibility =
  /** Below `minimum`. The Worker has an upgrade to install. */
  | "upgrade_required"
  /** Above `current`. This control plane is the older half. */
  | "unsupported_protocol_version";

/** The answer, carrying the window either way so the reason is actionable. */
export type ProtocolCompatibility =
  | { readonly kind: "compatible" }
  | {
      readonly kind: "incompatible";
      readonly reason: ProtocolIncompatibility;
      readonly minimum: number;
      readonly current: number;
    };

/**
 * Whether a Worker's advertised protocol version is one this control plane
 * serves.
 *
 * @param offered The integer the Worker advertised, whatever it was.
 * @returns Compatibility, or the named reason and the window it fell outside.
 */
export const checkProtocolVersion = (
  offered: number
): ProtocolCompatibility => {
  const { current, minimum } = WORKER_PROTOCOL_SUPPORT;
  if (offered >= minimum && offered <= current) {
    return { kind: "compatible" };
  }
  return {
    kind: "incompatible",
    reason:
      offered < minimum ? "upgrade_required" : "unsupported_protocol_version",
    minimum,
    current,
  };
};
