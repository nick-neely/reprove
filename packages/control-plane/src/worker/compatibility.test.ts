import { protocolVersion } from "@reprove/protocol/v1";
import { describe, expect, it } from "vitest";

import {
  checkProtocolVersion,
  WORKER_PROTOCOL_SUPPORT,
} from "./compatibility.js";

describe("the advertised compatibility window", () => {
  it("advertises a current and a minimum, which is what ADR 0006 fixes", () => {
    expect(WORKER_PROTOCOL_SUPPORT.current).toBe(protocolVersion);
    expect(WORKER_PROTOCOL_SUPPORT.minimum).toBeLessThanOrEqual(
      WORKER_PROTOCOL_SUPPORT.current
    );
  });

  it("serves every version inside the window", () => {
    for (
      let offered = WORKER_PROTOCOL_SUPPORT.minimum;
      offered <= WORKER_PROTOCOL_SUPPORT.current;
      offered += 1
    ) {
      expect(checkProtocolVersion(offered)).toStrictEqual({
        kind: "compatible",
      });
    }
  });

  it("names the minimum to a Worker below it, rather than refusing bare", () => {
    // ADR 0006: a Worker below `minimum` "receives a structured
    // `upgrade_required` naming the minimum, does not claim Runs, and surfaces
    // it in `reprove status` - it never silently degrades".
    expect(
      checkProtocolVersion(WORKER_PROTOCOL_SUPPORT.minimum - 1)
    ).toStrictEqual({
      kind: "incompatible",
      reason: "upgrade_required",
      minimum: WORKER_PROTOCOL_SUPPORT.minimum,
      current: WORKER_PROTOCOL_SUPPORT.current,
    });
  });

  it("refuses a version newer than anything it serves, by a different name", () => {
    // The two are not the same instruction. A Worker below the window has an
    // upgrade to install; a Worker above it is talking to a control plane that
    // has not been deployed yet, and telling it to upgrade would be false.
    expect(
      checkProtocolVersion(WORKER_PROTOCOL_SUPPORT.current + 1)
    ).toStrictEqual({
      kind: "incompatible",
      reason: "unsupported_protocol_version",
      minimum: WORKER_PROTOCOL_SUPPORT.minimum,
      current: WORKER_PROTOCOL_SUPPORT.current,
    });
  });
});
