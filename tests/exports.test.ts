import { packageName as adapters } from "@reprove/adapters";
import { packageName as controlPlane } from "@reprove/control-plane";
import { packageName as controlPlaneWorkflow } from "@reprove/control-plane-workflow";
import { protocolVersion } from "@reprove/protocol/v1";
import { packageName as sandboxContainer } from "@reprove/sandbox-container";
import { packageName as worker } from "@reprove/worker";
import { packageName as workerCore } from "@reprove/worker-core";
import { packageName as workerHosted } from "@reprove/worker-hosted";
import { describe, expect, it } from "vitest";

/**
 * Every intended public entry point, imported the way an outside consumer would
 * import it. Vitest resolves these through each package's `exports` map into
 * built `dist`, which is why `turbo run build` precedes `vitest run` in the
 * verify seam. Nothing here asserts behaviour - it asserts the surface exists.
 */
describe("public entry points", () => {
  it("resolves every published package export", () => {
    expect({
      adapters,
      controlPlane,
      controlPlaneWorkflow,
      sandboxContainer,
      worker,
      workerCore,
      workerHosted,
    }).toStrictEqual({
      adapters: "@reprove/adapters",
      controlPlane: "@reprove/control-plane",
      controlPlaneWorkflow: "@reprove/control-plane-workflow",
      sandboxContainer: "@reprove/sandbox-container",
      worker: "@reprove/worker",
      workerCore: "@reprove/worker-core",
      workerHosted: "@reprove/worker-hosted",
    });
  });

  it("resolves the protocol's versioned subpath export", () => {
    expect(protocolVersion).toBe(1);
  });
});
